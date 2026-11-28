import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TaskState } from '@a2a-js/sdk';
import { z } from 'zod';
import type { ArtifactStore } from './artifacts.js';
import { inspectJournal } from './journal.js';
import { Database } from './sqlite.js';
import type { TaskStore } from './store.js';
import { invalidRequest } from './errors.js';
import { ARDENT_VERSION } from './version.js';

/** A task that ended this way can be pruned; queued, running, input_required and unknown tasks never are. */
export const PRUNABLE_STATES = ['completed', 'partial', 'failed', 'cancelled'] as const;
/** The shortest retention: younger work stays, so channel replay protection outlives any catch-up window. */
export const MIN_RETENTION_MS = 24 * 3_600_000;

/**
 * Tables whose rows belong to one task and go with it. Any other table that
 * names a task (a foreign key to tasks, or a `*task_id` / `operation_id`
 * column) keeps the task: A2A, team, job and future records are never orphaned.
 */
const OWNED: Readonly<Record<string, string>> = {
  events: 'task_id', task_admission: 'task_id', task_execution: 'task_id', execution_state: 'task_id',
  tool_invocations: 'task_id', task_recovery: 'task_id', artifact_manifests: 'task_id',
  channel_deliveries: 'task_id', channel_inbound: 'task_id',
};

export type PruneOptions = {
  /** Prune tasks that last changed before now minus this. At least one day. */
  olderThanMs: number;
  dryRun?: boolean;
  /** Tasks per pass; the prune runs passes until none is left. Default 500. */
  batch?: number;
  now?: number;
  /** Prune only while the profile holds more than this many bytes (see `profileSize`); below it nothing is deleted. */
  minProfileBytes?: number;
  /** Also delete whole peer (A2A) sessions whose work is all finished and older than the cutoff, transcript included. */
  peerSessions?: boolean;
};
export type PruneResult = {
  dry_run: boolean;
  cutoff: string;
  tasks: number;
  rows: Record<string, number>;
  artifacts: { deleted: number; retained: number };
  /** The profile's size before the prune, when a size threshold was given. */
  profile_bytes?: number;
  /** `below_min_size` when the profile was under the threshold and nothing was looked at. */
  skipped?: 'below_min_size';
  /** Whole peer sessions deleted (or, on a dry run, that would be), when `peerSessions` was given. */
  peer_sessions?: number;
};

export type ProfileSize = { journal_bytes: number; artifact_bytes: number; total_bytes: number };

/**
 * What a profile holds: the journal's used pages (pages a prune freed are left
 * out, since SQLite keeps the file size until a vacuum) plus the stored
 * artifact files. Temporary and partial uploads are not counted.
 */
export async function profileSize(store: TaskStore, artifacts: ArtifactStore): Promise<ProfileSize> {
  const pragma = (name: 'page_count' | 'freelist_count' | 'page_size') => z.object({ [name]: z.number().int() }).parse(store.db.prepare(`PRAGMA ${name}`).get())[name] ?? 0;
  const journal = Math.max(0, pragma('page_count') - pragma('freelist_count')) * pragma('page_size');
  let artifact = 0;
  const names = await readdir(artifacts.directory).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const info = await lstat(join(artifacts.directory, name)).catch(() => undefined);
    if (info?.isFile()) artifact += info.size;
  }
  return { journal_bytes: journal, artifact_bytes: artifact, total_bytes: journal + artifact };
}

const ids = z.array(z.object({ id: z.string() }));
const has = (db: Database, table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
const marks = (count: number) => Array.from({ length: count }, () => '?').join(',');
/** Runs `run` over `values` in slices, so a statement's parameters stay well under SQLite's limit. */
function inChunks<T>(values: readonly T[], run: (slice: T[]) => void, size = 500): void {
  for (let index = 0; index < values.length; index += size) run(values.slice(index, index + size));
}

/**
 * Columns of other tables that name a task (a foreign key to tasks, or a `*task_id` / `operation_id`
 * column), found from the schema so a new table is covered without a change here. `skip` lists the
 * tables a prune deletes along with the task.
 */
function referencingColumns(db: Database, skip: ReadonlySet<string> = new Set()): Array<{ table: string; column: string }> {
  return namingColumns(db, 'tasks', name => /task_id$/.test(name) || name === 'operation_id', new Set(['tasks', ...Object.keys(OWNED), ...skip]));
}

/** Columns that name rows of `target`: a foreign key to it, or a column `test` accepts. */
function namingColumns(db: Database, target: string, test: (column: string) => boolean, skip: ReadonlySet<string>): Array<{ table: string; column: string }> {
  const tables = z.array(z.object({ name: z.string() })).parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).map(row => row.name);
  const result: Array<{ table: string; column: string }> = [];
  for (const table of tables) {
    if (skip.has(table)) continue;
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const columns = z.array(z.object({ name: z.string() })).parse(db.prepare(`PRAGMA table_info(${quoted})`).all()).map(row => row.name);
    const keys = z.array(z.object({ table: z.string(), from: z.string() })).parse(db.prepare(`PRAGMA foreign_key_list(${quoted})`).all())
      .filter(key => key.table === target).map(key => key.from);
    for (const column of new Set([...keys, ...columns.filter(test)])) result.push({ table: quoted, column: `"${column.replace(/"/g, '""')}"` });
  }
  return result;
}

