import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import type { JobEngine } from './job-engine.js';
import { ChannelCore, DeliveryRejectedError, type ChannelEvent, type ChannelReply } from './channels.js';
import { resolveReference } from './config.js';

const User = z.object({ id: z.string().min(1), username: z.string().min(1), is_bot: z.boolean().optional() }).passthrough();
const Post = z.object({ id: z.string().min(1), user_id: z.string().min(1), channel_id: z.string().min(1), message: z.string().default(''), root_id: z.string().nullish().transform(value => value ?? ''), file_ids: z.array(z.string()).default([]), create_at: z.number().int().nonnegative() }).passthrough();
const Frame = z.object({ event: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(), status: z.string().optional(), seq_reply: z.number().optional() }).passthrough();
const PostList = z.object({ order: z.array(z.string()), posts: z.record(z.string(), Post) }).passthrough();
const FileInfo = z.object({ id: z.string(), name: z.string(), mime_type: z.string(), size: z.number().int().nonnegative() }).passthrough();
type MattermostConfig = ArdentRuntime['config']['channels']['mattermost'];

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
function mentionPattern(username: string): RegExp {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@${escaped}(?=\\s|$|[.,!?])`, 'i');
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
  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.#token}`);
    const response = await fetch(`${this.#base}/api/v4${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) {
      const message = `Mattermost ${path} returned ${response.status}`;
      if (response.status >= 400 && response.status < 500) throw new DeliveryRejectedError(message);
      throw new Error(message);
    }
    return response;
  }
  async initialize(): Promise<{ botId: string; username: string }> {
    const me = User.parse(await (await this.#request('/users/me')).json());
    if (me.is_bot === false) throw new Error('Mattermost token does not identify a bot');
    this.#me = me;
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
    if (post.user_id === me.id || !this.config.allowed_user_ids.includes(post.user_id)) return;
    const isDm = channelType === 'D';
    if (!isDm && !this.config.allowed_channel_ids.includes(post.channel_id)) return;
    if (!isDm && this.config.require_mention && !mentionPattern(me.username).test(post.message)) return;
    const attachments: ChannelEvent['attachments'] = [];
    for (const fileId of post.file_ids.slice(0, 5)) {
      if (signal?.aborted) return;
      try { attachments.push(await this.#attachment(fileId, signal)); }
      catch { attachments.push({ name: 'unavailable-file', media_type: 'application/octet-stream', external_id: fileId.slice(0, 256) }); }
    }
    if (signal?.aborted) return;
    if (freshOnly && this.runtime.store.hasInbound('mattermost', me.id, post.id)) return;
    const cursorKey = `mattermost:${me.id}:${post.channel_id}:last_ms`;
    const previous = Number(this.runtime.store.cursor(cursorKey) ?? '0');
    const text = isDm ? post.message : post.message.replace(mentionPattern(me.username), '$1').trim();
    const event: ChannelEvent = { platform: 'mattermost', channel_type: isDm ? 'mattermost_dm' : 'mattermost_channel',
      account: me.id, user: post.user_id, conversation: post.channel_id, thread: post.root_id || null, update_id: post.id, reply_to: post.id, text, attachments, authorized: true, bot_message: false };
    const operation = this.#core.handle(event, async reply => this.#deliver(post, channelType, reply)).catch(error => {
      this.runtime.store.setCursor(`mattermost:${me.id}:last_error`, error instanceof Error ? error.message.slice(0, 500) : 'unknown');
    });
    this.runtime.store.setCursor(cursorKey, String(Math.max(previous, post.create_at)));
    this.#pending.add(operation);
    void operation.finally(() => this.#pending.delete(operation));
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
      const listing = PostList.parse(await (await this.#request(`/channels/${encodeURIComponent(channel.id)}/posts?per_page=50`, { signal: readSignal() })).json());
      if (signal?.aborted) break;
      const posts = listing.order.map(id => listing.posts[id]).filter((item): item is z.infer<typeof Post> => item !== undefined).sort((a, b) => a.create_at - b.create_at);
      const cursorKey = `mattermost:${me.id}:${channel.id}:last_ms`;
      const saved = this.runtime.store.cursor(cursorKey);
      if (saved === undefined) {
        for (const post of posts) this.runtime.store.claimInbound('mattermost', me.id, post.id);
        this.runtime.store.setCursor(cursorKey, String(posts.at(-1)?.create_at ?? Date.now()));
        continue;
      }
      if (posts.length === 50 && (posts[0]?.create_at ?? 0) > Number(saved)) this.runtime.store.setCursor(`mattermost:${me.id}:${channel.id}:reconcile_gap`, `${saved}:${posts[0]?.create_at ?? 0}`);
      for (const post of posts) {
        if (signal?.aborted) break;
        // Periodic reads recover missed events only. Already claimed work,
        // including unbound or unknown effects, keeps its existing owner path.
        if (freshOnly && this.runtime.store.hasInbound('mattermost', me.id, post.id)) continue;
        await this.handlePost(post, channel.type, signal, freshOnly); count++;
      }
    }
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
    });
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
