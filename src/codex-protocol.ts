/**
 * What `codex-protocol.lock.json` records about the Codex App Server protocol
 * Ardent depends on. The package ships this module, not the lock file; a test
 * keeps the two equal.
 *
 * `thread_resume_verified` and `thread_read_items_verified` say whether
 * `thread/resume` of a durable thread, and `thread/read` listing every dynamic
 * tool call item of its turns, were verified against `observed_cli_version`
 * (by `scripts/probe-codex-thread-recovery.mjs`, a live probe).
 * Execution recovery resumes an interrupted Codex thread only when both are
 * true and the installed CLI is that version; otherwise it restarts a task that
 * never dispatched an effectful tool, and holds the rest.
 */
export type CodexProtocolLock = {
  observed_cli_version: string;
  thread_resume_verified: boolean;
  thread_read_items_verified: boolean;
};

export const CODEX_PROTOCOL_LOCK: CodexProtocolLock = {
  observed_cli_version: '0.172.0',
  thread_resume_verified: true,
  thread_read_items_verified: true
};

/** Whether the lock verifies thread recovery at all (any CLI version). */
export function codexThreadRecoveryLocked(lock: CodexProtocolLock = CODEX_PROTOCOL_LOCK): boolean {
  return lock.thread_resume_verified && lock.thread_read_items_verified;
}

/** Why thread recovery is unavailable for an installed CLI, or undefined when it is verified for it. */
export function codexThreadRecoveryProblem(installedVersion: string | undefined, lock: CodexProtocolLock = CODEX_PROTOCOL_LOCK): string | undefined {
  if (!lock.thread_resume_verified) return `thread/resume is not verified in the Codex protocol lock (observed CLI ${lock.observed_cli_version})`;
  if (!lock.thread_read_items_verified) return `thread/read tool-call items are not verified in the Codex protocol lock (observed CLI ${lock.observed_cli_version})`;
  if (installedVersion !== undefined && installedVersion !== lock.observed_cli_version)
    return `thread recovery is verified for Codex CLI ${lock.observed_cli_version}, not the installed ${installedVersion}`;
  return undefined;
}