/** A query over a slice of ids (`list` is its placeholders) that returns, as `id`, the ones a rule keeps. */
type Hold = (list: string) => string;

/**
 * What keeps a task: active recovery, an uncertain tool effect, an unsettled channel reply, or
 * another record naming it. Session transcripts are immutable and context checkpoints rest on
 * them, so a task with session messages stays, unless the prune removes its whole peer session
 * (`wholeSessions`), whose own tables are then in `skip`. Each rule scans its table once per slice
 * of candidates, not once per candidate: most of these columns have no index.
 */
function taskHolds(db: Database, options: { wholeSessions: boolean; skip?: ReadonlySet<string> }): Hold[] {
  const holds: Hold[] = [];
  if (has(db, 'task_recovery')) holds.push(list => `SELECT task_id AS id FROM task_recovery WHERE task_id IN (${list}) AND status NOT IN ('resumed','resolved')`,
    list => `SELECT continuation_task_id AS id FROM task_recovery WHERE continuation_task_id IN (${list})`);
  if (has(db, 'tool_invocations')) holds.push(list => `SELECT task_id AS id FROM tool_invocations WHERE task_id IN (${list}) AND state IN ('dispatched','failed_unknown','unknown')`);
  if (has(db, 'channel_deliveries')) holds.push(list => `SELECT task_id AS id FROM channel_deliveries WHERE task_id IN (${list}) AND state NOT IN ('sent','failed')`);
  if (!options.wholeSessions && has(db, 'session_messages')) holds.push(list => `SELECT task_id AS id FROM session_messages WHERE task_id IN (${list})`);
  const skip = new Set([...(options.skip ?? []), ...(options.wholeSessions ? ['session_messages'] : [])]);
  for (const { table, column } of referencingColumns(db, skip)) holds.push(list => `SELECT ${column} AS id FROM ${table} WHERE ${column} IN (${list})`);
  return holds;
}

/** The ids among `values` that any of `holds` keeps. */
function held(db: Database, holds: readonly Hold[], values: readonly string[]): Set<string> {
  const kept = new Set<string>();
  inChunks(values, slice => {
    for (const hold of holds) for (const row of z.array(z.object({ id: z.unknown() })).parse(db.prepare(hold(marks(slice.length))).all(...slice)))
      if (typeof row.id === 'string') kept.add(row.id);
  });
  return kept;
}

/** Removes from `selected` every task that a kept task's ancestry (parent or root) names, until none is left. */
function withoutNamedAncestry(db: Database, selected: Set<string>): Set<string> {
  if (!has(db, 'task_execution') || !selected.size) return selected;
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...selected]) {
      const naming = ids.parse(db.prepare("SELECT task_id AS id FROM task_execution WHERE instr(coalesce(parent_ref,''), ?)>0 OR instr(root_ref, ?)>0").all(id, id));
      if (naming.some(row => !selected.has(row.id))) { selected.delete(id); changed = true; }
    }
  }
  return selected;
}

