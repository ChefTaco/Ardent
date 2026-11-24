import { HiveError, type HiveErrorOptions } from '@hivemagnus/hive-common/errors';

/**
 * Every error the client raises. It is a `HiveError`, so `status`, `code`, `details` and
 * `requestId` follow the suite error envelope, and `HiveError.is(error, code)` works across
 * package copies.
 */
export class ArdentClientError extends HiveError {
  override readonly name: string = 'ArdentClientError';
  constructor(code: string, message: string, options: HiveErrorOptions = {}) {
    super(code, message, options);
  }
}

/** The token was refused, also after `getToken()` was asked for a fresh one. */
export class UnauthorizedError extends ArdentClientError {
  override readonly name: string = 'UnauthorizedError';
}

/** The task, session, artifact or recovery does not exist. */
export class NotFoundError extends ArdentClientError {
  override readonly name: string = 'NotFoundError';
}

/**
 * The request conflicts with the current state: a finished task cannot pause, a recovery was
 * decided differently, or (`idempotency: true`) the idempotency key was already used for a
 * different task.
 */
export class ConflictError extends ArdentClientError {
  override readonly name: string = 'ConflictError';
  readonly idempotency: boolean;
  constructor(code: string, message: string, options: HiveErrorOptions & { idempotency?: boolean } = {}) {
    super(code, message, options);
    this.idempotency = options.idempotency ?? false;
  }
}

/**
 * The route is not available through this transport: Magnus does not allow it yet, or the
 * profile runs an Ardent that predates it. `capability` names what is missing.
 */
export class UnsupportedCapabilityError extends ArdentClientError {
  override readonly name: string = 'UnsupportedCapabilityError';
  readonly capability: string;
  readonly requiredVersion: string | undefined;
  readonly installedVersion: string | undefined;
  constructor(capability: string, message: string, options: HiveErrorOptions & { requiredVersion?: string | undefined; installedVersion?: string | undefined } = {}) {
    super('unsupported_capability', message, { ...options, details: { capability, ...options.details } });
    this.capability = capability;
    this.requiredVersion = options.requiredVersion;
    this.installedVersion = options.installedVersion;
  }
}

/**
 * The request did not complete: a network failure, a dropped stream that could not be
 * resumed, an unavailable dependency (502, 503, 504) or a response that is not what the API
 * documents.
 */
export class TransportError extends ArdentClientError {
  override readonly name: string = 'TransportError';
}

/** The downloaded bytes do not hash to the artifact's SHA-256. Discard them. */
export class DigestMismatchError extends ArdentClientError {
  override readonly name: string = 'DigestMismatchError';
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string, options: HiveErrorOptions = {}) {
    super('DIGEST_MISMATCH', 'The downloaded artifact does not match its SHA-256', { status: 502, ...options, details: { expected, actual } });
    this.expected = expected;
    this.actual = actual;
  }
}
