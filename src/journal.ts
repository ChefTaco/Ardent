/**
 * Journal quiescence: which tables in a profile's SQLite journal can hold
 * runnable or uncertain work, and how to count it.
 *
 * Ardent owns this classification because Ardent owns the schema. Tools that
 * back up, snapshot, or upgrade a stopped profile (Magnus's node agent among
 * them) ask this module instead of keeping their own table list. Every table
 * Ardent creates is classified here; `test/journal.test.ts` fails when a new
 * `CREATE TABLE` has no entry.
 *
 * The inspector is read-only and dependency-light: it opens the journal with
 * the embedded SQLite driver and never constructs a TaskStore, runtime, plugin,
 * queue, or job handler.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';
import { z } from 'zod';
import Database from './sqlite.js';

/**
 * Version of the classification format and counting rules. It changes only
 * when a consumer would need to read the policy or status differently; adding
 * a table or a state value does not change it.
 */
export const JOURNAL_POLICY_VERSION = 1;

/** A table whose `state` or `status` column says whether a row is still work. */
export type JournalStateRule = {
  readonly kind: 'state';
  readonly column: 'state' | 'status';
  /** Rows a gateway start would run, resume, or send: counted as `active`. */
  readonly active: readonly string[];
  /** Rows whose outcome is uncertain and need reconciliation or an operator: counted as `unknown`. */
  readonly uncertain: readonly string[];
  /** Settled rows: not counted. */
  readonly terminal: readonly string[];
};
/** A table that holds no runnable work. It must not have a `state` or `status` column. */
export type JournalPassiveRule = { readonly kind: 'passive' };
/** A history table with a state column that records what happened, never work a start resumes. */
export type JournalLedgerRule = { readonly kind: 'ledger' };
/** A table with its own rule, described in `description`. */
export type JournalSpecialRule = {
  readonly kind: 'special';
  readonly rule: 'a2a_tasks' | 'a2a_team_child_claims' | 'a2a_request_receipts' | 'channel_inbound' | 'admission_fence';
};
export type JournalTableRule = (JournalStateRule | JournalPassiveRule | JournalLedgerRule | JournalSpecialRule) & { readonly description: string };

const state = (column: 'state' | 'status', active: string[], uncertain: string[], terminal: string[], description: string): JournalTableRule =>
  ({ kind: 'state', column, active, uncertain, terminal, description });
const passive = (description: string): JournalTableRule => ({ kind: 'passive', description });