type Cursor = { updated_ms: number; id: string };
/** One page of prunable tasks after `after` (oldest first), minus any another record still needs. */
function candidates(db: Database, cutoff: number, limit: number, after: Cursor | undefined): { ids: string[]; last: Cursor | undefined; scanned: number } {
  const page = z.array(z.object({ id: z.string(), updated_ms: z.number().int() })).parse(db.prepare(`SELECT t.id, t.updated_ms FROM tasks t
    WHERE t.state IN (${marks(PRUNABLE_STATES.length)}) AND t.updated_ms < ?
    ${after ? 'AND (t.updated_ms > ? OR (t.updated_ms = ? AND t.id > ?))' : ''} ORDER BY t.updated_ms, t.id LIMIT ?`)
    .all(...PRUNABLE_STATES, cutoff, ...(after ? [after.updated_ms, after.updated_ms, after.id] : []), limit));
  const tail = page.at(-1);
  const last = tail ? { updated_ms: tail.updated_ms, id: tail.id } : undefined;
  if (!page.length) return { ids: [], last, scanned: 0 };
  const kept = held(db, taskHolds(db, { wholeSessions: false }), page.map(row => row.id));
  return { ids: [...withoutNamedAncestry(db, new Set(page.map(row => row.id).filter(id => !kept.has(id))))], last, scanned: page.length };
}

/** A2A task states that end a task: completed, failed, canceled and rejected. */
const A2A_TERMINAL = [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].map(Number);
/**
 * Tables keyed by A2A task id whose rows belong to one inbound peer task and go with its session.
 * Lead-side records (child claims, artifact transfers, outbound calls) are not here: a task they
 * name keeps its session.
 */
const PEER_OWNED: Readonly<Record<string, string>> = {
  a2a_operation_map: 'a2a_task_id', a2a_operation_links: 'a2a_task_id', a2a_team_missions: 'a2a_task_id',
  a2a_team_admission: 'a2a_task_id', a2a_team_controls: 'a2a_task_id', a2a_recovery_publications: 'a2a_task_id',
  a2a_push_configs: 'task_id', a2a_push_deliveries: 'task_id', a2a_request_receipts: 'task_id',
  a2a_team_artifacts: 'a2a_task_id', a2a_tasks: 'id',
};
/** Session-keyed tables a whole-session prune deletes, children first. */
const SESSION_OWNED = ['context_checkpoint_heads', 'emberfold_checkpoint_metadata', 'context_checkpoints', 'context_compaction_attempts'] as const;

type PeerPage = { sessions: string[]; tasks: string[]; a2a: string[]; last: string | undefined; scanned: number };
/**
 * One page of peer (A2A) sessions after `after` that can go whole: the session and every task in
 * it last changed before the cutoff, every task is finished and passes the task guards (apart from
 * having session messages and the A2A rows that go with it), every A2A task it maps to is in a
 * final state with its push deliveries settled, its recovery publication final and its published
 * team artifacts expired or revoked, and no other record names the session or its checkpoints.
 */
