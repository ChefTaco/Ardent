import { HiveError, isHiveError, type HiveErrorOptions } from '@hivemagnus/hive-common/errors';
import { z } from 'zod';

export { HiveError, isHiveError } from '@hivemagnus/hive-common/errors';

/**
 * Typed errors of the management API. Each one carries its HTTP status and a
 * stable code, so the API maps it explicitly instead of reading the message.
 * The messages are unchanged from the plain errors they replace, so the CLI,
 * which prints `error.message`, reads the same.
 */
export const ErrorCode = {
  invalid: 'INVALID_REQUEST',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  unavailable: 'DEPENDENCY_UNAVAILABLE',
  /** The profile refuses new work: it is draining for shutdown or its admission is fenced for a rollback. */
  notAccepting: 'NOT_ACCEPTING_WORK',
  tooLarge: 'BODY_TOO_LARGE',
  internal: 'INTERNAL_ERROR',
} as const;

const make = (code: string, status: number) => (message: string, options: Omit<HiveErrorOptions, 'status'> = {}) =>
  new HiveError(code, message, { ...options, status });

/** 400: the request is malformed or names something it may not. */
export const invalidRequest = make(ErrorCode.invalid, 400);
/** 404: the task, session, skill, peer or record does not exist. */
export const notFound = make(ErrorCode.notFound, 404);
/** 409: the request conflicts with the current state (a revision, an idempotency key, an edit in progress). */
export const conflict = make(ErrorCode.conflict, 409);
/** 503: a configured dependency (a provider, channel, peer or HiveMem) is missing, unconfigured or not answering. */
export const dependencyUnavailable = make(ErrorCode.unavailable, 503);
/** 503: the profile does not accept new work right now. */
export const notAcceptingWork = make(ErrorCode.notAccepting, 503);

/** The session exists, but for another caller or context. */
export class SessionMismatchError extends HiveError {
  override readonly name: string = 'SessionMismatchError';
  constructor(message = 'Session caller or context mismatch') { super(ErrorCode.invalid, message, { status: 400 }); }
}

/** A finished task cannot be paused. `code` stays `TASK_TERMINAL` for code that checked it; the API answers 409 CONFLICT. */
export class TaskTerminalError extends HiveError {
  override readonly name: string = 'TaskTerminalError';
  constructor(message: string) { super('TASK_TERMINAL', message, { status: 409 }); }
}

/** The error's message, or a fallback for a thrown non-error. */
export const messageOf = (error: unknown, fallback: string): string => error instanceof Error && error.message ? error.message : fallback;

/**
 * Run a probe of an external dependency: a failure that is not already typed
 * is reported as the dependency being unavailable (503), with its message.
 */
export async function dependency<T>(probe: () => Promise<T>, fallback = 'Dependency unavailable'): Promise<T> {
  try { return await probe(); }
  catch (error: unknown) {
    if (isHiveError(error)) throw error;
    throw dependencyUnavailable(messageOf(error, fallback), { cause: error });
  }
}

/**
 * How Ardent before 3.4 classified an error by its message. Kept only for
 * errors that plugin routes throw without a status, so a plugin written for
 * an earlier release answers as it did; a plugin should throw a `HiveError`
 * (for example `invalidRequest()`), which keeps its status and code.
 */
export function legacyStatus(message: string): 400 | 404 | 409 | 500 | 503 {
  return /revision conflict|Idempotency key reused|already in progress/i.test(message) ? 409
    : /not found|absent/i.test(message) ? 404
    : /unavailable|stale|unconfigured|missing|login required|wrong auth mode|CODEX_LOGIN_REQUIRED|CODEX_WRONG_AUTH_MODE|fetch failed|ECONNREFUSED|ETIMEDOUT|timeout/i.test(message) ? 503
    : /invalid|must be|exceeds|requires/i.test(message) ? 400 : 500;
}

const LEGACY_CODE = { 400: ErrorCode.invalid, 404: ErrorCode.notFound, 409: ErrorCode.conflict, 503: ErrorCode.unavailable } as const;

/** A plugin route's untyped error as the typed error Ardent before 3.4 would have answered with (a 500 stays untyped). */
export function legacyPluginError(error: unknown): unknown {
  if (isHiveError(error) || !(error instanceof Error)) return error;
  const status = error instanceof z.ZodError || error instanceof SyntaxError ? 400 : legacyStatus(error.message);
  return status === 500 ? error : new HiveError(LEGACY_CODE[status], error.message, { status, cause: error });
}
