import { createLogger, type Logger } from '@hivemagnus/hive-common/log';

export type { Logger } from '@hivemagnus/hive-common/log';

/**
 * Operational log lines: JSON, secrets redacted, written to stderr so stdout
 * stays the CLI's machine-readable output. `LOG_LEVEL` sets the minimum level.
 */
export function ardentLogger(): Logger {
  return createLogger({ bindings: { service: 'ardent' }, write: line => { process.stderr.write(`${line}\n`); } });
}