function peerCandidates(db: Database, cutoff: number, nowMs: number, limit: number, after: string | undefined): PeerPage {
  const page = ids.parse(db.prepare(`SELECT id FROM sessions WHERE context='peer' AND updated_ms < ? ${after === undefined ? '' : 'AND id > ?'} ORDER BY id LIMIT ?`)
    .all(cutoff, ...(after === undefined ? [] : [after]), limit)).map(row => row.id);
  const last = page.at(-1);
  if (!page.length) return { sessions: [], tasks: [], a2a: [], last, scanned: 0 };
  const sessionTasks = new Map<string, Set<string>>(page.map(id => [id, new Set<string>()]));
  const rejected = new Set<string>();
  const taskRows = z.array(z.object({ id: z.string(), session_id: z.string(), state: z.string(), updated_ms: z.number().int() }))
    .parse(db.prepare(`SELECT id, session_id, state, updated_ms FROM tasks WHERE session_id IN (${marks(page.length)})`).all(...page));
  const prunable = new Set<string>(PRUNABLE_STATES);
  for (const row of taskRows) {
    sessionTasks.get(row.session_id)?.add(row.id);
    if (!prunable.has(row.state) || row.updated_ms >= cutoff) rejected.add(row.session_id);
  }
  // Transcript lines and tasks must stay in one session: a line in the session written by a task of
  // another session, or a line elsewhere written by one of its tasks, would leave a transcript short.
  for (const row of z.array(z.object({ session_id: z.string(), task_id: z.string() })).parse(db.prepare(`SELECT DISTINCT session_id, task_id FROM session_messages WHERE session_id IN (${marks(page.length)})`).all(...page)))
    if (!sessionTasks.get(row.session_id)?.has(row.task_id)) rejected.add(row.session_id);
  const taskSession = new Map(taskRows.map(row => [row.id, row.session_id]));
  inChunks([...taskSession.keys()], slice => {
    for (const row of z.array(z.object({ session_id: z.string(), task_id: z.string() })).parse(db.prepare(`SELECT DISTINCT session_id, task_id FROM session_messages WHERE task_id IN (${marks(slice.length)})`).all(...slice))) {
      const own = taskSession.get(row.task_id);
      if (own !== undefined && own !== row.session_id) { rejected.add(own); rejected.add(row.session_id); }
    }
  });
  // Another record that names the session or one of its checkpoints keeps it.
  const sessionOwned = new Set<string>(['tasks', 'sessions', 'session_messages', ...SESSION_OWNED]);
  for (const { table, column } of namingColumns(db, 'sessions', name => name === 'session_id', sessionOwned))
    for (const row of ids.parse(db.prepare(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column} IN (${marks(page.length)})`).all(...page))) rejected.add(row.id);
  if (has(db, 'context_checkpoints'))
    for (const { table, column } of namingColumns(db, 'context_checkpoints', name => name === 'checkpoint_id', sessionOwned))
      for (const row of ids.parse(db.prepare(`SELECT DISTINCT c.session_id AS id FROM context_checkpoints c JOIN ${table} x ON x.${column}=c.id WHERE c.session_id IN (${marks(page.length)})`).all(...page))) rejected.add(row.id);
  const sessionOf = new Map<string, string>();
  for (const [session, tasks] of sessionTasks) for (const task of tasks) sessionOf.set(task, session);
  const open = () => [...sessionTasks.keys()].filter(id => !rejected.has(id));
  const tasksOf = (sessions: string[]) => sessions.flatMap(id => [...sessionTasks.get(id) ?? []]);
  const rejectTask = (task: string) => { const session = sessionOf.get(task); if (session !== undefined) rejected.add(session); };
  // Task guards, without the transcript rule and without the A2A rows that go with the session.
  const allTasks = tasksOf(open());
  if (allTasks.length) {
    for (const task of held(db, taskHolds(db, { wholeSessions: true, skip: new Set(Object.keys(PEER_OWNED)) }), allTasks)) rejectTask(task);
  }
  // The A2A tasks each session's tasks are mapped to.
  const a2aOf = new Map<string, Set<string>>();
  const mapped = tasksOf(open());
  if (mapped.length) for (const table of ['a2a_operation_map', 'a2a_operation_links', 'a2a_team_admission', 'a2a_recovery_publications'] as const) {
    if (!has(db, table)) continue;
    inChunks(mapped, slice => {
      for (const row of z.array(z.object({ a2a_task_id: z.string(), operation_id: z.string() })).parse(db.prepare(`SELECT a2a_task_id, operation_id FROM ${table} WHERE operation_id IN (${marks(slice.length)})`).all(...slice))) {
        const session = sessionOf.get(row.operation_id);
        if (session === undefined) continue;
        const set = a2aOf.get(session) ?? new Set<string>();
        set.add(row.a2a_task_id);
        a2aOf.set(session, set);
      }
    });
  }
  const a2aIds = [...new Set(open().flatMap(id => [...a2aOf.get(id) ?? []]))];
  if (a2aIds.length) {
    const sessionsOfA2A = new Map<string, string[]>();
    for (const [session, set] of a2aOf) for (const id of set) sessionsOfA2A.set(id, [...(sessionsOfA2A.get(id) ?? []), session]);
    // What keeps an A2A task (and so its session): each query runs over a slice of A2A task ids.
    const holds: Array<{ sql: (list: string) => string; extra?: number[] }> = [];
    if (has(db, 'a2a_tasks')) holds.push({ sql: list => `SELECT id FROM a2a_tasks WHERE id IN (${list}) AND CAST(status AS REAL) NOT IN (${A2A_TERMINAL.join(',')})` });
    if (has(db, 'a2a_push_deliveries')) holds.push({ sql: list => `SELECT task_id AS id FROM a2a_push_deliveries WHERE task_id IN (${list}) AND state NOT IN ('sent','failed')` });
    if (has(db, 'a2a_recovery_publications')) holds.push({ sql: list => `SELECT a2a_task_id AS id FROM a2a_recovery_publications WHERE a2a_task_id IN (${list}) AND final=0` });
    if (has(db, 'a2a_team_artifacts')) holds.push({ sql: list => `SELECT a2a_task_id AS id FROM a2a_team_artifacts WHERE a2a_task_id IN (${list}) AND status='available' AND expires > ?`, extra: [nowMs / 1000] });
    if (has(db, 'a2a_team_child_claims')) holds.push({ sql: list => `SELECT a2a_task_id AS id FROM a2a_team_child_claims WHERE a2a_task_id IN (${list})` });
    for (const hold of holds) inChunks(a2aIds, slice => {
      for (const row of ids.parse(db.prepare(hold.sql(marks(slice.length))).all(...slice, ...(hold.extra ?? [])))) for (const session of sessionsOfA2A.get(row.id) ?? []) rejected.add(session);
    });
  }
  // Ancestry: a kept task that names one of a session's tasks keeps the whole session.
  const selected = withoutNamedAncestry(db, new Set(tasksOf(open())));
  for (const task of tasksOf(open())) if (!selected.has(task)) rejectTask(task);
  const sessions = open();
  return { sessions, tasks: tasksOf(sessions), a2a: [...new Set(sessions.flatMap(id => [...a2aOf.get(id) ?? []]))], last, scanned: page.length };
}

/** Key values a batch deleted, by the table they were deleted from. */
type Deleted = Partial<Record<'tasks' | 'sessions' | 'context_checkpoints' | 'artifact_manifests', string[]>>;

/**
 * Runs `remove` in one transaction with foreign key enforcement off. With it on, SQLite looks for
 * child rows of every deleted task or session, and a child column without an index (transcript
 * lines name their task, for one) costs a scan of its table per deleted row. Every child row is
 * either deleted explicitly or was ruled out by the holds before `remove` runs, and each foreign
 * key that points at a table `remove` deleted from is checked for the deleted keys inside the same
 * transaction, so a missed child aborts the batch instead of being left behind. The setting is
 * per connection and the work is synchronous, so nothing else on this connection runs meanwhile.
 */
function deleteWithoutKeyScans(db: Database, remove: () => Deleted): void {
  const enforced = z.array(z.object({ foreign_keys: z.number() })).parse(db.pragma('foreign_keys'))[0]?.foreign_keys === 1;
  if (enforced) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const deleted = remove();
      if (!enforced) return;
      for (const key of foreignKeys(db)) {
        const values = Object.entries(deleted).find(([parent]) => parent === key.parent)?.[1];
        if (!values?.length) continue;
        inChunks(values, slice => {
          const orphan = db.prepare(`SELECT 1 FROM ${key.table} WHERE ${key.column} IN (${marks(slice.length)}) LIMIT 1`).get(...slice);
          if (orphan) throw new Error(`Retention would leave rows of ${key.table} without their ${key.parent} row; this batch was not deleted`);
        });
      }
    })();
  } finally { if (enforced) db.pragma('foreign_keys = ON'); }
}

/** Every foreign key in the journal: the child table and column, and the parent table. */
function foreignKeys(db: Database): Array<{ table: string; column: string; parent: string }> {
  const tables = z.array(z.object({ name: z.string() })).parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).map(row => row.name);
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  return tables.flatMap(table => z.array(z.object({ table: z.string(), from: z.string() })).parse(db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all())
    .map(key => ({ table: quote(table), column: quote(key.from), parent: key.table })));
}

/**
 * Deletes whole peer sessions with their tasks, transcript, checkpoints and A2A rows, in one
 * transaction. The trigger that makes session messages immutable is dropped and recreated from
 * its own stored text inside that transaction, so no other connection ever sees the journal
 * without it, and a failure rolls the drop back with everything else.
 */
function deletePeerSessions(db: Database, page: PeerPage, add: (table: string, count: number) => void, freed: Set<string>): void {
  deleteWithoutKeyScans(db, () => {
    const { tasks, sessions, a2a } = page;
    const manifests: string[] = [], checkpoints: string[] = [];
    if (has(db, 'artifact_manifests')) inChunks(tasks, slice => {
      for (const row of z.array(z.object({ artifact_id: z.string() })).parse(db.prepare(`SELECT artifact_id FROM artifact_manifests WHERE task_id IN (${marks(slice.length)})`).all(...slice))) manifests.push(row.artifact_id);
      for (const row of z.array(z.object({ sha256: z.string() })).parse(db.prepare(`SELECT DISTINCT sha256 FROM artifact_manifests WHERE task_id IN (${marks(slice.length)})`).all(...slice))) freed.add(row.sha256);
      if (has(db, 'artifact_renditions')) add('artifact_renditions', Number(db.prepare(`DELETE FROM artifact_renditions WHERE rendition_artifact_id IN (SELECT artifact_id FROM artifact_manifests WHERE task_id IN (${marks(slice.length)}))`).run(...slice).changes));
    });
    inChunks(a2a, slice => {
      if (has(db, 'a2a_team_artifacts')) for (const row of z.array(z.object({ digest: z.string() })).parse(db.prepare(`SELECT DISTINCT digest FROM a2a_team_artifacts WHERE a2a_task_id IN (${marks(slice.length)})`).all(...slice))) freed.add(row.digest);
      for (const [table, column] of Object.entries(PEER_OWNED)) if (has(db, table)) add(table, Number(db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${marks(slice.length)})`).run(...slice).changes));
    });
    const trigger = z.object({ sql: z.string() }).optional().parse(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='session_messages_immutable_delete'").get());
    if (trigger) db.exec('DROP TRIGGER session_messages_immutable_delete');
    add('session_messages', Number(db.prepare(`DELETE FROM session_messages WHERE session_id IN (${marks(sessions.length)})`).run(...sessions).changes));
    if (trigger) db.exec(trigger.sql);
    if (has(db, 'context_checkpoints')) for (const row of ids.parse(db.prepare(`SELECT id FROM context_checkpoints WHERE session_id IN (${marks(sessions.length)})`).all(...sessions))) checkpoints.push(row.id);
    if (has(db, 'emberfold_checkpoint_metadata') && has(db, 'context_checkpoints'))
      add('emberfold_checkpoint_metadata', Number(db.prepare(`DELETE FROM emberfold_checkpoint_metadata WHERE checkpoint_id IN (SELECT id FROM context_checkpoints WHERE session_id IN (${marks(sessions.length)}))`).run(...sessions).changes));
    for (const table of SESSION_OWNED) if (table !== 'emberfold_checkpoint_metadata' && has(db, table))
      add(table, Number(db.prepare(`DELETE FROM ${table} WHERE session_id IN (${marks(sessions.length)})`).run(...sessions).changes));
    inChunks(tasks, slice => {
      for (const [table, column] of Object.entries(OWNED)) if (has(db, table)) add(table, Number(db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${marks(slice.length)})`).run(...slice).changes));
      add('tasks', Number(db.prepare(`DELETE FROM tasks WHERE id IN (${marks(slice.length)})`).run(...slice).changes));
    });
    add('sessions', Number(db.prepare(`DELETE FROM sessions WHERE id IN (${marks(sessions.length)})`).run(...sessions).changes));
    return { tasks, sessions, context_checkpoints: checkpoints, artifact_manifests: manifests };
  });
}

/** Lets the gateway serve between batches: each batch is selected and deleted in one synchronous step. */
const yieldToEventLoop = () => new Promise<void>(resolve => { setImmediate(resolve); });

/**
 * The digests among `freed` that a record still names, so their bytes stay: an artifact manifest
 * or rendition, a team artifact or artifact transfer, or any journal event. Events are read once,
 * not once per digest.
 */
function namedArtifacts(db: Database, freed: ReadonlySet<string>): Set<string> {
  const named = new Set<string>();
  const columns: Array<[string, string]> = [['artifact_manifests', 'sha256'], ['artifact_renditions', 'original_sha256'], ['artifact_renditions', 'rendition_sha256'],
    ['a2a_team_artifacts', 'digest'], ['a2a_team_artifact_transfers', 'digest'], ['artifact_transfers', 'sha256']];
  const values = [...freed];
  for (const [table, column] of columns) if (has(db, table))
    inChunks(values, slice => { for (const row of ids.parse(db.prepare(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column} IN (${marks(slice.length)})`).all(...slice))) named.add(row.id); });
  if (named.size < freed.size && has(db, 'events'))
    // Any 64-character window of a hex run, so a digest inside a longer hex string still counts (as `instr` did).
    for (const row of db.prepare('SELECT detail_json FROM events').iterate()) {
      const detail = z.object({ detail_json: z.string() }).parse(row).detail_json;
      for (const run of detail.match(/[0-9a-fA-F]{64,}/g) ?? [])
        for (let index = 0; index + 64 <= run.length; index++) { const digest = run.slice(index, index + 64).toLowerCase(); if (freed.has(digest)) named.add(digest); }
    }
  return named;
}

