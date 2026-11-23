/**
 * Ardent's retry policy model, built on the shared HiveCommon retry helpers.
 *
 * Every retry site names one policy below. A failed attempt is repeated only when the failure
 * is transient (a transport error, or 408/425/429/5xx), no response byte was consumed, the
 * caller states the operation has no effect or is idempotent by contract, the peer did not say
 * it already retried (`x-hive-retry: exhausted`), the next attempt starts before the deadline,
 * and the caller has not cancelled. Codex turns and tools with a possible external effect are
 * never retried: their policy is `never`, and an unknown effect is refused before any wait.
 */
import {
  backoffDelay, classifyRetry, readRetrySignal, retryAfterFromHeaders, RetryExhaustedError, sleepAbortable,
  type RetryPolicy, type RetrySignal,
} from '@hivemagnus/hive-common/retry';

export { RETRY_HEADER } from '@hivemagnus/hive-common/retry';

/** Named policies. Delays are before jitter; `equal` jitter waits a random time in [d/2, d]. */
export const RETRY_POLICIES = {
  /** llama.cpp `complete` and `countInputTokens`: before any response byte is consumed. */
  llamacpp: { maxAttempts: 3, baseMs: 250, maxMs: 4000, jitter: 'equal', maxRetryAfterMs: 10_000 },
  /** A2A reads: Agent Card, Hermes team card, `getTask`, `listTasks`, extended card. */
  a2a_read: { maxAttempts: 3, baseMs: 500, maxMs: 5000, jitter: 'equal', maxRetryAfterMs: 10_000 },
  /** A2A `SendMessage`, repeated only with the same `messageId` (the peer deduplicates on it). */
  a2a_send: { maxAttempts: 3, baseMs: 500, maxMs: 5000, jitter: 'equal', maxRetryAfterMs: 10_000 },
  /** A2A push delivery: the site clamps `Retry-After` to 1–5 s, the existing bound. */
  a2a_push: { maxAttempts: 3, baseMs: 1000, maxMs: 1000, jitter: 'none', maxRetryAfterMs: 5000 },
  /** Telegram Bot API: 429 with `retry_after`, which the site caps at 60 s, the existing bound. */
  telegram: { maxAttempts: 4, baseMs: 1000, maxMs: 1000, jitter: 'none', maxRetryAfterMs: 60_000 },
  /** Codex turns, tools with a possible effect, partially consumed streams. */
  never: { maxAttempts: 1, baseMs: 0, maxMs: 0, jitter: 'none' },
} as const satisfies Record<string, RetryPolicy>;
export type RetryPolicyName = keyof typeof RETRY_POLICIES;

/** What a site knows about one failed attempt. */
export type AttemptFailure = {
  /** The HTTP status, when a response arrived. */
  status?: number | undefined;
  /** The request failed before any response (connection refused, reset, DNS). */
  network?: boolean | undefined;
  /** Response bytes already consumed or forwarded. Any consumed byte ends retrying. */
  bytesConsumed?: number | undefined;
  /** A wait the peer asked for, in milliseconds. */
  retryAfterMs?: number | undefined;
  /** The peer's `x-hive-retry` signal. `exhausted` ends retrying: the lower layer already retried. */
  signal?: RetrySignal | undefined;
};

/** Thrown by an attempt to describe its failure to `retryWithPolicy`. */
export class AttemptError extends Error {
  constructor(message: string, readonly failure: AttemptFailure, options?: ErrorOptions) { super(message, options); }
}

export type RetryStopCode = 'RETRY_EXHAUSTED' | 'RETRY_DEADLINE' | 'RETRY_AFTER_TOO_LONG';

/** Thrown when retrying stops on a retryable failure. The last attempt's error is the `cause`. */
export class RetryStoppedError extends RetryExhaustedError {
  constructor(attempts: number, readonly code: RetryStopCode, cause: unknown) {
    super(attempts, code, cause);
    this.message = `${cause instanceof Error ? cause.message : 'Attempt failed'} (${code} after ${attempts} attempt${attempts === 1 ? '' : 's'})`;
  }
}

/** The last attempt's error, for sites that keep their established error types. */
export function lastAttemptError(error: unknown): unknown {
  return error instanceof RetryStoppedError ? error.cause : error;
}

