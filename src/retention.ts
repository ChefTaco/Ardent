import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
};
export type PruneResult = {
  dry_run: boolean;
  cutoff: string;
  tasks: number;
  rows: Record<string, number>;
  artifacts: { deleted: number; retained: number };
};

const ids = z.array(z.object({ id: z.string() }));

/** Columns of other tables that name a task, found from the schema so a new table is covered without a change here. */
function referencingColumns(db: Database): Array<{ table: string; column: string }> {
  const tables = z.array(z.object({ name: z.string() })).parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).map(row => row.name);
  const result: Array<{ table: string; column: string }> = [];
  for (const table of tables) {
    if (table === 'tasks' || table in OWNED) continue;
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const columns = z.array(z.object({ name: z.string() })).parse(db.prepare(`PRAGMA table_info(${quoted})`).all()).map(row => row.name);
    const keys = z.array(z.object({ table: z.string(), from: z.string() })).parse(db.prepare(`PRAGMA foreign_key_list(${quoted})`).all())
      .filter(key => key.table === 'tasks').map(key => key.from);
    for (const column of new Set([...keys, ...columns.filter(name => /task_id$/.test(name) || name === 'operation_id')])) result.push({ table: quoted, column: `"${column}"` });
  }
  return result;
}

type Cursor = { updated_ms: number; id: string };
/** One page of prunable tasks after `after` (oldest first), minus any another record still needs. */
function candidates(db: Database, cutoff: number, limit: number, after: Cursor | undefined): { ids: string[]; last: Cursor | undefined; scanned: number } {
  const has = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
  const guards: string[] = [];
  if (has('task_recovery')) guards.push("NOT EXISTS (SELECT 1 FROM task_recovery r WHERE r.task_id=t.id AND r.status NOT IN ('resumed','resolved'))",
    'NOT EXISTS (SELECT 1 FROM task_recovery r WHERE r.continuation_task_id=t.id)');
  if (has('tool_invocations')) guards.push("NOT EXISTS (SELECT 1 FROM tool_invocations i WHERE i.task_id=t.id AND i.state IN ('dispatched','failed_unknown','unknown'))");
  if (has('channel_deliveries')) guards.push("NOT EXISTS (SELECT 1 FROM channel_deliveries d WHERE d.task_id=t.id AND d.state NOT IN ('sent','failed'))");
  // Session transcripts are immutable and context checkpoints rest on them: a task with session messages stays.
  if (has('session_messages')) guards.push('NOT EXISTS (SELECT 1 FROM session_messages m WHERE m.task_id=t.id)');
  for (const { table, column } of referencingColumns(db)) guards.push(`NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.${column}=t.id)`);
  const page = z.array(z.object({ id: z.string(), updated_ms: z.number().int() })).parse(db.prepare(`SELECT t.id, t.updated_ms FROM tasks t
    WHERE t.state IN (${PRUNABLE_STATES.map(() => '?').join(',')}) AND t.updated_ms < ?
    ${after ? 'AND (t.updated_ms > ? OR (t.updated_ms = ? AND t.id > ?))' : ''} ORDER BY t.updated_ms, t.id LIMIT ?`)
    .all(...PRUNABLE_STATES, cutoff, ...(after ? [after.updated_ms, after.updated_ms, after.id] : []), limit));
  const tail = page.at(-1);
  const last = tail ? { updated_ms: tail.updated_ms, id: tail.id } : undefined;
  if (!page.length) return { ids: [], last, scanned: 0 };
  const placeholders = page.map(() => '?').join(',');
  const rows = ids.parse(db.prepare(`SELECT t.id FROM tasks t WHERE t.id IN (${placeholders}) ${guards.map(guard => `AND ${guard}`).join(' ')}`).all(...page.map(row => row.id))).map(row => row.id);
  if (!has('task_execution') || !rows.length) return { ids: rows, last, scanned: page.length };
  // A kept task's ancestry (parent or root) keeps the tasks it names.
  const selected = new Set(rows);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...selected]) {
      const placeholders = [...selected].map(() => '?').join(',');
      const named = db.prepare(`SELECT 1 FROM task_execution WHERE task_id NOT IN (${placeholders}) AND (instr(coalesce(parent_ref,''), ?)>0 OR instr(root_ref, ?)>0) LIMIT 1`)
        .get(...selected, id, id);
      if (named) { selected.delete(id); changed = true; }
    }
  }
  return { ids: [...selected], last, scanned: page.length };
}

/**
 * Delete old finished tasks and everything that belongs only to them: events,
 * execution state, settled tool invocations and recovery, settled channel
 * deliveries and their inbound updates, and artifact manifests. Artifact bytes
 * go when no manifest or kept task's journal still names them. Unknown, held,
 * queued, running and paused work, tasks with (immutable) session messages,
 * and any task another record refers to, are kept.
 */
export async function pruneJournal(store: TaskStore, artifacts: ArtifactStore, options: PruneOptions): Promise<PruneResult> {
  if (!Number.isSafeInteger(options.olderThanMs) || options.olderThanMs < MIN_RETENTION_MS) throw invalidRequest('Retention must be at least one day');
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanMs;
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
    db.transaction(() => {
      const placeholders = ids.map(() => '?').join(',');
      const has = (table: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
      if (has('artifact_manifests')) {
        for (const row of z.array(z.object({ sha256: z.string() })).parse(db.prepare(`SELECT DISTINCT sha256 FROM artifact_manifests WHERE task_id IN (${placeholders})`).all(...ids))) freed.add(row.sha256);
        if (has('artifact_renditions')) add('artifact_renditions', Number(db.prepare(`DELETE FROM artifact_renditions WHERE rendition_artifact_id IN (SELECT artifact_id FROM artifact_manifests WHERE task_id IN (${placeholders}))`).run(...ids).changes));
      }
      for (const [table, column] of Object.entries(OWNED)) if (has(table)) add(table, Number(db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...ids).changes));
      add('tasks', Number(db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids).changes));
    })();
  }
  const result = { deleted: 0, retained: 0 };
  for (const sha of freed) {
    const manifest = db.prepare('SELECT 1 FROM artifact_manifests WHERE sha256=? LIMIT 1').get(sha);
    const rendition = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_renditions'").get() !== undefined
      && db.prepare('SELECT 1 FROM artifact_renditions WHERE original_sha256=? OR rendition_sha256=? LIMIT 1').get(sha, sha) !== undefined;
    const journaled = db.prepare('SELECT 1 FROM events WHERE instr(detail_json, ?)>0 LIMIT 1').get(sha);
    if (manifest || rendition || journaled) { result.retained++; continue; }
    await artifacts.delete(sha).catch(() => undefined);
    result.deleted++;
  }
  return { dry_run: options.dryRun ?? false, cutoff: new Date(cutoff).toISOString(), tasks, rows, artifacts: result };
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