/**
 * Delete old finished tasks and everything that belongs only to them: events,
 * execution state, settled tool invocations and recovery, settled channel
 * deliveries and their inbound updates, and artifact manifests. Artifact bytes
 * go when no record still names them. Unknown, held, queued, running and
 * paused work, tasks with (immutable) session messages, and any task another
 * record refers to, are kept. With `peerSessions`, whole peer (A2A) sessions
 * whose work is all finished and old also go, transcript, checkpoints and A2A
 * records included.
 */
export async function pruneJournal(store: TaskStore, artifacts: ArtifactStore, options: PruneOptions): Promise<PruneResult> {
  if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < MIN_RETENTION_MS) throw invalidRequest('Retention must be at least one day');
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanMs;
  const peer = options.peerSessions ? { peer_sessions: 0 } : {};
  let profileBytes: number | undefined;
  if (options.minProfileBytes !== undefined) {
    if (!Number.isSafeInteger(options.minProfileBytes) || options.minProfileBytes < 0) throw invalidRequest('The size threshold must be a whole number of bytes');
    profileBytes = (await profileSize(store, artifacts)).total_bytes;
    if (profileBytes <= options.minProfileBytes)
      return { dry_run: options.dryRun ?? false, cutoff: new Date(cutoff).toISOString(), tasks: 0, rows: {}, artifacts: { deleted: 0, retained: 0 }, profile_bytes: profileBytes, skipped: 'below_min_size', ...peer };
  }
  const db = store.db;
  const rows: Record<string, number> = {};
  const add = (table: string, count: number) => { rows[table] = (rows[table] ?? 0) + count; };
  const freed = new Set<string>();
  let tasks = 0;
  const batch = Math.max(1, Math.min(options.batch ?? 500, 5000));
  // Pages move forward by (updated_ms, id), so a kept task is looked at once and deleted ones never come back.
  for (let after: Cursor | undefined, scanned = batch; scanned === batch;) {
    const page = candidates(db, cutoff, batch, after);
    ({ last: after, scanned } = page);
    const ids = page.ids;
    if (!ids.length) continue;
    tasks += ids.length;
    if (options.dryRun) { add('tasks', ids.length); continue; }
    deleteWithoutKeyScans(db, () => {
      const placeholders = marks(ids.length);
      const manifests = has(db, 'artifact_manifests') ? z.array(z.object({ artifact_id: z.string() })).parse(db.prepare(`SELECT artifact_id FROM artifact_manifests WHERE task_id IN (${placeholders})`).all(...ids)).map(row => row.artifact_id) : [];
      if (has(db, 'artifact_manifests')) {
        for (const row of z.array(z.object({ sha256: z.string() })).parse(db.prepare(`SELECT DISTINCT sha256 FROM artifact_manifests WHERE task_id IN (${placeholders})`).all(...ids))) freed.add(row.sha256);
        if (has(db, 'artifact_renditions')) add('artifact_renditions', Number(db.prepare(`DELETE FROM artifact_renditions WHERE rendition_artifact_id IN (SELECT artifact_id FROM artifact_manifests WHERE task_id IN (${placeholders}))`).run(...ids).changes));
      }
      for (const [table, column] of Object.entries(OWNED)) if (has(db, table)) add(table, Number(db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...ids).changes));
      add('tasks', Number(db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids).changes));
      return { tasks: ids, artifact_manifests: manifests };
    });
    await yieldToEventLoop();
  }
  let peerSessions = 0;
  if (options.peerSessions && has(db, 'sessions')) {
    // Whole sessions per page, which keeps each statement's parameters well under SQLite's limit.
    const sessionBatch = Math.max(1, Math.min(options.batch ?? 500, 500));
    for (let after: string | undefined, scanned = sessionBatch; scanned === sessionBatch;) {
      const page = peerCandidates(db, cutoff, now, sessionBatch, after);
      ({ last: after, scanned } = page);
      if (!page.sessions.length) continue;
      peerSessions += page.sessions.length;
      tasks += page.tasks.length;
      if (options.dryRun) { add('tasks', page.tasks.length); add('sessions', page.sessions.length); continue; }
      deletePeerSessions(db, page, add, freed);
      await yieldToEventLoop();
    }
  }
  const result = { deleted: 0, retained: 0 };
  const named = freed.size ? namedArtifacts(db, freed) : new Set<string>();
  for (const sha of freed) {
    if (named.has(sha)) { result.retained++; continue; }
    await artifacts.delete(sha).catch(() => undefined);
    result.deleted++;
  }
  return { dry_run: options.dryRun ?? false, cutoff: new Date(cutoff).toISOString(), tasks, rows, artifacts: result,
    ...(profileBytes === undefined ? {} : { profile_bytes: profileBytes }), ...(options.peerSessions ? { peer_sessions: peerSessions } : {}) };
}