/** One failed attempt, reported through `onAttempt`. */
export type RetryAttemptRecord = {
  attempt: number;
  /** `http_<status>`, `network`, `peer_exhausted`, `unknown_effect`, `bytes_consumed` or `permanent`. */
  reason: string;
  /** The wait before the next attempt, or null when this attempt was the last. */
  delayMs: number | null;
  /** Why retrying stopped on a retryable failure. */
  stop?: RetryStopCode;
};

export type RetryWithPolicyOptions = {
  signal?: AbortSignal | undefined;
  /** Absolute epoch-ms deadline. No attempt starts at or after it. */
  deadlineMs?: number | undefined;
  /** `none` (no effect, or a read), `idempotent` (safe to repeat by contract) or `unknown` (never repeated). */
  effect: 'none' | 'idempotent' | 'unknown';
  onAttempt?: ((record: RetryAttemptRecord) => void) | undefined;
  /** Describe a thrown error that is not an `AttemptError`. Undefined: permanent. */
  classify?: ((error: unknown) => AttemptFailure | undefined) | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
};

function reasonOf(failure: AttemptFailure): string {
  if (failure.signal === 'exhausted') return 'peer_exhausted';
  if ((failure.bytesConsumed ?? 0) > 0) return 'bytes_consumed';
  if (failure.network) return 'network';
  return failure.status === undefined ? 'permanent' : `http_${failure.status}`;
}

/**
 * Run `operation` under the named policy. A permanent failure rethrows its own error; stopping on
 * a retryable one throws `RetryStoppedError` (`RETRY_EXHAUSTED`, `RETRY_DEADLINE` or
 * `RETRY_AFTER_TOO_LONG`). Cancellation, including during a backoff wait, ends at once.
 */
export async function retryWithPolicy<T>(name: RetryPolicyName | RetryPolicy,
  operation: (attempt: number) => Promise<T>, options: RetryWithPolicyOptions): Promise<T> {
  const policy: RetryPolicy = typeof name === 'string' ? RETRY_POLICIES[name] : name;
  const now = options.now ?? Date.now;
  for (let attempt = 1; ; attempt++) {
    // An aborted signal rejects at once with its reason.
    if (options.signal?.aborted) await sleepAbortable(0, options.signal);
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
      const failure = error instanceof AttemptError ? error.failure : options.classify?.(error);
      if (!failure) {
        options.onAttempt?.({ attempt, reason: 'permanent', delayMs: null });
        throw error;
      }
      const category = failure.signal === 'exhausted' ? 'permanent' : classifyRetry({ ...failure, effect: options.effect });
      const reason = category === 'unknown_effect' ? 'unknown_effect' : reasonOf(failure);
      if (category !== 'retryable') {
        options.onAttempt?.({ attempt, reason, delayMs: null });
        throw error;
      }
      let stop: RetryStopCode | undefined;
      let delay: number | null = null;
      if (attempt >= policy.maxAttempts) stop = 'RETRY_EXHAUSTED';
      else if (failure.retryAfterMs !== undefined && failure.retryAfterMs > (policy.maxRetryAfterMs ?? Number.POSITIVE_INFINITY)) stop = 'RETRY_AFTER_TOO_LONG';
      else {
        delay = backoffDelay(attempt, policy, { retryAfterMs: failure.retryAfterMs, deadlineMs: options.deadlineMs, now,
          ...(options.random ? { random: options.random } : {}) });
        if (delay === null) stop = 'RETRY_DEADLINE';
      }
      options.onAttempt?.({ attempt, reason, delayMs: delay, ...(stop ? { stop } : {}) });
      if (stop || delay === null) throw new RetryStoppedError(attempt, stop ?? 'RETRY_DEADLINE', error);
      await sleepAbortable(delay, options.signal);
    }
  }
}

/** A failure from a non-2xx response: status, `Retry-After` (seconds or HTTP date) and `x-hive-retry`. */
export function responseFailure(response: Pick<Response, 'status' | 'headers'>, now?: () => number): AttemptFailure {
  return { status: response.status, retryAfterMs: retryAfterFromHeaders(response.headers, now), signal: readRetrySignal(response.headers) };
}

/**
 * Whether a rejected `fetch` failed in transport (undici reports `TypeError: fetch failed`).
 * Timeouts and aborts are not transport failures: a timed-out request is not repeated.
 */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  return error instanceof TypeError;
}