/** Every table in Ardent's journal and its idle rule. Keep schema changes and this map in the same commit. */
export const JOURNAL_TABLES: Readonly<Record<string, JournalTableRule>> = Object.freeze({
  // Tasks, deliveries and jobs.
  tasks: state('state', ['queued', 'running', 'input_required'], ['unknown'], ['completed', 'partial', 'failed', 'cancelled'],
    'Task journal. Queued and running tasks are work; unknown tasks need an operator.'),
  channel_deliveries: state('state', ['queued'], ['unknown'], ['sent', 'failed'],
    'Chat replies recorded before they are sent.'),
  channel_inbound: { kind: 'special', rule: 'channel_inbound',
    description: 'Admitted chat updates. An update with no task whose delivery is missing, queued or unknown is active.' },
  job_windows: state('state', ['queued', 'running', 'retry'], ['unknown'], ['completed', 'failed', 'superseded'],
    'Scheduled job windows.'),
  // Attempts are immutable receipts: a historical retry is not runnable work; the window owns retry admission.
  job_attempts: state('state', [], ['unknown'], ['completed', 'failed', 'superseded', 'retry'],
    'Receipts of job attempts. An attempt with an unknown effect is uncertain.'),
  admission_fence: { kind: 'special', rule: 'admission_fence',
    description: 'The one-way rollback fence. Any row is unsupported: a temporary snapshot must never clear it.' },
  // Ardent 3.2.0 execution recovery.
  tool_invocations: state('state', ['dispatched'], ['failed_unknown', 'unknown'],
    ['succeeded', 'failed_no_effect', 'reconciled_applied', 'reconciled_not_applied', 'operator_applied', 'operator_not_applied', 'not_dispatched'],
    'Tool calls with a possible effect. A dispatched call is in flight; an uncertain one needs reconciliation.'),
  task_recovery: state('status', ['ready', 'reconciling'], ['awaiting_decision', 'unsupported', 'unknown'], ['resumed', 'resolved'],
    'Execution recovery decisions for interrupted tasks.'),
  artifact_transfers: state('state', ['queued', 'transferring', 'verifying'], ['unknown'], ['completed', 'failed'],
    'Resumable peer artifact imports.'),
  // A2A.
  a2a_tasks: { kind: 'special', rule: 'a2a_tasks',
    description: 'A2A task records. The indexed status and the stored task JSON must agree; submitted, working, input-required and auth-required tasks are active, an unspecified state is unknown.' },
  a2a_request_receipts: { kind: 'special', rule: 'a2a_request_receipts',
    description: 'A2A request idempotency receipts. A receipt not yet bound to a task is active.' },
  a2a_push_deliveries: state('state', ['queued'], ['unknown'], ['sent', 'failed'],
    'A2A push notifications recorded before they are sent.'),
  a2a_outbound_calls: state('state', ['pending', 'bound'], ['unknown'], ['failed'],
    'Outbound A2A calls awaiting the peer\'s push callbacks.'),
  a2a_team_artifacts: state('status', [], ['unknown'], ['available', 'revoked'],
    'Artifacts this profile exports to team peers.'),
  a2a_team_artifact_transfers: state('status', [], ['unknown'], ['complete'],
    'Team artifacts received from peers.'),
  a2a_team_child_claims: { kind: 'special', rule: 'a2a_team_child_claims',
    description: 'Team child claims. An unacknowledged or unsettled claim is active (startup flushes it); a settlement with an unknown outcome is unknown, input-required is active.' },
  a2a_recovery_publications: { kind: 'ledger',
    description: 'What a peer was told about a recovered task.' },
  // Ledgers and passive state.
  channel_catchup_runs: { kind: 'ledger', description: 'Missed-post catch-up walks.' },
  channel_catchup_gaps: passive('Detected gaps in missed-post catch-up.'),
  sessions: passive('Chat sessions.'),
  session_messages: passive('Chat session transcripts.'),
  channel_cursors: passive('Channel offsets and small runtime cursors.'),
  channel_preferences: passive('Per-conversation backend preferences.'),
  events: passive('Task event journal.'),
  context_checkpoints: passive('Context checkpoints (historical summaries).'),
  context_checkpoint_heads: passive('Current context checkpoint per session.'),
  context_compaction_attempts: passive('Context compaction attempt records.'),
  emberfold_checkpoint_metadata: passive('Emberfold checkpoint metadata.'),
  task_admission: passive('Per-task admission holds (pause and resume).'),
  job_scan: passive('Job scheduler scan cursor.'),
  artifact_manifests: passive('Artifact manifests.'),
  artifact_renditions: passive('Artifact renditions.'),
  artifact_sweeps: passive('Preview artifact sweep records.'),
  development_records: passive('Agent development history.'),
  execution_state: passive('Execution checkpoints; work is tracked by tasks and tool_invocations.'),
  task_execution: passive('Task ancestry.'),
  plugin_hook_failures: passive('Plugin hook failure diagnostics.'),
  a2a_operation_map: passive('A2A task to operation mapping.'),
  a2a_operation_links: passive('A2A operation links.'),
  a2a_team_missions: passive('Validated team mission envelopes.'),
  a2a_team_control_requests: passive('Team control requests.'),
  a2a_team_controls: passive('Team control state.'),
  a2a_team_admission: passive('Team admission records.'),
  a2a_push_configs: passive('A2A push notification configurations.'),
  a2a_inbound_push: passive('Received A2A push events.'),
});

/** The machine-readable policy: what `ardent journal policy` prints. */
export function journalPolicy(): { policy_version: number; tables: Record<string, JournalTableRule> } {
  return { policy_version: JOURNAL_POLICY_VERSION, tables: { ...JOURNAL_TABLES } };
}

export type JournalTableStatus = {
  name: string;
  kind: JournalTableRule['kind'] | 'unclassified';
  active: number;
  unknown: number;
  unsupported: number;
  /** Why rows or the table counted as unsupported. Present only when `unsupported` is not zero. */
  problems?: string[];
};
export type JournalStatus = {
  policy_version: number;
  /** True when `active`, `unknown` and `unsupported` are all zero. */
  idle: boolean;
  /** Work a gateway start would run, resume, or send. */
  active: number;
  /** Work whose outcome is uncertain and needs reconciliation or an operator decision. */
  unknown: number;
  /** Tables, columns, or values this policy does not recognize, and the closed admission fence. Never idle. */
  unsupported: number;
  tables: JournalTableStatus[];
};

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const A2A_STATES = ['UNSPECIFIED', 'SUBMITTED', 'WORKING', 'COMPLETED', 'FAILED', 'CANCELED', 'INPUT_REQUIRED', 'REJECTED', 'AUTH_REQUIRED'];
const A2A_ACTIVE = new Set([1, 2, 6, 8]);
function a2aState(value: unknown): number | null {
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.0+)?$/.test(value))) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number < A2A_STATES.length ? number : null;
  }
  if (typeof value !== 'string') return null;
  const index = A2A_STATES.indexOf(value.replace(/^TASK_STATE_/, '').replace(/-/g, '_').toUpperCase());
  return index < 0 ? null : index;
}
const A2ATaskJson = z.object({ id: z.string().min(1), contextId: z.string(), status: z.object({ state: z.union([z.string(), z.number()]) }) });
const Settlement = z.object({ outcome: z.enum(['completed', 'partial', 'failed', 'blocked', 'input_required', 'cancelled', 'unknown']) });

