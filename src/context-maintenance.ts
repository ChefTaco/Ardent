import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { parse } from 'dotenv';
import { z } from 'zod';
import { ContextCheckpoints, type CompactionCall } from './context-checkpoints.js';
import { TaskStore } from './store.js';
import { loadConfig } from './config.js';
import { loadModelPolicy } from './model-policy.js';
import { compactWithCodex } from './codex.js';
import { resolveSources, validateCheckpoint } from '@hivemagnus/emberfold';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tableName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
const snapshotSchema = z.object({ tables: z.array(z.object({ table: tableName,
  watermark: z.number().int().nonnegative(), count: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  unknown_only: z.boolean() }).strict()).max(256) }).strict();
export type ContextSnapshot = z.infer<typeof snapshotSchema>;
const previousReaderSchema = z.object({ ContextCheckpoints: z.custom<typeof ContextCheckpoints>(value => typeof value === 'function') });

function rowsDigest(database: Database.Database, table: string, watermark: number, unknownOnly: boolean) {
  tableName.parse(table);
  const hash = createHash('sha256');
  let count = 0;
  for (const row of database.prepare(`SELECT rowid AS __rowid__,* FROM "${table}" WHERE rowid<=?${unknownOnly ? " AND state='unknown'" : ''} ORDER BY rowid`).iterate(watermark)) {
    hash.update(JSON.stringify(row) + '\n'); count++;
  }
  return { count, sha256: hash.digest('hex') };
}

