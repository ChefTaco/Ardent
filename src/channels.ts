import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import type { Task } from './store.js';
import type { JobEngine } from './job-engine.js';

const Attachment = z.object({ name: z.string().max(128), media_type: z.string().max(100), bytes: z.instanceof(Uint8Array).refine(value => value.byteLength <= 2 * 1024 * 1024).optional(), external_id: z.string().max(256).optional() }).strict();
export const ChannelEvent = z.object({
  platform: z.enum(['telegram', 'mattermost']), account: z.string().min(1).max(128),
  channel_type: z.enum(['telegram_private', 'telegram_group', 'telegram_supergroup',
    'mattermost_dm', 'mattermost_channel']).optional(),
  user: z.string().min(1).max(128), conversation: z.string().min(1).max(128),
  thread: z.string().max(128).nullable(), update_id: z.string().min(1).max(256),
  reply_to: z.string().max(128).nullable(), text: z.string().max(16000),
  attachments: z.array(Attachment).max(5), authorized: z.literal(true), bot_message: z.boolean()
}).strict();
export type ChannelEvent = z.infer<typeof ChannelEvent>;
export type ChannelReply = { text: string; taskId: string | null; artifactIds: string[] };
export type ChannelDelivery = (reply: ChannelReply) => Promise<string | null>;
export class DeliveryRejectedError extends Error {}

function eventScope(event: ChannelEvent): { caller: string; key: string } {
  return { caller: `${event.platform}:${event.account}:${event.user}`, key: `${event.platform}:${event.account}:${event.conversation}:${event.thread ?? ''}` };
}

function sourceReply(runtime: ArdentRuntime, caller: string): string {
  for (const task of runtime.store.listByCaller(caller, 20)) {
    if (task.state !== 'completed') continue;
    const sources = new Map<string, string>();
    for (const event of runtime.store.events(task.id, 0, 500)) {
      if (event.kind !== 'tool_result') continue;
      const result = z.object({ result: z.object({ ok: z.literal(true), value: z.unknown().optional() }) }).safeParse(event.detail);
      if (!result.success) continue;
      const source = z.object({ source_id: z.string(), url: z.string().url().optional() }).passthrough();
      const value = z.object({ results: z.array(source).optional(), search: z.object({ results: z.array(source) }).passthrough().optional() }).passthrough().safeParse(result.data.result.value);
      if (!value.success) continue;
      for (const item of [...(value.data.results ?? []), ...(value.data.search?.results ?? [])]) if (!sources.has(item.source_id)) sources.set(item.source_id, item.url ?? 'URL unavailable');
    }
    if (sources.size) return `Source IDs for task ${task.id}:\n${[...sources].slice(0, 20).map(([id, url]) => `${id} ${url}`).join('\n')}`;
  }
  return 'No completed task with recorded source IDs in this conversation.';
}

export class ChannelCore {
  readonly #inflight = new Set<string>();
  constructor(readonly runtime: ArdentRuntime, readonly env: NodeJS.ProcessEnv = process.env, readonly jobs?: JobEngine) {}