/**
 * Rewrites the journal so the pages a prune freed go back to the file system
 * (SQLite otherwise keeps the file at its size and reuses them). It needs the
 * journal to itself for the length of the rewrite and about its size again in
 * temporary space, so run it with the gateway stopped.
 */
export function vacuumJournal(store: TaskStore): { before_bytes: number; after_bytes: number } {
  const size = () => {
    const read = (name: 'page_count' | 'page_size') => z.object({ [name]: z.number().int() }).parse(store.db.prepare(`PRAGMA ${name}`).get())[name] ?? 0;
    return read('page_count') * read('page_size');
  };
  const before = size();
  store.db.exec('VACUUM');
  store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  return { before_bytes: before, after_bytes: size() };
}

/** `90d`, `36h` or `45m`. */
export function parseDuration(text: string): number {
  const match = /^(\d{1,6})([dhm])$/.exec(text.trim());
  const unit = match?.[2] === 'd' ? 86_400_000 : match?.[2] === 'h' ? 3_600_000 : match?.[2] === 'm' ? 60_000 : undefined;
  if (!match || unit === undefined) throw invalidRequest('Use a duration such as 90d, 36h or 45m');
  return Number(match[1]) * unit;
}

export type BackupResult = {
  format: 'ardent-backup';
  version: 1;
  ardent_version: string;
  created_at: string;
  directory: string;
  journal: { file: string; bytes: number; sha256: string; integrity: 'ok'; idle: boolean };
  artifacts: { included: boolean; files: number; bytes: number };
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(z.instanceof(Buffer).parse(chunk));
  return hash.digest('hex');
}

