import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import type { JobEngine } from './job-engine.js';
import { ChannelCore, DeliveryRejectedError, type ChannelEvent, type ChannelReply } from './channels.js';

const User = z.object({ id: z.number().int(), is_bot: z.boolean().default(false), username: z.string().optional() }).passthrough();
const Document = z.object({ file_id: z.string(), file_name: z.string().default('attachment'), mime_type: z.string().default('application/octet-stream'), file_size: z.number().int().nonnegative().optional() }).passthrough();
const Message = z.object({ message_id: z.number().int(), from: User.optional(), chat: z.object({ id: z.number().int(), type: z.string() }).passthrough(), text: z.string().optional(), caption: z.string().optional(), message_thread_id: z.number().int().optional(), reply_to_message: z.object({ message_id: z.number().int() }).passthrough().optional(), document: Document.optional() }).passthrough();
const Update = z.object({ update_id: z.number().int(), message: Message.optional() }).passthrough();
const Envelope = z.object({ ok: z.boolean(), result: z.unknown().optional(), error_code: z.number().int().optional(), description: z.string().optional(), parameters: z.object({ retry_after: z.number().int().positive().optional() }).passthrough().optional() }).passthrough();
type TelegramConfig = ArdentRuntime['config']['channels']['telegram'];

export class TelegramConflictError extends Error {}

function splitText(value: string): string[] {
  const parts: string[] = [];
  let rest = value || '(empty response)';
  while (rest.length) {
    if (rest.length <= 3900) { parts.push(rest); break; }
    let index = rest.lastIndexOf('\n', 3900);
    if (index < 2000) index = rest.lastIndexOf(' ', 3900);
    if (index < 2000) index = 3900;
    if (index > 0 && /[\uD800-\uDBFF]/.test(rest[index - 1] ?? '') && /[\uDC00-\uDFFF]/.test(rest[index] ?? '')) index--;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index).trimStart();
  }
  return parts;
}