function inspectOpen(db: Database): JournalStatus {
  const check = db.prepare('PRAGMA quick_check').all();
  const first = check[0];
  if (check.length !== 1 || !first || typeof first !== 'object' || Object.values(first)[0] !== 'ok') throw new Error('Journal integrity check failed');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Journal foreign-key integrity check failed');
  const rows = z.array(z.object({ name: z.string(), sql: z.string().nullable() }))
    .parse(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
  const names = new Set(rows.map(row => row.name));
  const count = (sql: string) => z.object({ count: z.number().int() }).parse(db.prepare(sql).get()).count;
  const tables: JournalTableStatus[] = [];
  for (const row of rows) {
    const rule = Object.hasOwn(JOURNAL_TABLES, row.name) ? JOURNAL_TABLES[row.name] : undefined;
    const result: JournalTableStatus = { name: row.name, kind: rule?.kind ?? 'unclassified', active: 0, unknown: 0, unsupported: 0 };
    tables.push(result);
    const problems: string[] = [];
    const unsupported = (problem: string, amount = 1) => { result.unsupported += amount; if (!problems.includes(problem)) problems.push(problem); };
    try {
      const id = identifier.safeParse(row.name);
      if (!id.success) { unsupported('table name is not a plain identifier'); continue; }
      if (row.sql === null || /CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql)) { unsupported('virtual table'); continue; }
      if (!rule) { unsupported('table is not classified by this Ardent version'); continue; }
      if (rule.kind === 'ledger') continue;
      const columns = new Set(z.array(z.object({ name: z.string() })).parse(db.prepare(`PRAGMA table_info("${id.data}")`).all()).map(c => c.name));
      const missing = (...required: string[]) => {
        const absent = required.filter(column => !columns.has(column));
        if (absent.length) unsupported(`missing column ${absent.join(', ')}`);
        return absent.length > 0;
      };
      if (rule.kind === 'state') {
        if (missing(rule.column)) continue;
        const other = rule.column === 'state' ? 'status' : 'state';
        if (columns.has(other)) unsupported(`unexpected ${other} column`);
        for (const entry of db.prepare(`SELECT "${rule.column}" AS value,count(*) AS count FROM "${id.data}" GROUP BY "${rule.column}"`).all()) {
          const group = z.object({ value: z.unknown(), count: z.number().int() }).parse(entry);
          const value = typeof group.value === 'string' ? group.value : null;
          if (value !== null && rule.terminal.includes(value)) continue;
          if (value !== null && rule.uncertain.includes(value)) result.unknown += group.count;
          else if (value !== null && rule.active.includes(value)) result.active += group.count;
          else unsupported(`unrecognized ${rule.column} ${JSON.stringify(group.value)}`, group.count || 1);
        }
        continue;
      }
      if (rule.kind === 'passive') {
        if (columns.has('state') || columns.has('status')) unsupported('passive table has a state or status column');
        continue;
      }
      switch (rule.rule) {
        case 'a2a_tasks': {
          if (missing('status', 'task_json')) break;
          if (columns.has('state')) unsupported('unexpected state column');
          for (const entry of db.prepare('SELECT status,task_json FROM a2a_tasks').iterate()) {
            const task = z.object({ status: z.unknown(), task_json: z.unknown() }).parse(entry);
            let json: unknown;
            try { json = JSON.parse(String(task.task_json)); } catch { unsupported('task JSON does not parse'); continue; }
            const parsed = A2ATaskJson.safeParse(json);
            const indexed = a2aState(task.status), recorded = parsed.success ? a2aState(parsed.data.status.state) : null;
            if (indexed === null || recorded === null || indexed !== recorded) unsupported('indexed status and task JSON disagree');
            for (const value of new Set([indexed, recorded])) {
              if (value === 0) result.unknown++;
              else if (value !== null && A2A_ACTIVE.has(value)) result.active++;
            }
          }
          break;
        }
        case 'admission_fence': {
          if (columns.has('state') || columns.has('status')) { unsupported('unexpected state or status column'); break; }
          const fence = count('SELECT count(*) AS count FROM admission_fence');
          if (fence) unsupported('admission fence is closed', fence);
          break;
        }
        case 'a2a_team_child_claims': {
          if (columns.has('state') || columns.has('status')) { unsupported('unexpected state or status column'); break; }
          if (missing('acknowledged', 'settlement_json')) break;
          // Gateway startup flushes retained settlements, even though this table has no state column.
          result.active += count('SELECT count(*) AS count FROM a2a_team_child_claims WHERE acknowledged IS NULL OR acknowledged!=1 OR settlement_json IS NULL');
          for (const entry of db.prepare('SELECT settlement_json FROM a2a_team_child_claims WHERE settlement_json IS NOT NULL').iterate()) {
            let json: unknown;
            try { json = JSON.parse(String(z.object({ settlement_json: z.unknown() }).parse(entry).settlement_json)); } catch { unsupported('settlement JSON does not parse'); continue; }
            const outcome = Settlement.safeParse(json);
            if (!outcome.success) unsupported('unrecognized settlement outcome');
            else if (outcome.data.outcome === 'unknown') result.unknown++;
            else if (outcome.data.outcome === 'input_required') result.active++;
          }
          break;
        }
        case 'a2a_request_receipts': {
          if (columns.has('state') || columns.has('status')) { unsupported('unexpected state or status column'); break; }
          if (!missing('task_id')) result.active += count("SELECT count(*) AS count FROM a2a_request_receipts WHERE task_id IS NULL OR task_id=''");
          break;
        }
        case 'channel_inbound': {
          if (columns.has('state') || columns.has('status')) { unsupported('unexpected state or status column'); break; }
          if (missing('task_id', 'platform', 'account', 'update_id')) break;
          if (!names.has('channel_deliveries')) { unsupported('channel_deliveries table is missing'); break; }
          result.active += count(`SELECT count(*) AS count FROM channel_inbound AS inbound
            LEFT JOIN channel_deliveries AS delivery ON delivery.platform=inbound.platform
              AND delivery.account=inbound.account AND delivery.update_id=inbound.update_id
            WHERE inbound.task_id IS NULL${columns.has('disposition') ? " AND inbound.disposition='admitted'" : ''} AND (delivery.id IS NULL OR delivery.state IN ('queued','unknown'))`);
          break;
        }
      }
    } finally { if (problems.length) result.problems = problems; }
  }
  const total = (key: 'active' | 'unknown' | 'unsupported') => tables.reduce((sum, table) => sum + table[key], 0);
  // An empty file is not an Ardent journal.
  const unsupported = total('unsupported') + (rows.length === 0 ? 1 : 0);
  const active = total('active'), unknown = total('unknown');
  return { policy_version: JOURNAL_POLICY_VERSION, idle: active === 0 && unknown === 0 && unsupported === 0, active, unknown, unsupported, tables };
}

