import { createHash } from 'node:crypto';
import { Message, TaskState, type SendMessageRequest, type StreamResponse, type Task } from '@a2a-js/sdk';
import { RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { DefaultRequestHandler, type ServerCallContext } from '@a2a-js/sdk/server';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { PeerTaskGate } from './a2a-rate-limit.js';
import type { SqliteA2ATaskStore } from './a2a-store.js';

const Receipt = z.object({ request_sha256: z.string(), task_id: z.string().nullable() });
const terminal = new Set([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED]);

/** Binds transport retries to the original task before invoking the executor. */
export class IdempotentA2AHandler extends DefaultRequestHandler {
  constructor(readonly db: Database.Database, readonly durableStore: SqliteA2ATaskStore, readonly taskGate: PeerTaskGate,
    ...args: ConstructorParameters<typeof DefaultRequestHandler>) {
    super(...args);
  }
  #scope(context: ServerCallContext): { tenant: string; caller: string } {
    if (!context.user?.isAuthenticated || !context.user.userName) throw new RequestMalformedError('Authenticated A2A caller required');
    return { tenant: context.tenant ?? '', caller: context.user.userName };
  }
  #claim(params: SendMessageRequest, context: ServerCallContext): { prior: boolean; tenant: string; caller: string; messageId: string } {
    const { tenant, caller } = this.#scope(context);
    const message = params.message;
    const messageId = message?.messageId;
    if (!messageId || messageId.length > 128) throw new RequestMalformedError('A bounded message.messageId is required');
    if (!message) throw new RequestMalformedError('message is required');
    const digest = createHash('sha256').update(JSON.stringify({ message: Message.toJSON(message), configuration: params.configuration, metadata: params.metadata })).digest('hex');
    return this.db.transaction(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO a2a_request_receipts(tenant,caller,message_id,request_sha256,task_id,created_ms) VALUES (?,?,?,?,NULL,?)')
        .run(tenant, caller, messageId, digest, Date.now());
      const row = Receipt.parse(this.db.prepare('SELECT request_sha256,task_id FROM a2a_request_receipts WHERE tenant=? AND caller=? AND message_id=?').get(tenant, caller, messageId));
      if (row.request_sha256 !== digest) throw new RequestMalformedError('messageId reused with different A2A request content');
      return { prior: inserted.changes === 0, tenant, caller, messageId };
    })();
  }
  /**
   * Runs before #claim: a refusal must not leave a receipt, or the peer's retry
   * of this message would wait on an admission that never happened. Retries of
   * known messages and team control messages start no new work and take no slot.
   */
  #admit(params: SendMessageRequest, context: ServerCallContext): { caller: string; messageId: string } | null {
    const { tenant, caller } = this.#scope(context);
    const messageId = params.message?.messageId;
    if (!messageId || 'hermesTeamControl' in (params.message?.metadata ?? {}) || this.taskGate.holds(caller, messageId)
      || this.db.prepare('SELECT 1 FROM a2a_request_receipts WHERE tenant=? AND caller=? AND message_id=?').get(tenant, caller, messageId)) return null;
    if (!this.taskGate.acquire(caller, messageId)) throw new UnsupportedOperationError('Peer task limit reached; retry after a running task finishes');
    return { caller, messageId };
  }
  #release(slot: { caller: string; messageId: string } | null): void {
    if (slot) this.taskGate.release(slot.caller, slot.messageId);
  }
  #bind(receipt: { tenant: string; caller: string; messageId: string }, taskId: string): void {
    this.db.prepare('UPDATE a2a_request_receipts SET task_id=? WHERE tenant=? AND caller=? AND message_id=? AND (task_id IS NULL OR task_id=?)')
      .run(taskId, receipt.tenant, receipt.caller, receipt.messageId, taskId);
  }
  async #original(receipt: { tenant: string; caller: string; messageId: string }, context: ServerCallContext): Promise<Task> {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      const row = Receipt.parse(this.db.prepare('SELECT request_sha256,task_id FROM a2a_request_receipts WHERE tenant=? AND caller=? AND message_id=?')
        .get(receipt.tenant, receipt.caller, receipt.messageId));
      if (row.task_id) {
        const task = await this.durableStore.load(row.task_id, context);
        if (task) return task;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new UnsupportedOperationError('Original A2A admission outcome is unresolved; inspect the receipt before retrying');
  }
  override async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task | Message> {
    if ('hermesTeamReport' in (params.message?.metadata ?? {}))
      throw new RequestMalformedError('Report intake is not supported by this profile');
    const slot = this.#admit(params, context);
    try {
      const receipt = this.#claim(params, context);
      if (receipt.prior) { this.#release(slot); return await this.#original(receipt, context); }
      const result = await super.sendMessage(params, context);
      if ('id' in result) this.#bind(receipt, result.id);
      return result;
    } catch (error: unknown) { this.#release(slot); throw error; }
  }
  override async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    if ('hermesTeamReport' in (params.message?.metadata ?? {}))
      throw new UnsupportedOperationError('Report intake requires a terminal SendMessage receipt');
    const slot = this.#admit(params, context);
    let receipt: { prior: boolean; tenant: string; caller: string; messageId: string };
    try { receipt = this.#claim(params, context); }
    catch (error: unknown) { this.#release(slot); throw error; }
    if (receipt.prior) {
      this.#release(slot);
      const task = await this.#original(receipt, context);
      yield { payload: { $case: 'task', value: task } };
      if (task.status && !terminal.has(task.status.state)) yield* this.resubscribe({ tenant: context.tenant ?? '', id: task.id }, context);
      return;
    }
    try {
      for await (const event of super.sendMessageStream(params, context)) {
        if (event.payload?.$case === 'task') this.#bind(receipt, event.payload.value.id);
        yield event;
      }
    } catch (error: unknown) { this.#release(slot); throw error; }
  }
}
