import { followSse, SseStatusError } from '@hivemagnus/hive-common/sse';
import { anySignal, isRecord, type Connection } from './transport.js';
import { ArdentClientError, NotFoundError, TransportError } from './errors.js';
import type { TaskEvent, TaskText } from './types.js';

export interface FollowOptions {
  /** Resume after this event sequence (the `sequence` of the last event you handled). */
  readonly after?: number;
  /** Every journaled event, in order, exactly once across reconnects. */
  readonly onEvent?: (event: TaskEvent) => void | Promise<void>;
  /**
   * Live reply text. It is not journaled: after a reconnect a `text` snapshot of the current
   * step replaces what `delta`s built up.
   */
  readonly onText?: (text: TaskText) => void | Promise<void>;
  /** Called on every (re)connection with the cursor it resumes from. */
  readonly onConnect?: (cursor: number | undefined, reconnect: number) => void;
  readonly signal?: AbortSignal;
}

const PERMANENT = (status: number) => status !== 408 && status !== 429 && status < 500;

function parse(data: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(data); }
  catch (error: unknown) { throw new TransportError('invalid_response', 'The task stream sent an event that is not JSON', { status: 502, cause: error }); }
  if (!isRecord(value)) throw new TransportError('invalid_response', 'The task stream sent an event that is not a JSON object', { status: 502 });
  return value;
}
function isTaskEvent(value: Record<string, unknown>): value is Record<string, unknown> & TaskEvent {
  return typeof value['sequence'] === 'number' && typeof value['task_id'] === 'string' && typeof value['kind'] === 'string' && typeof value['created_ms'] === 'number';
}

/**
 * Follow a task's event stream until `task.done`. Ardent closes a stream after 60 seconds
 * and a network may drop it; both reconnect from the last event sequence (`after` and
 * `Last-Event-ID`), so no journaled event is lost or repeated. Resolves with the task's state
 * in `task.done`.
 */
export async function followTask(connection: Connection, id: string, options: FollowOptions): Promise<{ id: string; state: string }> {
  const signal = anySignal(connection.signal, options.signal);
  let cursor = options.after !== undefined ? String(options.after) : undefined;
  let refresh = false;
  let refreshed = false;
  for (;;) {
    let refusal: ArdentClientError | undefined;
    try {
      const result = await followSse(connection.url(`tasks/${encodeURIComponent(id)}/stream`), {
        headers: async () => { const headers = await connection.headers(refresh); refresh = false; return headers; },
        ...(cursor !== undefined ? { after: cursor } : {}),
        cursorParam: 'after',
        ...(signal ? { signal } : {}),
        policy: connection.retryPolicy,
        // A permanent refusal keeps its mapped error (the SSE helper only reports the status).
        fetch: async (url, init) => {
          const response = await connection.fetcher(url, { ...init, redirect: 'error' });
          if (response.ok || !PERMANENT(response.status)) return response;
          refusal = await connection.error(response);
          return new Response(null, { status: response.status });
        },
        ...(options.onConnect ? { onConnect: (from: string | undefined, reconnect: number) => options.onConnect?.(from === undefined ? undefined : Number(from), reconnect) } : {}),
        onEvent: async event => {
          if (event.id !== undefined) cursor = event.id;
          if (event.event === 'task.event') {
            const value = parse(event.data);
            if (!isTaskEvent(value)) throw new TransportError('invalid_response', 'The task stream sent a malformed event', { status: 502 });
            await options.onEvent?.(value);
          } else if (event.event === 'task.text' || event.event === 'task.delta') {
            const value = parse(event.data);
            if (typeof value['step'] !== 'number' || typeof value['text'] !== 'string') throw new TransportError('invalid_response', 'The task stream sent malformed text', { status: 502 });
            await options.onText?.({ kind: event.event === 'task.text' ? 'text' : 'delta', step: value['step'], text: value['text'] });
          }
        },
        isTerminal: event => event.event === 'task.done',
      });
      const done = result.terminal ? parse(result.terminal.data) : undefined;
      if (!done || typeof done['state'] !== 'string') throw new TransportError('invalid_response', 'The task stream ended without a final state', { status: 502 });
      if (done['state'] === 'missing') throw new NotFoundError('NOT_FOUND', 'Task not found', { status: 404 });
      return { id, state: done['state'] };
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      if (error instanceof SseStatusError) {
        if (error.status === 401 && !refreshed) { refreshed = true; refresh = true; continue; }
        throw refusal ?? new ArdentClientError('stream_refused', error.message, { status: error.status });
      }
      if (error instanceof ArdentClientError) throw error;
      throw new TransportError('stream_failed', `The task stream could not be resumed: ${error instanceof Error ? error.message : String(error)}`, { status: 503, cause: error });
    }
  }
}
