import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import type { JobEngine } from './job-engine.js';
import { ChannelCore, DeliveryRejectedError, type ChannelEvent, type ChannelReply } from './channels.js';
import { resolveReference } from './config.js';
import { AttemptError, lastAttemptError, responseFailure, retryWithPolicy } from './retry.js';

const User = z.object({ id: z.string().min(1), username: z.string().min(1), is_bot: z.boolean().optional() }).passthrough();
const Post = z.object({ id: z.string().min(1), user_id: z.string().min(1), channel_id: z.string().min(1), message: z.string().default(''), root_id: z.string().nullish().transform(value => value ?? ''), file_ids: z.array(z.string()).default([]), create_at: z.number().int().nonnegative() }).passthrough();
const Frame = z.object({ event: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(), status: z.string().optional(), seq_reply: z.number().optional() }).passthrough();
const PostList = z.object({ order: z.array(z.string()), posts: z.record(z.string(), Post) }).passthrough();
const FileInfo = z.object({ id: z.string(), name: z.string(), mime_type: z.string(), size: z.number().int().nonnegative() }).passthrough();
type MattermostConfig = ArdentRuntime['config']['channels']['mattermost'];
type MattermostPost = z.infer<typeof Post>;
/** Durable catch-up boundary of one channel: the newest post up to which every older post was settled. */
const Boundary = z.object({ last_ms: z.number().int().nonnegative(), last_post_id: z.string().min(1).max(256).nullable() }).strict();
type Boundary = z.infer<typeof Boundary>;
/** Mattermost and ChatterMost return at most 200 posts per page. */
const CATCHUP_PAGE = 200;

function splitMessage(text: string): string[] {
  if (!text) return ['(empty response)'];
  const result: string[] = [];
  let rest = text;
  while (rest.length) {
    if (rest.length <= 15000) { result.push(rest); break; }
    let index = rest.lastIndexOf('\n', 15000);
    if (index < 5000) index = 15000;
    if (/[\uD800-\uDBFF]/.test(rest[index - 1] ?? '') && /[\uDC00-\uDFFF]/.test(rest[index] ?? '')) index--;
    result.push(rest.slice(0, index));
    rest = rest.slice(index).trimStart();
  }
  return result;
}
/** The longest message text a channel event carries; longer posts are cut, as the task prompt is. */
const MAX_EVENT_TEXT = 16_000;
/**
 * Matches `@username` as a whole mention. Trailing punctuation ("@bot:", "@bot.")
 * still mentions the bot, while a longer name ("@bot.helper", "@bot-two") does not.
 */
export function mentionPattern(username: string): RegExp {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.@-])@${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, 'i');
}