export function snapshotContext(database: Database.Database): ContextSnapshot {
  if (database.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Profile database integrity check failed');
  const tables: ContextSnapshot['tables'] = [];
  const names = z.array(z.object({ name: tableName })).parse(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all());
  for (const { name } of names) {
    const columns = z.array(z.object({ name: z.string() })).parse(database.prepare(`PRAGMA table_info("${name}")`).all());
    const immutable = ['session_messages', 'events', 'context_checkpoints'].includes(name);
    if (!immutable && !columns.some(column => column.name === 'state')) continue;
    const { watermark } = z.object({ watermark: z.number().int().nonnegative() })
      .parse(database.prepare(`SELECT coalesce(max(rowid),0) AS watermark FROM "${name}"`).get());
    tables.push({ table: name, watermark, unknown_only: !immutable, ...rowsDigest(database, name, watermark, !immutable) });
  }
  return { tables };
}

export function verifyContextSnapshot(database: Database.Database, input: unknown): void {
  for (const snapshot of snapshotSchema.parse(input).tables) {
    const actual = rowsDigest(database, snapshot.table, snapshot.watermark, snapshot.unknown_only);
    if (actual.count !== snapshot.count || actual.sha256 !== snapshot.sha256) throw new Error('Original sources, journal events, or uncertain effects changed');
  }
}

export function assertContextIdle(database: Database.Database): void {
  const { count } = z.object({ count: z.number().int() }).parse(database.prepare("SELECT count(*) AS count FROM tasks WHERE state IN ('queued','running','input_required')").get());
  if (count) throw new Error('Profile has unfinished tasks; no maintenance is permitted');
  if (database.prepare('SELECT 1 FROM admission_fence LIMIT 1').get()) throw new Error('An existing one-way profile admission fence must remain intact');
  const { count: deliveries } = z.object({ count: z.number().int() }).parse(database.prepare("SELECT count(*) AS count FROM channel_deliveries WHERE state='queued'").get());
  if (deliveries) throw new Error('Profile has unfinished deliveries; no maintenance is permitted');
}

async function ownedFile(path: string): Promise<void> {
  const info = await lstat(path);
  const directory = await lstat(dirname(path));
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0
    || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
    throw new Error('Maintenance requires owner-private profile state');
}

export async function exerciseContext(store: TaskStore, summarize: CompactionCall,
  loaded: NonNullable<Awaited<ReturnType<typeof loadModelPolicy>>>, previousModule: string,
  continueContext: (messages: unknown) => Promise<string>): Promise<Record<string, unknown>> {
  const session = store.session('context-acceptance', 'direct', 'synthetic-continuity');
  if (store.db.prepare('SELECT 1 FROM session_messages LIMIT 1').get()) throw new Error('Acceptance database must be fresh');
  for (const prompt of [
    'Synthetic fixture: reference Ω-42. The report is weekly. Verify the original release source before completion. Delivery outcome is unknown.',
    'Correction: the report is monthly, not weekly. Keep the exact reference. Original-source verification remains unfinished and delivery remains unconfirmed.',
    'Retain the latest correction and unfinished verification. No external action has been performed.',
    'Continue only from the recorded evidence; do not assume the delivery succeeded.'
  ]) {
    const task = store.accept({ caller: session.caller, context: 'direct', sessionId: session.id, prompt,
      backend: 'codex', deadlineMs: Date.now() + 120000 });
    store.startQueued(task.id); store.finishWithAssistant(task.id, 'completed', 'Acknowledged historical fixture: ' + prompt);
  }
  const originals = store.db.prepare('SELECT * FROM session_messages ORDER BY sequence').all();
  const originalDigest = digest(originals);
  const manager = new ContextCheckpoints(store, summarize);
  const task = { id: 'preview:acceptance', session_id: session.id, caller: session.caller, context: 'direct', prompt: '' };
  const compacted = await manager.prepare(task, 'Current application authority is external to history.', [], loaded,
    AbortSignal.timeout(180000), { force: true, apply: true, expectedHead: null });
  if (!compacted.compacted) throw new Error('Acceptance did not publish a real checkpoint');
  const head = z.object({ active_checkpoint_id: z.string().min(1), valid: z.literal(true) }).parse(manager.status(session.id, session.caller, 'direct'));
  const { metadata_json } = z.object({ metadata_json: z.string() }).parse(store.db.prepare('SELECT metadata_json FROM emberfold_checkpoint_metadata WHERE checkpoint_id=?').get(head.active_checkpoint_id));
  const messages = z.array(z.object({ sequence: z.number(), role: z.enum(['user', 'assistant']), content: z.string() })).parse(originals)
    .map(row => ({ id: String(row.sequence), role: row.role, content: row.content }));
  const checkpoint = validateCheckpoint(JSON.parse(metadata_json) as unknown, messages, JSON.stringify([session.caller, 'direct', session.id]));
  const recovered = resolveSources(messages, checkpoint.source_message_ids);
  if (!recovered.length || recovered.some(row => !messages.some(message => message.id === row.id && message.content === row.content)))
    throw new Error('Source recovery failed');
  const { ContextCheckpoints: Previous } = previousReaderSchema.parse(await import(pathToFileURL(previousModule).href) as unknown);
  const previous = new Previous(store, summarize);
  if (previous.status(session.id, session.caller, 'direct').valid !== true) throw new Error('Previous-reader rollback failed');
  const prior = await previous.prepare(task, 'Current application authority is external to history.', [], loaded, AbortSignal.timeout(5000));
  if (digest(prior.messages) !== digest(compacted.messages)) throw new Error('Previous-reader context projection differs');
  const answer = JSON.parse(await continueContext(compacted.messages)) as unknown;
  z.object({ reference: z.literal('Ω-42'), schedule: z.literal('monthly'),
    verification: z.literal('pending'), delivery: z.literal('unknown') }).strict().parse(answer);
  store.db.prepare('UPDATE context_checkpoints SET summary_json=? WHERE id=?').run('{invalid', head.active_checkpoint_id);
  if (manager.status(session.id, session.caller, 'direct').valid !== false) throw new Error('Corruption was not detected');
  const rebuilt = await manager.prepare(task, 'Current application authority is external to history.', [], loaded,
    AbortSignal.timeout(180000), { force: true, apply: true, expectedHead: head.active_checkpoint_id });
  if (!rebuilt.compacted || manager.status(session.id, session.caller, 'direct').valid !== true) throw new Error('Original-source rebuild failed');
  if (digest(store.db.prepare('SELECT * FROM session_messages ORDER BY sequence').all()) !== originalDigest) throw new Error('Acceptance rewrote original messages');
  return { compacted: true, continued: true, recovered_sources: recovered.length, rebuilt: true,
    previous_reader: true, original_messages_unchanged: true, tools_disabled: true };
}

const requestSchema = z.object({ operation: z.enum(['inspect', 'backup', 'verify', 'accept', 'check']),
  profile_dir: z.string().min(1), work_dir: z.string().min(1), previous_module: z.string().min(1),
  expected_policy_sha256: z.string().regex(/^[a-f0-9]{64}$/), expected_config_sha256: z.string().regex(/^[a-f0-9]{64}$/), snapshot: snapshotSchema.optional() }).strict();

export async function contextMaintenance(input: unknown): Promise<Record<string, unknown>> {
  const request = requestSchema.parse(input);
  const databasePath = join(request.profile_dir, 'state/ardent.sqlite');
  await ownedFile(databasePath);
  const configBytes = await readFile(join(request.profile_dir, 'config.yaml'));
  if (createHash('sha256').update(configBytes).digest('hex') !== request.expected_config_sha256) throw new Error('Profile configuration does not match the adoption pin');
  const policy = await loadModelPolicy(request.profile_dir);
  if (!policy || policy.sha256 !== request.expected_policy_sha256 || !policy.policy.compaction.enabled) throw new Error('Active model policy does not match the adoption pin');
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (request.operation === 'inspect') {
      assertContextIdle(database);
      return { idle: true, snapshot: snapshotContext(database), policy_sha256: policy.sha256 };
    }
    if (request.operation === 'check') {
      assertContextIdle(database);
      if (await lstat(join(request.profile_dir, 'state/gateway.lock')).then(() => true, (error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }))
        throw new Error('Gateway execution lock remains after stopping; inspect the exact owner');
      const snapshot = snapshotSchema.parse(request.snapshot);
      verifyContextSnapshot(database, snapshot);
      for (const table of snapshot.tables.filter(table => table.unknown_only)) {
        const actual = rowsDigest(database, table.table, Number.MAX_SAFE_INTEGER, true);
        if (actual.count !== table.count) throw new Error('Uncertain work appeared while stopping the profile');
      }
      return { idle: true, originals_preserved: true, uncertain_effects_preserved: true };
    }
    if (request.operation === 'backup') {
      assertContextIdle(database);
      const destination = join(request.work_dir, 'original.sqlite');
      await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
      await database.backup(destination);
      const snapshot = snapshotContext(database);
      await writeFile(join(request.work_dir, 'original-snapshot.json'), JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
      for (const path of [destination, join(request.work_dir, 'original-snapshot.json'), request.work_dir]) {
        const file = await open(path, 'r');
        try { await file.sync(); } finally { await file.close(); }
      }
      return { backed_up: true, snapshot };
    }
    if (request.operation === 'verify') {
      verifyContextSnapshot(database, JSON.parse(await readFile(join(request.work_dir, 'original-snapshot.json'), 'utf8')) as unknown);
    }
  } finally { database.close(); }
  if (request.operation === 'verify') {
    const store = new TaskStore(databasePath);
    try {
      const forbidden: CompactionCall = async () => { throw new Error('Production validation must not call the model'); };
      const current = new ContextCheckpoints(store, forbidden);
      const { ContextCheckpoints: Previous } = previousReaderSchema.parse(await import(pathToFileURL(request.previous_module).href) as unknown);
      const previous = new Previous(store, forbidden);
      const sessions = z.array(z.object({ id: z.string(), caller: z.string(), context: z.enum(['direct', 'peer', 'scheduled']) })).max(10000)
        .parse(store.db.prepare('SELECT s.id,s.caller,s.context FROM sessions s JOIN context_checkpoint_heads h ON h.session_id=s.id').all());
      for (const session of sessions) {
        const status = current.status(session.id, session.caller, session.context);
        const prior = previous.status(session.id, session.caller, session.context);
        if (status.valid !== true || prior.valid !== true || status.active_checkpoint_id !== prior.active_checkpoint_id)
          throw new Error('A production checkpoint failed current or previous-reader validation');
      }
      return { originals_preserved: true, uncertain_effects_preserved: true, checkpoint_heads_verified: sessions.length };
    } finally { store.close(); }
  }
  const loaded = await loadConfig(request.profile_dir);
  if (loaded.revision !== request.expected_config_sha256) throw new Error('Profile configuration changed before model preparation');
  const env = { ...process.env, ...parse(await readFile(join(request.profile_dir, '.env'))) };
  const summarize: CompactionCall = (route, prompt, signal) => compactWithCodex(loaded.config.providers.codex.command,
    request.profile_dir, route.model, route.reasoning_effort, prompt, signal, env, loaded.config.providers.codex.auth_mode);
  const directory = join(request.work_dir, 'acceptance');
  await mkdir(directory, { mode: 0o700 });
  const store = new TaskStore(join(directory, 'state.sqlite'));
  try {
    const route = { backend: 'codex' as const, ...policy.policy.primary.codex };
    return await exerciseContext(store, summarize, policy, request.previous_module, messages => summarize(route,
      JSON.stringify({ task: 'From this history only, return JSON fields reference, schedule, verification (pending or complete), delivery (unknown or confirmed). Preserve the latest correction and uncertainty.', messages }), AbortSignal.timeout(180000)));
  } finally { store.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let bytes = '';
  for await (const chunk of process.stdin) {
    bytes += String(chunk);
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('Maintenance input exceeds limit');
  }
  console.log(JSON.stringify(await contextMaintenance(JSON.parse(bytes) as unknown)));
}