async function tree(path: string): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) { const sub = await tree(child); files += sub.files; bytes += sub.bytes; }
    else if (entry.isFile()) { files++; bytes += (await stat(child)).size; await chmod(child, 0o600); }
  }
  return { files, bytes };
}

/**
 * Copy the profile journal with SQLite's online backup API: a consistent copy
 * while the gateway keeps running. The directory must be new (or empty) and is
 * private. With `artifacts`, the content-addressed artifact files are copied too.
 * Configuration, identity and `.env` are not copied.
 */
export async function backupProfile(profileDir: string, target: string, options: { artifacts?: boolean; now?: () => number } = {}): Promise<BackupResult> {
  const directory = resolve(target);
  const existing = await readdir(directory).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing && existing.length) throw invalidRequest('The backup directory exists and is not empty');
  const created = existing === undefined;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const source = join(profileDir, 'state', 'ardent.sqlite');
  const file = join(directory, 'ardent.sqlite');
  try {
    const db = new Database(source, { fileMustExist: true });
    try { await db.backup(file); } finally { db.close(); }
    await chmod(file, 0o600);
    const copy = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const check = z.object({ integrity_check: z.string() }).parse(copy.prepare('PRAGMA integrity_check').get());
      if (check.integrity_check !== 'ok') throw new Error('The backup copy failed its integrity check');
    } finally { copy.close(); }
    const inspected = await inspectJournal(file);
    let artifacts = { included: false, files: 0, bytes: 0 };
    if (options.artifacts) {
      // Artifact files are immutable and named by digest, so a plain copy is consistent.
      await cp(join(profileDir, 'artifacts'), join(directory, 'artifacts'), { recursive: true, errorOnExist: true, force: false }).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      });
      artifacts = { included: true, ...await tree(join(directory, 'artifacts')) };
    }
    const result: BackupResult = { format: 'ardent-backup', version: 1, ardent_version: ARDENT_VERSION, created_at: new Date(options.now?.() ?? Date.now()).toISOString(), directory,
      journal: { file: 'ardent.sqlite', bytes: (await stat(file)).size, sha256: await sha256File(file), integrity: 'ok', idle: inspected.idle }, artifacts };
    await writeFile(join(directory, 'backup.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return result;
  } catch (error: unknown) {
    // Never leave a partial backup that looks complete.
    if (created) await rm(directory, { recursive: true, force: true });
    else for (const entry of await readdir(directory).catch(() => [])) await rm(join(directory, entry), { recursive: true, force: true });
    throw error;
  }
}