export class MattermostAdapter {
  readonly #core: ChannelCore;
  readonly #base: string;
  readonly #token: string;
  readonly #pending = new Set<Promise<unknown>>();
  #me?: z.infer<typeof User>;
  constructor(readonly runtime: ArdentRuntime, readonly config: MattermostConfig, env: NodeJS.ProcessEnv = process.env, jobs?: JobEngine) {
    const base = resolveReference(config.base_url, env);
    if (!base || !/^https?:\/\//.test(base)) throw new Error('Mattermost base URL is missing');
    const token = env[config.token_env];
    if (!token) throw new Error('Mattermost bot token is missing');
    if (config.allowed_user_ids.length === 0) throw new Error('Mattermost requires at least one allowed user');
    this.#base = base.replace(/\/$/, '');
    this.#token = token;
    this.#core = new ChannelCore(runtime, env, jobs);
  }
  /**
   * One REST call. A `429` is repeated under the `mattermost` retry policy: a
   * rate-limited request was not processed, so sending it again cannot post a
   * reply twice, and a catch-up burst of replies would otherwise lose every reply
   * past the server's limit. No other failure is repeated.
   */
  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.#token}`);
    try {
      return await retryWithPolicy('mattermost', async () => {
        const response = await fetch(`${this.#base}/api/v4${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000), redirect: 'error' });
        if (response.ok) return response;
        const message = `Mattermost ${path} returned ${response.status}`;
        await response.body?.cancel();
        if (response.status === 429) throw new AttemptError(message, responseFailure(response));
        if (response.status >= 400 && response.status < 500) throw new DeliveryRejectedError(message);
        throw new Error(message);
      }, { effect: 'idempotent', signal: init.signal ?? undefined });
    } catch (error: unknown) {
      const last = lastAttemptError(error);
      // A request still rate-limited after its retries was refused, as any other 4xx.
      throw last instanceof AttemptError ? new DeliveryRejectedError(last.message) : last;
    }
  }
  async initialize(): Promise<{ botId: string; username: string }> {
    const me = User.parse(await (await this.#request('/users/me')).json());
    if (me.is_bot === false) throw new Error('Mattermost token does not identify a bot');
    this.#me = me;
    this.runtime.store.catchup.closeOpenRuns('mattermost', me.id);
    return { botId: me.id, username: me.username };
  }
  async #attachment(fileId: string, signal?: AbortSignal): Promise<ChannelEvent['attachments'][number]> {
    const readSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const info = FileInfo.parse(await (await this.#request(`/files/${encodeURIComponent(fileId)}/info`, { signal: readSignal() })).json());
    const attachment: ChannelEvent['attachments'][number] = { name: info.name.slice(0, 128), media_type: info.mime_type.slice(0, 100), external_id: info.id.slice(0, 256) };
    if (info.size <= 2 * 1024 * 1024 && ['text/plain', 'text/markdown', 'application/json'].includes(info.mime_type)) {
      const bytes = new Uint8Array(await (await this.#request(`/files/${encodeURIComponent(fileId)}`, { signal: readSignal() })).arrayBuffer());
      if (bytes.length <= 2 * 1024 * 1024) attachment.bytes = bytes;
    }
    return attachment;
  }
  async handlePost(raw: unknown, channelType: string, signal?: AbortSignal, freshOnly = false): Promise<void> {
    if (signal?.aborted) return;
    if (this.runtime.store.admissionFence()) throw new Error('Profile admission is fenced for rollback');
    const post = Post.parse(raw);
    const me = this.#me;
    if (!me) throw new Error('Mattermost adapter has not initialized');
    if (!this.#eligible(post, channelType)) return;
    const isDm = channelType === 'D';
    const attachments: ChannelEvent['attachments'] = [];
    for (const fileId of post.file_ids.slice(0, 5)) {
      if (signal?.aborted) return;
      try { attachments.push(await this.#attachment(fileId, signal)); }
      catch { attachments.push({ name: 'unavailable-file', media_type: 'application/octet-stream', external_id: fileId.slice(0, 256) }); }
    }
    if (signal?.aborted) return;
    if (freshOnly && this.runtime.store.hasInbound('mattermost', me.id, post.id)) return;
    // A post may be longer than one channel event. Cut it here: a rejected event
    // would fail every later reconciliation that still lists the post.
    const text = (isDm ? post.message : post.message.replace(mentionPattern(me.username), '$1').trim()).slice(0, MAX_EVENT_TEXT);
    const event: ChannelEvent = { platform: 'mattermost', channel_type: isDm ? 'mattermost_dm' : 'mattermost_channel',
      account: me.id, user: post.user_id, conversation: post.channel_id, thread: post.root_id || null, update_id: post.id, reply_to: post.id, text, attachments, authorized: true, bot_message: false };
    const operation = this.#core.handle(event, async reply => this.#deliver(post, channelType, reply)).catch(error => {
      this.runtime.store.setCursor(`mattermost:${me.id}:last_error`, error instanceof Error ? error.message.slice(0, 500) : 'unknown');
    });
    // A live post never moves an existing boundary: posts missed before it are
    // still owed to catch-up. It only starts the boundary of a channel not yet seen.
    if (!this.#boundary(post.channel_id)) this.#saveBoundary(post.channel_id, { last_ms: post.create_at, last_post_id: null });
    this.#pending.add(operation);
    void operation.finally(() => this.#pending.delete(operation));
  }
  #eligible(post: MattermostPost, channelType: string): boolean {
    const me = this.#me;
    if (!me || post.user_id === me.id || !this.config.allowed_user_ids.includes(post.user_id)) return false;
    if (channelType === 'D') return true;
    return this.config.allowed_channel_ids.includes(post.channel_id) && (!this.config.require_mention || mentionPattern(me.username).test(post.message));
  }
  /**
   * The saved boundary of a channel, or undefined for a channel never seen. A
   * cursor from Ardent 3.1 (`…:last_ms` only) reads as a boundary without a post
   * id; a newer `…:last_ms` (written by an older runtime after a downgrade) wins.
   */
  #boundary(channelId: string): Boundary | undefined {
    const me = this.#me;
    if (!me) throw new Error('Mattermost adapter has not initialized');
    const legacyValue = this.runtime.store.cursor(`mattermost:${me.id}:${channelId}:last_ms`);
    const legacyMs = legacyValue === undefined ? undefined : Number(legacyValue);
    const legacy = legacyMs === undefined ? undefined : { last_ms: Number.isSafeInteger(legacyMs) && legacyMs >= 0 ? legacyMs : 0, last_post_id: null };
    const saved = this.runtime.store.cursor(`mattermost:${me.id}:${channelId}:last`);
    let parsed: Boundary | undefined;
    try { parsed = saved === undefined ? undefined : Boundary.parse(JSON.parse(saved) as unknown); } catch { parsed = undefined; }
    if (parsed && (!legacy || legacy.last_ms <= parsed.last_ms)) return parsed;
    if (legacy) return legacy;
    return saved === undefined ? undefined : { last_ms: 0, last_post_id: null };
  }
  #saveBoundary(channelId: string, boundary: Boundary): void {
    const me = this.#me;
    if (!me) throw new Error('Mattermost adapter has not initialized');
    this.runtime.store.setCursor(`mattermost:${me.id}:${channelId}:last`, JSON.stringify(Boundary.parse(boundary)));
    // Kept for a runtime rolled back to 3.1, which reads only this key.
    this.runtime.store.setCursor(`mattermost:${me.id}:${channelId}:last_ms`, String(boundary.last_ms));
  }
  async #page(channelId: string, before: string | undefined, readSignal: () => AbortSignal): Promise<MattermostPost[]> {
    const query = `per_page=${CATCHUP_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const listing = PostList.parse(await (await this.#request(`/channels/${encodeURIComponent(channelId)}/posts?${query}`, { signal: readSignal() })).json());
    // Newest first, as the server orders it; ties break on id so the walk is deterministic.
    return listing.order.map(id => listing.posts[id]).filter((item): item is MattermostPost => item !== undefined)
      .sort((a, b) => b.create_at - a.create_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }
  async #deliver(post: z.infer<typeof Post>, channelType: string, reply: ChannelReply): Promise<string | null> {
    const ids: string[] = [];
    let last: string | null = null;
    try {
      for (const [index, id] of reply.artifactIds.slice(0, 2).entries()) {
        const bytes = await this.runtime.artifacts.get(id);
        const form = new FormData();
        form.set('channel_id', post.channel_id);
        form.set('files', new Blob([new Uint8Array(bytes)], { type: 'text/plain' }), index === 0 ? 'research-brief.json' : 'research-brief.md');
        const uploaded = z.object({ file_infos: z.array(FileInfo).min(1) }).parse(await (await this.#request('/files', { method: 'POST', body: form })).json());
        const file = uploaded.file_infos[0];
        if (file) ids.push(file.id);
      }
      const parts = splitMessage(reply.text);
      for (const [index, part] of parts.entries()) {
        const rootId = post.root_id || (this.config.reply_mode === 'thread' && channelType !== 'D' ? post.id : '');
        const body = { channel_id: post.channel_id, message: part, ...(rootId ? { root_id: rootId } : {}), ...(index === parts.length - 1 && ids.length ? { file_ids: ids } : {}) };
        const sent = Post.parse(await (await this.#request('/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json());
        last = sent.id;
      }
    } catch (error: unknown) {
      if (last || ids.length) throw new Error(`Mattermost delivery may be partial: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw error;
    }
    return last;
  }
  /**
   * Catch up every readable channel. Runs when a connection opens (`freshOnly`
   * false: a claimed post without a recorded reply finishes its owner path) and
   * on the 30 s timer (`freshOnly`: claimed posts are left alone). Returns the
   * number of posts handed to the channel path.
   */
  async reconcile(freshOnly = false, signal?: AbortSignal): Promise<number> {
    if (freshOnly && this.runtime.store.admissionFence()) return 0;
    const me = this.#me;
    if (!me) throw new Error('Mattermost adapter has not initialized');
    const readSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const channels = z.array(z.object({ id: z.string(), type: z.string() }).passthrough()).parse(await (await this.#request('/users/me/channels', { signal: readSignal() })).json());
    let count = 0;
    for (const channel of channels) {
      if (signal?.aborted) break;
      if (channel.type !== 'D' && !this.config.allowed_channel_ids.includes(channel.id)) continue;
      count += await this.#catchUp(channel.id, channel.type, freshOnly, signal, readSignal);
    }
    return count;
  }
  /**
   * Walk one channel back from its newest post to the saved boundary in pages of
   * 200 (`before=<oldest id seen>`), bounded by `catchup.max_posts` posts from
   * others and twice that many pages' worth of history, then settle
   * the posts oldest first. Each post is claimed atomically, so live events and
   * catch-up can interleave without a second task or reply; a post already
   * claimed is never answered again. The boundary moves only past posts settled
   * in order, so an interrupted walk resumes where it stopped.
   */
  async #catchUp(channelId: string, channelType: string, freshOnly: boolean, signal: AbortSignal | undefined, readSignal: () => AbortSignal): Promise<number> {
    const me = this.#me!;
    const store = this.runtime.store;
    const boundary = this.#boundary(channelId);
    if (!boundary) {
      // First sight of a channel: claim its recent history without answering it.
      const posts = await this.#page(channelId, undefined, readSignal);
      if (signal?.aborted) return 0;
      for (const post of posts) store.claimInbound('mattermost', me.id, post.id);
      const newest = posts[0];
      // An empty channel starts at 0: every later post is new, whatever the clocks say.
      this.#saveBoundary(channelId, newest ? { last_ms: newest.create_at, last_post_id: newest.id } : { last_ms: 0, last_post_id: null });
      return 0;
    }
    // The bot's own replies sit in the same history; they do not use the budget,
    // so the page bound leaves room for one reply per post.
    const maxPosts = this.config.catchup.max_posts;
    const maxPages = 2 * Math.ceil(maxPosts / CATCHUP_PAGE);
    const newer: MattermostPost[] = [];
    let others = 0, pages = 0, reached = false, full = false, gap: 'walk_bound' | 'retention' | null = null, before: string | undefined;
    while (!reached && !gap) {
      const page = await this.#page(channelId, before, readSignal);
      pages++;
      if (signal?.aborted) return 0;
      for (const post of page) {
        if (post.id === boundary.last_post_id || post.create_at < boundary.last_ms) { reached = true; break; }
        if (post.user_id !== me.id && others++ >= maxPosts) { full = true; break; }
        newer.push(post);
      }
      if (reached) break;
      if (full) { gap = 'walk_bound'; break; }
      if (page.length === 0) {
        // The pivot post vanished, or retention removed history the boundary still needs.
        if (pages > 1 || boundary.last_post_id !== null) gap = 'retention';
        break;
      }
      if (page.length < CATCHUP_PAGE) {
        // The start of the channel's history. Without a boundary post id (a 3.1
        // cursor or an empty channel) that is the boundary; otherwise it was removed.
        if (boundary.last_post_id !== null) gap = 'retention';
        break;
      }
      if (pages >= maxPages) { gap = 'walk_bound'; break; }
      before = page.at(-1)?.id;
    }
    const posts = newer.reverse();
    const oldest = posts[0];
    if (gap) store.catchup.recordGap('mattermost', me.id, channelId, boundary.last_ms, oldest?.create_at ?? Date.now(), gap);
    const counters = { recovered: 0, skipped_stale: 0, already_claimed: 0, pages };
    const unsettled = posts.some(post => this.#eligible(post, channelType) && !store.hasInbound('mattermost', me.id, post.id));
    const runId = unsettled || gap ? store.catchup.startRun('mattermost', me.id, channelId, freshOnly ? 'timer' : 'connect', pages) : undefined;
    const staleBefore = Date.now() - this.config.catchup.max_age_hours * 3_600_000;
    const inboundType = channelType === 'D' ? 'mattermost_dm' : 'mattermost_channel';
    let settled: Boundary | undefined;
    // Never move the boundary backwards, for example behind a concurrent reconcile() call.
    const advance = (next: Boundary) => {
      const current = this.#boundary(channelId);
      if (!current || current.last_ms <= next.last_ms) this.#saveBoundary(channelId, next);
    };
    let index = 0;
    let count = 0;
    let failure: unknown;
    for (const post of posts) {
      if (signal?.aborted) break;
      try {
        if (!this.#eligible(post, channelType)) { /* not addressed to this bot */ }
        else if (store.hasInbound('mattermost', me.id, post.id)) {
          counters.already_claimed++;
          if (!freshOnly) { await this.handlePost(post, channelType, signal, false); count++; }
        } else if (post.create_at < staleBefore) {
          if (store.claimInbound('mattermost', me.id, post.id, inboundType, 'skipped_stale').claimed) counters.skipped_stale++;
          else counters.already_claimed++;
        } else { await this.handlePost(post, channelType, signal, freshOnly); count++; counters.recovered++; }
      } catch (error: unknown) { failure = error; break; }
      // A post cut short by shutdown may not be claimed yet; it stays owed.
      if (signal?.aborted) break;
      settled = { last_ms: post.create_at, last_post_id: post.id };
      if (++index % 50 === 0) {
        advance(settled);
        if (runId !== undefined) store.catchup.updateRun(runId, counters);
      }
    }
    const complete = !failure && !signal?.aborted;
    if (settled) advance(settled);
    // A recorded gap is permanent. With nothing settled past it, forget the lost
    // boundary post so the next walk does not report the same gap again.
    else if (gap && complete && boundary.last_post_id !== null) this.#saveBoundary(channelId, { last_ms: boundary.last_ms, last_post_id: null });
    if (runId !== undefined) store.catchup.finishRun(runId, counters, complete ? (gap ? 'gap' : 'complete') : 'interrupted', gap);
    if (failure) throw failure;
    return count;
  }
  async connectOnce(signal: AbortSignal): Promise<void> {
    if (!this.#me) await this.initialize();
    const url = new URL(this.#base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/v4/websocket';
    // Bound the opening handshake so a stalled server cannot hold shutdown.
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.#token}` }, handshakeTimeout: 10_000 });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token: this.#token } }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Mattermost WebSocket authentication timed out')); }, 10_000);
      const onMessage = (data: WebSocket.RawData) => {
        try {
          const frame = Frame.parse(JSON.parse(String(data)) as unknown);
          if (frame.status === 'FAIL' && frame.seq_reply === 1) throw new Error('Mattermost WebSocket authentication failed');
          if (frame.event === 'hello' || (frame.status === 'OK' && frame.seq_reply === 1)) { clearTimeout(timer); socket.off('message', onMessage); resolve(); }
        } catch (error: unknown) { clearTimeout(timer); socket.off('message', onMessage); reject(error); }
      };
      socket.on('message', onMessage);
      socket.once('close', () => { clearTimeout(timer); reject(new Error('Mattermost WebSocket closed before authentication')); });
    }).catch((error: unknown) => { socket.terminate(); throw error; }); // A refused socket must not stay open.
    const polling = new AbortController();
    socket.on('message', data => {
      try {
        const frame = Frame.parse(JSON.parse(String(data)) as unknown);
        if (frame.event !== 'posted' || !frame.data || typeof frame.data.post !== 'string') return;
        const post: unknown = JSON.parse(frame.data.post);
        const operation = this.handlePost(post, typeof frame.data.channel_type === 'string' ? frame.data.channel_type : '', polling.signal).catch(() => {});
        this.#pending.add(operation);
        void operation.finally(() => this.#pending.delete(operation));
      } catch { /* malformed event is ignored */ }
    });
    let connectionError: Error | undefined;
    const onAbort = () => { polling.abort(); socket.close(); };
    const closed = new Promise<void>(resolve => {
      socket.once('close', () => { polling.abort(); resolve(); });
      socket.once('error', error => { connectionError = error; polling.abort(); resolve(); });
    });
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setInterval> | undefined;
    let poll: Promise<void> | undefined;
    try {
      if (signal.aborted) onAbort();
      else await this.reconcile(false, polling.signal);
      if (!polling.signal.aborted) timer = setInterval(() => {
        if (poll || polling.signal.aborted || this.runtime.store.admissionFence()) return;
        poll = this.reconcile(true, polling.signal).then(() => {}, error => {
          if (!polling.signal.aborted) this.runtime.store.setCursor(`mattermost:${this.#me!.id}:last_error`,
            error instanceof Error ? error.message.slice(0, 500) : 'unknown');
        }).finally(() => { poll = undefined; });
      }, 30_000);
      await closed;
      if (connectionError) throw connectionError;
    } finally {
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', onAbort);
      polling.abort();
      socket.terminate();
      if (poll) await poll;
    }
    await Promise.allSettled([...this.#pending]);
  }
  async run(signal: AbortSignal): Promise<void> {
    await this.initialize();
    let failures = 0;
    while (!signal.aborted) {
      try { await this.connectOnce(signal); failures = 0; }
      catch (error: unknown) {
        if (signal.aborted) break;
        failures++;
        if (failures >= 10) throw error;
      }
      if (!signal.aborted) await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), undefined, { signal }).catch(() => {});
    }
  }
}