export class TelegramAdapter {
  readonly #core: ChannelCore;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #commitQueue: Array<{ next: number; accepted: boolean; done: boolean }> = [];
  readonly #token: string;
  readonly #base: string;
  #bot?: z.infer<typeof User>;
  #consumerConflict = false;
  #nextOffset?: number;
  constructor(readonly runtime: ArdentRuntime, readonly config: TelegramConfig, env: NodeJS.ProcessEnv = process.env, baseUrl = 'https://api.telegram.org', jobs?: JobEngine) {
    const token = env[config.token_env];
    if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Telegram token is missing or malformed');
    if (config.allowed_user_ids.length === 0) throw new Error('Telegram requires at least one allowed user');
    this.#token = token;
    this.#base = baseUrl.replace(/\/$/, '');
    this.#core = new ChannelCore(runtime, env, jobs);
  }
  async #call(method: string, body: Record<string, unknown> | FormData, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${this.#base}/bot${this.#token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData ? {} : { headers: { 'Content-Type': 'application/json' } }),
        body: body instanceof FormData ? body : JSON.stringify(body),
        ...(signal ? { signal } : {}),
        redirect: 'error'
      });
      const parsed = Envelope.parse(await response.json());
      if (response.status === 409 || parsed.error_code === 409) {
        this.#consumerConflict = true;
        throw new TelegramConflictError(`Telegram consumer conflict: ${parsed.description ?? 'another poller or webhook owns the bot'}`);
      }
      if (response.status === 429 && parsed.parameters?.retry_after && attempt < 3) {
        // The abortable timer removes its listener, so a long-lived signal does not accumulate them.
        await sleep(Math.min(parsed.parameters?.retry_after ?? 1, 60) * 1000, undefined, signal ? { signal } : {})
          .catch(() => { throw new Error('Telegram retry aborted'); });
        continue;
      }
      if (!response.ok || !parsed.ok) {
        const message = `Telegram ${method} failed: ${parsed.description ?? response.status}`;
        if (response.status >= 400 && response.status < 500) throw new DeliveryRejectedError(message);
        throw new Error(message);
      }
      return parsed.result;
    }
    throw new Error(`Telegram ${method} retry limit reached`);
  }
  async initialize(signal?: AbortSignal): Promise<{ botId: number; username: string | null }> {
    const me = User.parse(await this.#call('getMe', {}, signal));
    if (!me.is_bot) throw new Error('Telegram token does not identify a bot');
    const webhook = z.object({ url: z.string() }).passthrough().parse(await this.#call('getWebhookInfo', {}, signal));
    if (webhook.url) throw new TelegramConflictError('Telegram webhook is configured; polling cannot start until explicit handover');
    this.#bot = me;
    return { botId: me.id, username: me.username ?? null };
  }
  /**
   * Send one notice to an allowlisted private chat (for plugins and jobs).
   * With `parseMode`, Telegram returns rendered text, so the receipt binds the
   * submitted digest and provider message ID instead of the echoed text.
   */
  async sendNotice(chatId: number, body: string, signal?: AbortSignal, parseMode?: 'MarkdownV2' | 'HTML'): Promise<{
    message_id: string; chat_id: number; chat_type: 'private'; body_sha256: string }> {
    if (this.runtime.store.admissionFence()) throw new Error('Profile admission is fenced for rollback');
    if (!Number.isSafeInteger(chatId) || chatId <= 0 || !this.config.allowed_user_ids.includes(chatId))
      throw new Error('Notice chat is outside the Telegram allowlist');
    if (!body.trim() || Buffer.byteLength(body, 'utf16le') / 2 > 3900)
      throw new Error('Notice exceeds one Telegram message');
    const message = Message.parse(await this.#call('sendMessage', { chat_id: chatId, text: body,
      ...(parseMode ? { parse_mode: parseMode } : {}), disable_web_page_preview: true }, signal));
    if (message.chat.id !== chatId || message.chat.type !== 'private' || message.message_id <= 0 ||
        (!parseMode && message.text !== body))
      throw new Error('Telegram notice receipt differs from bound recipient or submitted body');
    return { message_id: String(message.message_id), chat_id: chatId, chat_type: 'private',
      body_sha256: createHash('sha256').update(body).digest('hex') };
  }
  /** `signal` stops intake; `deliverySignal` aborts replies already admitted from this poll. */
  async pollOnce(signal?: AbortSignal, deliverySignal: AbortSignal | undefined = signal): Promise<number> {
    if (this.runtime.store.admissionFence()) throw new Error('Profile admission is fenced for rollback');
    if (this.#consumerConflict) throw new TelegramConflictError('Telegram polling is disabled after a consumer conflict');
    if (!this.#bot) await this.initialize(signal);
    const account = String(this.#bot?.id);
    const cursorKey = `telegram:${account}:offset`;
    this.#nextOffset ??= Number(this.runtime.store.cursor(cursorKey) ?? '0');
    const offset = this.#nextOffset;
    const raw = await this.#call('getUpdates', { offset, timeout: 25, limit: 50, allowed_updates: ['message'] }, signal);
    const updates = z.array(Update).max(50).parse(raw).filter(update => update.update_id >= offset).sort((a, b) => a.update_id - b.update_id);
    for (const update of updates) {
      const next = update.update_id + 1;
      const entry = { next, accepted: false, done: false };
      this.#commitQueue.push(entry);
      let readyResolve: () => void = () => {};
      let readyReject: (error: unknown) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => { readyResolve = () => { entry.accepted = true; resolve(); }; readyReject = reject; });
      const operation = this.#handleUpdate(update, readyResolve, deliverySignal).catch(error => {
        readyReject(error);
        this.runtime.store.setCursor(`telegram:${account}:last_error`, error instanceof Error ? error.message.slice(0, 500) : 'unknown');
      }).finally(() => {
        if (!entry.accepted) {
          const index = this.#commitQueue.indexOf(entry);
          if (index >= 0) this.#commitQueue.splice(index, 1);
          return;
        }
        entry.done = true;
        while (this.#commitQueue[0]?.done) {
          const completed = this.#commitQueue.shift();
          if (completed) this.runtime.store.setCursor(cursorKey, String(completed.next));
        }
      });
      this.#pending.add(operation);
      void operation.finally(() => this.#pending.delete(operation));
      await ready;
      this.#nextOffset = next;
    }
    return updates.length;
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.#pending]); }
  /**
   * Polls until `signal` aborts, then waits for admitted updates. Their replies
   * use `deliverySignal`, so a shutdown can stop intake before cutting delivery.
   */
  async run(signal: AbortSignal, deliverySignal: AbortSignal = signal): Promise<void> {
    await this.initialize(signal);
    let failures = 0;
    while (!signal.aborted) {
      try { await this.pollOnce(signal, deliverySignal); failures = 0; }
      catch (error: unknown) {
        if (signal.aborted) break;
        if (error instanceof TelegramConflictError) throw error;
        failures++;
        // Abort-aware so shutdown does not wait out the reconnect backoff.
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), undefined, { signal }).catch(() => {});
      }
    }
    await this.drain();
  }
  async #handleUpdate(update: z.infer<typeof Update>, ready: () => void, signal?: AbortSignal): Promise<void> {
    const message = update.message;
    if (!message?.from || message.from.is_bot || message.from.id === this.#bot?.id) { ready(); return; }
    if (!this.config.allowed_user_ids.includes(message.from.id)) { ready(); return; }
    if (message.chat.type !== 'private' && !this.config.allowed_chat_ids.includes(message.chat.id)) { ready(); return; }
    if (!['private', 'group', 'supergroup'].includes(message.chat.type)) { ready(); return; }
    const text = message.text ?? message.caption ?? '';
    if (message.chat.type !== 'private') {
      const username = this.#bot?.username;
      if (!username) { ready(); return; }
      if (!new RegExp(`(^|\\s)@${username}(?=\\s|$)`, 'i').test(text) && !new RegExp(`^/\\w+@${username}(?=\\s|$)`, 'i').test(text)) { ready(); return; }
    }
    const cleanText = this.#bot?.username ? text.replace(new RegExp(`(^|\\s)@${this.#bot.username}(?=\\s|$)`, 'gi'), '$1').replace(new RegExp(`^(/\\w+)@${this.#bot.username}(?=\\s|$)`, 'i'), '$1').trim() : text;
    const attachments: ChannelEvent['attachments'] = [];
    if (message.document) {
      const doc = message.document;
      const attachment: ChannelEvent['attachments'][number] = { name: doc.file_name.slice(0, 128), media_type: doc.mime_type.slice(0, 100), external_id: doc.file_id.slice(0, 256) };
      if ((doc.file_size ?? Number.POSITIVE_INFINITY) <= 2 * 1024 * 1024 && ['text/plain', 'text/markdown', 'application/json'].includes(doc.mime_type)) {
        const file = z.object({ file_path: z.string() }).passthrough().parse(await this.#call('getFile', { file_id: doc.file_id }, signal));
        if (/^[A-Za-z0-9_./-]{1,512}$/.test(file.file_path) && !file.file_path.split('/').includes('..')) {
          const response = await fetch(`${this.#base}/file/bot${this.#token}/${file.file_path}`, { ...(signal ? { signal } : {}), redirect: 'error' });
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length <= 2 * 1024 * 1024) attachment.bytes = bytes;
          }
        }
      }
      attachments.push(attachment);
    }
    const event: ChannelEvent = { platform: 'telegram',
      channel_type: message.chat.type === 'private' ? 'telegram_private'
        : message.chat.type === 'group' ? 'telegram_group' : 'telegram_supergroup',
      account: String(this.#bot?.id), user: String(message.from.id), conversation: String(message.chat.id), thread: message.message_thread_id === undefined ? null : String(message.message_thread_id), update_id: String(update.update_id), reply_to: String(message.message_id), text: cleanText, attachments, authorized: true, bot_message: false };
    const typingBody = { chat_id: message.chat.id, action: 'typing', ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }) };
    let typingInFlight: Promise<void> | null = null;
    const showTyping = (): Promise<void> => {
      if (!typingInFlight) {
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500);
        typingInFlight = this.#call('sendChatAction', typingBody, requestSignal).then(() => {}, () => {}).finally(() => { typingInFlight = null; });
      }
      return typingInFlight;
    };
    const initialTyping = showTyping();
    const typing = setInterval(() => { void showTyping(); }, 4000);
    try {
      const operation = this.#core.handle(event, async reply => { await initialTyping; return this.#deliver(message, reply, signal); });
      ready();
      await operation;
    } finally { clearInterval(typing); }
  }
  async #deliver(message: z.infer<typeof Message>, reply: ChannelReply, signal?: AbortSignal): Promise<string | null> {
    const common = { chat_id: message.chat.id, reply_parameters: { message_id: message.message_id }, ...(message.message_thread_id === undefined ? {} : { message_thread_id: message.message_thread_id }) };
    let last: string | null = null;
    try {
      for (const part of splitText(reply.text)) {
        const response = Message.parse(await this.#call('sendMessage', { ...common, text: part }, signal));
        last = String(response.message_id);
      }
      for (const [index, id] of reply.artifactIds.slice(0, 2).entries()) {
        const bytes = await this.runtime.artifacts.get(id);
        const form = new FormData();
        form.set('chat_id', String(message.chat.id));
        form.set('reply_parameters', JSON.stringify({ message_id: message.message_id }));
        if (message.message_thread_id !== undefined) form.set('message_thread_id', String(message.message_thread_id));
        form.set('document', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), index === 0 ? 'research-brief.json' : 'research-brief.md');
        const response = Message.parse(await this.#call('sendDocument', form, signal));
        last = String(response.message_id);
      }
    } catch (error: unknown) {
      if (last) throw new Error(`Telegram delivery may be partial: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw error;
    }
    return last;
  }
}
