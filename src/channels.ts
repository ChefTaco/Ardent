import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import type { Task } from './store.js';
import type { JobEngine } from './job-engine.js';
import { frozenCopy, pluginContext, pluginTransformOutbound, runPluginObservers, type ArdentChannelDelivery, type ArdentChannelMessage,
  type ArdentPluginContext, type PluginHookFailureSink } from './plugins.js';

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
/** Where a reply to an inbound update goes; recorded with the inbound claim so recovered tasks can still answer. */
export const ReplyTarget = ChannelEvent.pick({ platform: true, account: true, channel_type: true, user: true, conversation: true, thread: true, update_id: true, reply_to: true }).strict();
export type ReplyTarget = z.infer<typeof ReplyTarget>;
const RecoveredInbound = z.object({ update_id: z.string(), task_id: z.string(), reply_target_json: z.string() });
export type ChannelReply = { text: string; taskId: string | null; artifactIds: string[] };
export type ChannelDelivery = (reply: ChannelReply) => Promise<string | null>;
export class DeliveryRejectedError extends Error {}

const SourceResult = z.object({ result: z.object({ ok: z.literal(true), value: z.unknown().optional() }) });
const Source = z.object({ source_id: z.string(), url: z.string().url().optional() }).passthrough();
const SourceValue = z.object({ results: z.array(Source).optional(), search: z.object({ results: z.array(Source) }).passthrough().optional() }).passthrough();

function eventScope(event: ChannelEvent): { caller: string; key: string } {
  return { caller: `${event.platform}:${event.account}:${event.user}`, key: `${event.platform}:${event.account}:${event.conversation}:${event.thread ?? ''}` };
}