  #replyFromTask(task: Task): ChannelReply {
    if (task.state !== 'completed' && task.state !== 'partial') return { text: `Task ${task.id} ${task.state}: ${task.error ?? 'Result unavailable'}`, taskId: task.id, artifactIds: [] };
    const artifact = this.runtime.store.events(task.id, 0, 500).find(item => item.kind === 'research_artifacts');
    const recorded = z.object({ report: z.object({ id: z.string() }), markdown: z.object({ id: z.string() }) }).safeParse(artifact?.detail);
    return { text: task.result ?? '', taskId: task.id, artifactIds: recorded.success ? [recorded.data.report.id, recorded.data.markdown.id] : [] };
  }

  async #send(event: ChannelEvent, reply: ChannelReply, deliver: ChannelDelivery, duplicate: boolean): Promise<{ duplicate: boolean; taskId: string | null; delivery: string | null }> {
    const deliveryId = this.runtime.store.queueDelivery(event.platform, event.account, event.update_id, reply.taskId);
    try {
      const externalId = await deliver(reply);
      this.runtime.store.setDelivery(deliveryId, 'sent', externalId);
      return { duplicate, taskId: reply.taskId, delivery: 'sent' };
    } catch (error: unknown) {
      const state = error instanceof DeliveryRejectedError ? 'failed' : 'unknown';
      this.runtime.store.setDelivery(deliveryId, state, null, error instanceof Error ? error.message : 'Delivery uncertain');
      return { duplicate, taskId: reply.taskId, delivery: state };
    }
  }

  handle(raw: unknown, deliver: ChannelDelivery): Promise<{ duplicate: boolean; taskId: string | null; delivery: string | null }> {
    if (this.runtime.store.admissionFence()) throw new Error('Profile admission is fenced for rollback');
    const event = ChannelEvent.parse(raw);
    if (event.bot_message) return Promise.resolve({ duplicate: false, taskId: null, delivery: null });
    const key = `${event.platform}:${event.account}:${event.update_id}`;
    if (this.#inflight.has(key)) return Promise.resolve({ duplicate: true, taskId: this.runtime.store.claimInbound(event.platform, event.account, event.update_id,
      event.channel_type ?? 'unknown').taskId, delivery: this.runtime.store.delivery(event.platform, event.account, event.update_id)?.state ?? null });
    // Telegram acknowledges its update cursor after handle() returns. Claim
    // inbound under the SQLite fence before returning any Promise to it.
    const claimed = this.runtime.store.claimInbound(event.platform, event.account, event.update_id,
      event.channel_type ?? 'unknown');
    this.#inflight.add(key);
    return this.#handleAuthenticated(event, deliver, claimed).finally(() => this.#inflight.delete(key));
  }

  async #handleAuthenticated(event: ChannelEvent, deliver: ChannelDelivery,
    claimed: { claimed: boolean; taskId: string | null }): Promise<{ duplicate: boolean; taskId: string | null; delivery: string | null }> {
    const scope = eventScope(event);
    if (!claimed.claimed) {
      const existingDelivery = this.runtime.store.delivery(event.platform, event.account, event.update_id);
      if (existingDelivery || !claimed.taskId) return { duplicate: true, taskId: claimed.taskId, delivery: existingDelivery?.state ?? null };
      let task = this.runtime.store.get(claimed.taskId);
      if (!task || task.state === 'running') return { duplicate: true, taskId: claimed.taskId, delivery: null };
      if (task.state === 'queued') {
        try { await this.runtime.run(task.id, this.env); }
        catch { /* The task state below is authoritative. */ }
        task = this.runtime.store.get(claimed.taskId);
      }
      if (!task) return { duplicate: true, taskId: claimed.taskId, delivery: null };
      return this.#send(event, this.#replyFromTask(task), deliver, true);
    }
    const session = this.runtime.store.session(scope.caller, 'direct', scope.key);
    const command = /^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/s.exec(event.text.trim());
    let reply: ChannelReply;
    if (command) {
      const name = command[1]?.toLowerCase();
      const arg = command[2]?.trim() ?? '';
      if (name === 'help' || name === 'commands') reply = { text: '/help /commands /new /reset /status /jobs /model [llamacpp|codex] /stop /tasks /sources', taskId: null, artifactIds: [] };
      else if (name === 'new' || name === 'reset') {
        const next = this.runtime.store.resetSession(scope.caller, 'direct', scope.key);
        reply = { text: `New conversation ${next.id}. Stored memory and credentials are unchanged.`, taskId: null, artifactIds: [] };
      } else if (name === 'status') reply = { text: `${this.runtime.config.name} is running. Session: ${session.id}. Backend: ${this.runtime.store.channelBackend(scope.caller, scope.key) ?? this.runtime.config.execution.backend}.`, taskId: null, artifactIds: [] };
      else if (name === 'model') {
        if (arg && arg !== 'llamacpp' && arg !== 'codex') reply = { text: 'Choose /model llamacpp or /model codex.', taskId: null, artifactIds: [] };
        else {
          if (arg === 'llamacpp' || arg === 'codex') this.runtime.store.setChannelBackend(scope.caller, scope.key, arg);
          reply = { text: `Backend for future tasks: ${this.runtime.store.channelBackend(scope.caller, scope.key) ?? this.runtime.config.execution.backend}.`, taskId: null, artifactIds: [] };
        }
      } else if (name === 'stop') {
        const latest = this.runtime.store.latestSessionTask(session.id, scope.caller);
        if (latest && ['queued', 'running'].includes(latest.state)) {
          this.runtime.cancel(latest.id);
          reply = { text: `Cancellation requested for task ${latest.id}.`, taskId: latest.id, artifactIds: [] };
        } else reply = { text: 'No active task in this conversation.', taskId: null, artifactIds: [] };
      } else if (name === 'tasks') {
        const recent = this.runtime.store.listByCaller(scope.caller, 5);
        reply = { text: recent.length ? recent.map(task => `${task.id} ${task.state}`).join('\n') : 'No tasks yet.', taskId: null, artifactIds: [] };
      } else if (name === 'jobs') {
        try {
          if (!this.jobs) reply = { text: 'No scheduled job definitions are installed for this profile.', taskId: null, artifactIds: [] };
          else {
            const status = await this.jobs.status(10);
            const lines = status.windows.map(window => `${window.job_id} ${window.local_key} ${window.state}`);
            reply = { text: [`Job definitions revision ${status.active_revision ?? 'none'}${status.last_validation_error ? ` (invalid: ${status.last_validation_error})` : ''}.`,
              ...(lines.length ? lines : ['No job windows recorded yet.'])].join('\n'), taskId: null, artifactIds: [] };
          }
        }
        catch (error: unknown) { reply = { text: error instanceof Error ? error.message : 'Schedule observation unavailable', taskId: null, artifactIds: [] }; }
      } else if (name === 'sources') reply = { text: sourceReply(this.runtime, scope.caller), taskId: null, artifactIds: [] };
      else reply = { text: 'Unknown command. Use /help.', taskId: null, artifactIds: [] };
    } else {
      const supported = event.attachments.filter(item => item.bytes && ['text/plain', 'text/markdown', 'application/json'].includes(item.media_type));
      const unsupported = event.attachments.filter(item => !supported.includes(item));
      const attachmentText = supported.map(item => `\n\nAttached ${item.name} (${item.media_type}):\n${new TextDecoder('utf-8').decode(item.bytes).slice(0, 8000)}`).join('');
      const metadata = unsupported.map(item => `${item.name} (${item.media_type}${item.external_id ? `, id ${item.external_id}` : ''})`).join(', ');
      const prompt = `${event.text}${attachmentText}${metadata ? `\n\nUnsupported attachments (metadata only): ${metadata}. Explain that their content was not read.` : ''}`.trim();
      if (!prompt) reply = { text: 'Send a message or use /help.', taskId: null, artifactIds: [] };
      else {
        const task = this.runtime.accept(prompt.slice(0, 16000), scope.caller, 'direct', `${event.platform}:${event.account}:${event.update_id}`.slice(0, 128), session.id, undefined, this.runtime.store.channelBackend(scope.caller, scope.key));
        this.runtime.store.bindInboundTask(event.platform, event.account, event.update_id, task.id);
        try {
          await this.runtime.run(task.id, this.env);
          reply = this.#replyFromTask(this.runtime.store.get(task.id) ?? task);
        } catch (error: unknown) {
          reply = { text: `Task ${task.id} ${this.runtime.store.get(task.id)?.state ?? 'failed'}: ${error instanceof Error ? error.message : 'Execution failed'}`, taskId: task.id, artifactIds: [] };
        }
      }
    }
    return this.#send(event, reply, deliver, false);
  }
}