/**
 * Inspect a journal file in place, read-only. SQLite may still create or touch
 * the `-shm` file beside it, so use this only on a private copy (for example a
 * snapshot staging directory). For a live profile directory use `inspectJournal`.
 */
export function inspectJournalFile(path: string): JournalStatus {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return inspectOpen(db); } finally { db.close(); }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk: Buffer | string) => { hash.update(chunk); });
  await finished(stream);
  return hash.digest('hex');
}
async function regularFile(path: string, optional = false): Promise<boolean> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (optional && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Journal path must be a regular file');
  return true;
}

/**
 * Inspect a profile's journal (`state/ardent.sqlite`) without changing a byte
 * of it. The database and its WAL are copied to a private directory, verified
 * by digest, and inspected there, so committed but uncheckpointed work in the
 * WAL is counted. Throws when the files change during inspection, which means
 * a gateway is writing: a running profile is never idle.
 */
export async function inspectJournal(path: string): Promise<JournalStatus> {
  await regularFile(path);
  const scratch = await mkdtemp(join(tmpdir(), 'ardent-journal-'));
  try {
    await chmod(scratch, 0o700);
    const destination = join(scratch, 'journal.sqlite');
    const sources: Array<{ path: string; sha256: string }> = [];
    for (const suffix of ['', '-wal']) {
      const source = path + suffix;
      if (!await regularFile(source, suffix !== '')) continue;
      const digest = await sha256(source), copied = destination + suffix;
      await copyFile(source, copied);
      await chmod(copied, 0o600);
      if (await sha256(copied) !== digest) throw new Error('Journal changed while it was being copied for inspection');
      sources.push({ path: source, sha256: digest });
    }
    const result = inspectJournalFile(destination);
    for (const source of sources) if (await sha256(source.path) !== source.sha256) throw new Error('Journal changed during inspection');
    if (await regularFile(path + '-wal', true) !== sources.some(source => source.path === path + '-wal')) throw new Error('Journal WAL appeared or disappeared during inspection');
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