function sourceReply(runtime: ArdentRuntime, caller: string): string {
  for (const task of runtime.store.listByCaller(caller, 20)) {
    if (task.state !== 'completed') continue;
    const sources = new Map<string, string>();
    for (const event of runtime.store.events(task.id, 0, 500)) {
      if (event.kind !== 'tool_result') continue;
      const result = SourceResult.safeParse(event.detail);
      if (!result.success) continue;
      const value = SourceValue.safeParse(result.data.result.value);
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

  #pluginContext(): ArdentPluginContext { return pluginContext(this.runtime, this.env); }

  #hookFailure(event: ChannelEvent, taskId: string | null): PluginHookFailureSink {
    return (plugin, hook) => {
      this.runtime.logger.warn('Plugin hook failed', { plugin, hook, platform: event.platform, ...(taskId ? { task_id: taskId } : { update_id: event.update_id }) });
      this.runtime.store.recordPluginHookFailure(plugin, hook, taskId ? { taskId } : { platform: event.platform, account: event.account, updateId: event.update_id });
    };
  }

  async #send(event: ChannelEvent, reply: ChannelReply, deliver: ChannelDelivery, duplicate: boolean): Promise<{ duplicate: boolean; taskId: string | null; delivery: string | null }> {
    const plugins = this.runtime.plugins;
    // Record before send, once per update: an update that already has a delivery is never sent again.
    const claim = this.runtime.store.claimDelivery(event.platform, event.account, event.update_id, reply.taskId);
    if (!claim.created) return { duplicate: true, taskId: reply.taskId, delivery: this.runtime.store.delivery(event.platform, event.account, event.update_id)?.state ?? null };
    const deliveryId = claim.id;
    const failure = this.#hookFailure(event, reply.taskId);
    let view: ArdentChannelDelivery = { delivery_id: deliveryId, task_id: reply.taskId, platform: event.platform, account: event.account,
      update_id: event.update_id, text: reply.text, attempt: 1 };
    if (plugins.some(plugin => plugin.transformOutbound)) {
      // Transformations chain in registration order and fail closed to the original text.
      const transformed = await pluginTransformOutbound(plugins, this.#pluginContext(), view, failure);
      if (transformed.plugins.length) {
        if (reply.taskId) this.runtime.store.append(reply.taskId, 'outbound_transformed', { delivery_id: deliveryId, plugins: transformed.plugins, text: transformed.text });
        reply = { ...reply, text: transformed.text };
        view = { ...view, text: transformed.text };
      }
    }
    let outcome: { state: 'sent' | 'failed' | 'unknown'; external_id: string | null };
    try {
      const externalId = await deliver(reply);
      this.runtime.store.setDelivery(deliveryId, 'sent', externalId);
      outcome = { state: 'sent', external_id: externalId };
    } catch (error: unknown) {
      const state = error instanceof DeliveryRejectedError ? 'failed' : 'unknown';
      this.runtime.store.setDelivery(deliveryId, state, null, error instanceof Error ? error.message : 'Delivery uncertain');
      outcome = { state, external_id: null };
    }
    const delivered = frozenCopy(view);
    const context = this.#pluginContext();
    await runPluginObservers(plugins, 'messageDelivered', plugin => plugin.messageDelivered?.(context, delivered, frozenCopy(outcome)), failure);
    return { duplicate, taskId: reply.taskId, delivery: outcome.state };
  }

  /** The task whose outcome answers an update: the bound task, or the last continuation an operator decision created for it. */
  #answeringTask(taskId: string): Task | undefined {
    let task = this.runtime.store.get(taskId);
    for (let hops = 0; task && hops < 16; hops++) {
      const next = this.runtime.store.executionState.recovery(task.id)?.continuation_task_id;
      if (!next) break;
      task = this.runtime.store.get(next) ?? task;
      if (task.id !== next) break;
    }
    return task;
  }
  /** Whether a task's outcome is final for the channel: a held task awaiting a decision (or running a continuation) is not. */
  #answerReady(task: Task): boolean {
    if (['completed', 'partial', 'failed', 'cancelled'].includes(task.state)) return true;
    if (task.state !== 'unknown') return false;
    const recovery = this.runtime.store.executionState.recovery(task.id);
    return !recovery || recovery.status === 'unsupported' || (recovery.status === 'resolved' && !recovery.continuation_task_id);
  }
  /**
   * Answer the updates whose task execution recovery resumed, settled or
   * continued after a restart, once each. A recovered task has no in-process
   * handler waiting for it, so this waits for it (or for its continuation) and
   * then sends through the same record-before-send path: an update that
   * already has a delivery is never sent again. Call at adapter start and
   * whenever `runtime.onTaskSettled` fires. Returns the replies sent.
   */
  async deliverRecovered(platform: string, account: string, deliverFor: (target: ReplyTarget) => ChannelDelivery): Promise<number> {
    const rows = z.array(RecoveredInbound).parse(this.runtime.store.db.prepare(`SELECT i.update_id, i.task_id, i.reply_target_json FROM channel_inbound i
      WHERE i.platform=? AND i.account=? AND i.task_id IS NOT NULL AND i.reply_target_json IS NOT NULL AND i.disposition='admitted'
        AND NOT EXISTS (SELECT 1 FROM channel_deliveries d WHERE d.platform=i.platform AND d.account=i.account AND d.update_id=i.update_id)
        AND EXISTS (SELECT 1 FROM task_recovery r WHERE r.task_id=i.task_id)
      ORDER BY i.created_ms LIMIT 100`).all(platform, account));
    let sent = 0;
    await Promise.all(rows.map(async row => {
      const key = `${platform}:${account}:${row.update_id}`;
      if (this.#inflight.has(key)) return;
      const target = ReplyTarget.safeParse(JSON.parse(row.reply_target_json) as unknown);
      if (!target.success) return;
      this.#inflight.add(key);
      try {
        let task = this.#answeringTask(row.task_id);
        // Join the resumed run or the continuation; a task with no run here is answered when one settles.
        if (task && ['queued', 'running'].includes(task.state)) {
          try { await this.runtime.run(task.id, this.env); } catch { /* the stored state below is authoritative */ }
          task = this.#answeringTask(row.task_id);
        }
        if (!task || !this.#answerReady(task)) return;
        const event: ChannelEvent = { ...target.data, text: '', attachments: [], authorized: true, bot_message: false };
        const outcome = await this.#send(event, this.#replyFromTask(task), deliverFor(target.data), true);
        if (outcome.delivery === 'sent') sent++;
      } finally { this.#inflight.delete(key); }
    }));
    return sent;
  }
  /**
   * Keep answering recovered updates until `signal` aborts: once now, then
   * after every task this runtime settles. Resolves when stopped and idle.
   */
  watchRecovered(platform: string, account: string, deliverFor: (target: ReplyTarget) => ChannelDelivery, signal: AbortSignal): Promise<void> {
    let running: Promise<void> | undefined;
    let again = false;
    const pass = (): void => {
      if (signal.aborted) return;
      if (running) { again = true; return; }
      running = this.deliverRecovered(platform, account, deliverFor).then(() => undefined, error => {
        try { this.runtime.store.setCursor(`${platform}:${account}:recovered_delivery_error`, error instanceof Error ? error.message.slice(0, 500) : 'unknown'); }
        catch { /* the journal is closing; a later pass retries */ }
      }).finally(() => { running = undefined; if (again) { again = false; pass(); } });
    };
    const unsubscribe = this.runtime.onTaskSettled(() => pass());
    pass();
    return new Promise<void>(resolve => {
      const stop = () => { unsubscribe(); void (running ?? Promise.resolve()).finally(resolve); };
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
    });
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
      event.channel_type ?? 'unknown', 'admitted', ReplyTarget.parse({ platform: event.platform, account: event.account,
        ...(event.channel_type ? { channel_type: event.channel_type } : {}), user: event.user, conversation: event.conversation, thread: event.thread,
        update_id: event.update_id, reply_to: event.reply_to }));
    this.#inflight.add(key);
    return this.#handleAuthenticated(event, deliver, claimed).finally(() => this.#inflight.delete(key));
  }

  async #handleAuthenticated(event: ChannelEvent, deliver: ChannelDelivery,
    claimed: { claimed: boolean; taskId: string | null }): Promise<{ duplicate: boolean; taskId: string | null; delivery: string | null }> {
    const scope = eventScope(event);
    const plugins = this.runtime.plugins;
    const message: ArdentChannelMessage = frozenCopy({ platform: event.platform, account: event.account, update_id: event.update_id,
      channel_type: event.channel_type ?? 'unknown', caller: scope.caller, session_key: scope.key, received_ms: Date.now() });
    if (claimed.claimed) {
      const context = this.#pluginContext();
      await runPluginObservers(plugins, 'messageReceived', plugin => plugin.messageReceived?.(context, message), this.#hookFailure(event, null));
    }
    if (!claimed.claimed) {
      const existingDelivery = this.runtime.store.delivery(event.platform, event.account, event.update_id);
      if (existingDelivery || !claimed.taskId) return { duplicate: true, taskId: claimed.taskId, delivery: existingDelivery?.state ?? null };
      let task = this.runtime.store.get(claimed.taskId);
      if (!task || task.state === 'running') return { duplicate: true, taskId: claimed.taskId, delivery: null };
      // A task execution recovery touched is answered by deliverRecovered, which waits for its continuation.
      if (this.runtime.store.executionState.recovery(task.id)) return { duplicate: true, taskId: claimed.taskId, delivery: null };
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
        const context = this.#pluginContext();
        const persisted = frozenCopy(task);
        await runPluginObservers(plugins, 'messagePersisted', plugin => plugin.messagePersisted?.(context, message, persisted), this.#hookFailure(event, task.id));
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
