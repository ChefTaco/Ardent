import { createLogger, type Logger } from '@hivemagnus/hive-common/log';

export type { Logger } from '@hivemagnus/hive-common/log';

/**
 * Operational log lines: JSON, secrets redacted, written to stderr so stdout
 * stays the CLI's machine-readable output. `LOG_LEVEL` sets the minimum level.
 */
export function ardentLogger(options: { requestContext?: boolean } = {}): Logger {
  return createLogger({ bindings: { service: 'ardent' }, write: line => { process.stderr.write(`${line}\n`); },
    // Task work outlives the request that queued it: without the request context, its lines carry their own ids.
    ...(options.requestContext === false ? { context: () => undefined } : {}) });
}

/** A logger that writes nothing: the default of a runtime or component nobody gave a logger. */
export const silentLogger: Logger = createLogger({ level: 'silent' });
