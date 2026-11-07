import { createHash } from 'node:crypto';
import { constants, existsSync, mkdirSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9._-]{0,79}$/);
const jobId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/);
const timezone = z.string().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}, 'Unknown IANA timezone');
const cronSchedule = z.object({
  cron: z.string().min(9).max(100), timezone,
  missed_window: z.enum(['skip', 'catch_up']),
  catch_up_minutes: z.number().int().min(0).max(1440)
}).strict();
const intervalSchedule = z.object({
  kind: z.literal('interval'), every_minutes: z.number().int().min(1).max(1440),
  anchor_at: z.string().datetime({ offset: false }).refine(value => value.endsWith('Z'), 'Interval anchor must be UTC')
}).strict();
const definition = z.object({
  id: jobId,
  /** `external` marks a job retained for reference but owned by another scheduler. */
  owner: z.enum(['ardent', 'external']),
  enabled: z.boolean(),
  handler: identifier,
  schedule: z.union([cronSchedule, intervalSchedule]),
  input: z.unknown().optional(),
  delivery: z.object({ kind: z.enum(['none', 'telegram', 'mattermost']), target_ref: identifier.optional() }).strict(),
  policy: z.object({ max_attempts: z.number().int().min(1).max(5), retry_backoff_seconds: z.number().int().min(1).max(3600) }).strict()
}).strict();
export const JobDefinitionSchema = definition;
export type JobDefinition = z.infer<typeof definition>;
export const JobDefinitionsSchema = z.object({
  schema_version: z.literal(1), profile: identifier, revision: z.number().int().positive(),
  jobs: z.array(definition).max(100)
}).strict();
export type JobDefinitions = z.infer<typeof JobDefinitionsSchema>;

export type JobReceipt = { effect_status: 'none' | 'confirmed' | 'unknown'; evidence?: unknown };
export type JobResult = { state: 'completed' | 'retry' | 'failed' | 'unknown'; receipt: JobReceipt };
export type JobContext = { job: JobDefinition; input: unknown; window_key: string; scheduled_at: Date; now: Date; attempt: number; signal: AbortSignal;
  /** Aborts when the scheduler stops admitting work; a handler must not claim new delivery rows after it fires. */
  stopping?: AbortSignal };
export type JobHandler = { input: z.ZodType<unknown>; delivery?: z.ZodType<unknown>;
  effect: 'none' | 'external'; run(ctx: JobContext): Promise<JobResult> };
export type JobRegistry = Record<string, JobHandler>;
export type OwnershipCheck = (job: JobDefinition, now: Date) => Promise<void>;

const rowSchema = z.object({ window_key: z.string(), job_id: z.string(), local_key: z.string(),
  scheduled_ms: z.number().int(), definition_revision: z.number().int(), definition_sha256: z.string(),
  state: z.enum(['queued', 'running', 'retry', 'completed', 'failed', 'unknown', 'superseded']),
  attempts: z.number().int(), next_attempt_ms: z.number().int(), receipt_json: z.string().nullable(),
  receipt_sha256: z.string().nullable(), error: z.string().nullable(), updated_ms: z.number().int() });
export type JobWindow = z.infer<typeof rowSchema>;
export type JobWindowStatus = Omit<JobWindow, 'receipt_json' | 'error'> & { error: string | null };

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function encode(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > 32768) throw new Error('Job receipt exceeds 32 KiB or is not JSON');
  return encoded;
}
type CronField = ReadonlySet<number>;
type Cron = { minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField; anyDay: boolean; anyWeekday: boolean };
function cronField(source: string, min: number, max: number): CronField {
  const values = new Set<number>();
  for (const part of source.split(',')) {
    const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw new Error(`Invalid cron field: ${source}`);
    const step = match[2] ? Number(match[2]) : 1;
    if (step < 1 || step > max - min + 1) throw new Error(`Invalid cron step: ${source}`);
    const range = match[1]!;
    const [start, end] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number)
      : [Number(range), match[2] ? max : Number(range)];
    if (start === undefined || end === undefined || start < min || end > max || start > end) throw new Error(`Invalid cron range: ${source}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (!values.size) throw new Error(`Empty cron field: ${source}`);
  return values;
}
function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Job cron must contain five fields');
  const minute = fields[0]!; const hour = fields[1]!; const day = fields[2]!;
  const month = fields[3]!; const weekday = fields[4]!;
  return { minute: cronField(minute, 0, 59), hour: cronField(hour, 0, 23), day: cronField(day, 1, 31),
    month: cronField(month, 1, 12), weekday: cronField(weekday, 0, 6), anyDay: day === '*', anyWeekday: weekday === '*' };
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(at: Date, zone: string): { key: string; minute: number; hour: number; day: number; month: number; weekday: number } {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(at).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const week = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  if (week < 0) throw new Error('Failed to derive local weekday');
  return { key: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`, minute: Number(parts.minute),
    hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: week };
}
function matches(cron: Cron, local: ReturnType<typeof localParts>): boolean {
  const dayMatches = cron.day.has(local.day);
  const weekdayMatches = cron.weekday.has(local.weekday);
  const calendarMatches = cron.anyDay && cron.anyWeekday ? true : cron.anyDay ? weekdayMatches : cron.anyWeekday ? dayMatches : dayMatches || weekdayMatches;
  return cron.minute.has(local.minute) && cron.hour.has(local.hour) && cron.month.has(local.month) && calendarMatches;
}

/** Validates all data before it can be selected. Definitions are data, never executable code. */
export function validateJobDefinitions(raw: unknown, registry: JobRegistry, expectedProfile?: string): { definitions: JobDefinitions; sha256: string; job_count: number } {
  const definitions = JobDefinitionsSchema.parse(raw);
  if (expectedProfile && definitions.profile !== expectedProfile) throw new Error('Job definition profile differs from selected profile');
  const ids = new Set<string>();
  for (const job of definitions.jobs) {
    if (ids.has(job.id)) throw new Error(`Duplicate job ID ${job.id}`);
    ids.add(job.id);
    if (!('kind' in job.schedule)) {
      parseCron(job.schedule.cron);
      if (job.schedule.missed_window === 'skip' && job.schedule.catch_up_minutes !== 0) throw new Error(`Skip job ${job.id} has a catch-up horizon`);
      if (job.schedule.missed_window === 'catch_up' && job.schedule.catch_up_minutes < 1) throw new Error(`Catch-up job ${job.id} needs a horizon`);
    }
    if (job.delivery.kind === 'none' && job.delivery.target_ref) throw new Error(`No-delivery job ${job.id} has a target`);
    if (job.delivery.kind !== 'none' && !job.delivery.target_ref) throw new Error(`Delivery job ${job.id} lacks a target reference`);
    const handler = registry[job.handler];
    if (!handler) throw new Error(`Unknown job handler ${job.handler}`);
    handler.input.parse(job.input);
    if (handler.delivery) handler.delivery.parse(job.delivery);
    else if (job.delivery.kind !== 'none') throw new Error(`Job handler ${job.handler} does not support delivery`);
  }
  return { definitions, sha256: sha256(JSON.stringify(definitions)), job_count: definitions.jobs.length };
}

/** A profile-local SQLite scheduler. No work is admitted without a fresh ownership check. */
export class JobEngine {
  #lastValidationError: string | null = null;
  #lastActive: { revision: number; sha256: string } | null = null;
  #busy = false;
  /** `clock` measures elapsed time within a tick; the injected tick time stays the timeline origin. */
  constructor(readonly db: Database.Database, readonly profileDir: string, readonly profile: string,
    readonly registry: JobRegistry, readonly ownershipCheck: OwnershipCheck, readonly clock: () => number = () => Date.now()) {
    identifier.parse(profile);
    mkdirSync(join(profileDir, 'state', 'job-definition-releases'), { recursive: true, mode: 0o700 });
    db.exec(`CREATE TABLE IF NOT EXISTS job_windows (
      window_key TEXT PRIMARY KEY, job_id TEXT NOT NULL, local_key TEXT NOT NULL, scheduled_ms INTEGER NOT NULL,
      definition_revision INTEGER NOT NULL, definition_sha256 TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_ms INTEGER NOT NULL,
      receipt_json TEXT, receipt_sha256 TEXT, error TEXT, updated_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS job_windows_due ON job_windows(state,next_attempt_ms);
      CREATE TABLE IF NOT EXISTS job_attempts (
        window_key TEXT NOT NULL REFERENCES job_windows(window_key), attempt INTEGER NOT NULL,
        state TEXT NOT NULL, receipt_json TEXT NOT NULL, receipt_sha256 TEXT NOT NULL,
        recorded_ms INTEGER NOT NULL, PRIMARY KEY(window_key,attempt));
      CREATE TABLE IF NOT EXISTS job_scan (
        job_id TEXT PRIMARY KEY, scanned_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
        definition_revision INTEGER NOT NULL DEFAULT 0, definition_sha256 TEXT NOT NULL DEFAULT '');`);
    // Profiles installed before scan binding retain their timestamps, but they
    // cannot claim current-definition coverage until the next scheduler tick.
    const scanColumns = new Set(this.db.prepare('PRAGMA table_info(job_scan)').all().map(row =>
      z.object({ name: z.string() }).parse(row).name));
    if (!scanColumns.has('definition_revision')) db.exec('ALTER TABLE job_scan ADD COLUMN definition_revision INTEGER NOT NULL DEFAULT 0');
    if (!scanColumns.has('definition_sha256')) db.exec("ALTER TABLE job_scan ADD COLUMN definition_sha256 TEXT NOT NULL DEFAULT ''");
  }
  async load(): Promise<{ definitions: JobDefinitions; sha256: string; job_count: number }> {
    try {
      const file = await readFile(join(this.profileDir, 'jobs', 'active.json'), 'utf8');
      const raw = JSON.parse(file) as unknown;
      const parsed = validateJobDefinitions(raw, this.registry, this.profile);
      const fileSha256 = sha256(file);
      this.#lastActive = { revision: parsed.definitions.revision, sha256: fileSha256 };
      this.#lastValidationError = null;
      return { ...parsed, sha256: fileSha256 };
    } catch (error) {
      this.#lastActive = null;
      // JSON parser diagnostics can quote configuration content, including secret references.
      this.#lastValidationError = error instanceof SyntaxError ? 'Job definitions contain invalid JSON'
        : error instanceof z.ZodError ? 'Job definitions failed schema validation'
          : error instanceof Error ? error.message.replace(/[\r\n]/g, ' ').slice(0, 200) : 'Invalid job definitions';
      throw error;
    }
  }
  recover(now = new Date()): number {
    // An interrupted handler may have sent an external effect. It is never replayed automatically.
    return this.db.transaction(() => {
      const running = this.db.prepare("SELECT * FROM job_windows WHERE state='running'").all().map(row => rowSchema.parse(row));
      for (const window of running) {
        const receipt = encode({ effect_status: 'unknown', evidence: 'interrupted during handler execution' } satisfies JobReceipt);
        this.db.prepare('INSERT OR IGNORE INTO job_attempts(window_key,attempt,state,receipt_json,receipt_sha256,recorded_ms) VALUES (?,?,?,?,?,?)')
          .run(window.window_key, window.attempts, 'unknown', receipt, sha256(receipt), now.getTime());
        this.db.prepare("UPDATE job_windows SET state='unknown',receipt_json=?,receipt_sha256=?,error='interrupted during handler execution',updated_ms=? WHERE window_key=? AND state='running'")
          .run(receipt, sha256(receipt), now.getTime(), window.window_key);
      }
      return running.length;
    })();
  }
  /** Startup reconciliation requires the gateway's exclusive profile lock. */
  async recoverAfterRestart(now = new Date()): Promise<number> {
    const markerPath = this.#tickMarker();
    let markerFile: Awaited<ReturnType<typeof open>> | undefined;
    try {
      markerFile = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return this.recover(now);
      throw error;
    }
    let marker: { pid: number; started_at: string };
    try {
      const stat = await markerFile.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512) throw new Error('Job tick marker is invalid');
      marker = z.object({ pid: z.number().int().positive(), started_at: z.string().datetime({ offset: true }) }).strict()
        .parse(JSON.parse(await markerFile.readFile({ encoding: 'utf8' })) as unknown);
    } catch { throw new Error('Job tick marker is malformed; inspect before clearing'); }
    finally { await markerFile.close(); }
    try {
      process.kill(marker.pid, 0);
      throw new Error(`Job tick marker belongs to live PID ${marker.pid}; do not recover concurrently`);
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error;
    }
    const recovered = this.recover(now);
    await unlink(markerPath);
    return recovered;
  }
  async status(limit = 50, now = new Date()): Promise<{ active_revision: number | null; active_sha256: string | null; last_validation_error: string | null;
    active_jobs: number; unknown_jobs: number; counts: Record<string, number>; jobs: Array<{ job_id: string; next_window: string | null;
      last_window: string | null; counts: Record<string, number> }>; windows: JobWindowStatus[] }> {
    let active: JobDefinitions | null = null;
    try { active = (await this.load()).definitions; } catch { /* Invalid definitions are reported and cannot execute. */ }
    const counts = Object.fromEntries(this.db.prepare('SELECT state,count(*) AS count FROM job_windows GROUP BY state').all()
      .map(row => { const value = z.object({ state: z.string(), count: z.number().int() }).parse(row); return [value.state, value.count]; }));
    const windows = this.db.prepare('SELECT * FROM job_windows ORDER BY scheduled_ms DESC,job_id LIMIT ?').all(Math.max(1, Math.min(limit, 100)))
      .map(row => { const { receipt_json: _receipt, error, ...rest } = rowSchema.parse(row);
        return { ...rest, error: error?.slice(0, 200) ?? null }; });
    const jobs = (active?.jobs ?? []).map(job => {
      const localCounts = Object.fromEntries(this.db.prepare('SELECT state,count(*) AS count FROM job_windows WHERE job_id=? GROUP BY state').all(job.id)
        .map(row => { const value = z.object({ state: z.string(), count: z.number().int() }).parse(row); return [value.state, value.count]; }));
      const last = this.db.prepare('SELECT local_key FROM job_windows WHERE job_id=? ORDER BY scheduled_ms DESC LIMIT 1').get(job.id);
      const lastKey = last ? z.object({ local_key: z.string() }).parse(last).local_key : null;
      return { job_id: job.id, next_window: this.#nextWindow(job, now), last_window: lastKey, counts: localCounts };
    });
    return { active_revision: this.#lastActive?.revision ?? null, active_sha256: this.#lastActive?.sha256 ?? null,
      last_validation_error: this.#lastValidationError, active_jobs: (counts.queued ?? 0) + (counts.running ?? 0) + (counts.retry ?? 0),
      unknown_jobs: counts.unknown ?? 0, counts, jobs, windows };
  }
  #nextWindow(job: JobDefinition, now: Date): string | null {
    if (!job.enabled || job.owner !== 'ardent') return null;
    if ('kind' in job.schedule) {
      const due = this.#intervalDue(job);
      return due === null ? null : new Date(due).toISOString();
    }
    const cron = parseCron(job.schedule.cron);
    const start = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
    for (let at = start; at < start + 32 * 24 * 60 * 60_000; at += 60_000) {
      const local = localParts(new Date(at), job.schedule.timezone);
      if (matches(cron, local)) return `${local.key}@${job.schedule.timezone}`;
    }
    return null;
  }
  #intervalDue(job: JobDefinition): number | null {
    const schedule = job.schedule;
    if (!('kind' in schedule)) throw new Error('Interval schedule required');
    const intervalMs = schedule.every_minutes * 60_000;
    const anchorMs = Date.parse(schedule.anchor_at);
    const last = this.db.prepare('SELECT * FROM job_windows WHERE job_id=? ORDER BY scheduled_ms DESC,rowid DESC LIMIT 1')
      .get(job.id);
    if (!last) return anchorMs + intervalMs;
    const window = rowSchema.parse(last);
    // A pending, failed, or unknown window is a one-owner hold. A definition
    // swap can supersede an unstarted window and re-anchor from that decision.
    if (window.state === 'completed') return window.updated_ms + intervalMs;
    if (window.state === 'superseded') return Math.max(anchorMs, window.updated_ms) + intervalMs;
    return null;
  }
  /**
   * `now` selects which windows are due. Ownership checks, claims, receipts and
   * retry backoff use a fresh instant on the same timeline. `signal` aborts
   * running handlers; `stopping` only prevents new claims.
   */
  async tick(now = new Date(), signal: AbortSignal = AbortSignal.timeout(50_000), stopping?: AbortSignal): Promise<{ scanned: number; claimed: number; completed: number; retry: number; unknown: number }> {
    if (this.#busy) return { scanned: 0, claimed: 0, completed: 0, retry: 0, unknown: 0 };
    this.#busy = true;
    const clockStart = this.clock();
    const current = () => new Date(now.getTime() + Math.max(0, this.clock() - clockStart));
    const stopClaims = stopping ? AbortSignal.any([signal, stopping]) : signal;
    const tickMarker = this.#tickMarker();
    let marker: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // The release helper holds .release.lock while it waits for this marker to
      // disappear. Creating our marker before checking its lock closes the race
      // between preflight and a definition swap.
      marker = await open(tickMarker, 'wx', 0o600).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
          throw new Error('Job tick marker already exists; inspect and reconcile before proceeding');
        throw error;
      });
      await marker.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      const { definitions, sha256: definitionSha256 } = await this.load();
      if (this.#releaseLocked()) throw new Error('Job-definition release lock is held');
      if (this.#admissionFenced()) throw new Error('Profile admission is fenced');
      let scanned = 0; let claimed = 0; let completed = 0; let retry = 0; let unknown = 0;
      for (const job of definitions.jobs) {
        if (!job.enabled || job.owner !== 'ardent') continue;
        const nowMinute = Math.floor(now.getTime() / 60_000) * 60_000;
        const candidates: Array<{ key: string; local: string; scheduled: number }> = [];
        if ('kind' in job.schedule) {
          scanned++;
          const due = this.#intervalDue(job);
          if (due !== null && due <= now.getTime()) {
            const local = new Date(due).toISOString();
            candidates.push({ key: `${job.id}:interval:${due}`, local, scheduled: due });
          }
        } else {
          const cron = parseCron(job.schedule.cron);
          const previous = this.db.prepare('SELECT scanned_ms FROM job_scan WHERE job_id=?').get(job.id);
          const priorMs = previous ? z.object({ scanned_ms: z.number().int() }).parse(previous).scanned_ms : nowMinute - 60_000;
          const horizonMs = job.schedule.catch_up_minutes * 60_000;
          const start = job.schedule.missed_window === 'skip' ? nowMinute - 60_000 : Math.max(priorMs, nowMinute - horizonMs - 60_000);
          for (let minuteMs = Math.floor(start / 60_000) * 60_000 + 60_000; minuteMs <= nowMinute; minuteMs += 60_000) {
            const local = localParts(new Date(minuteMs), job.schedule.timezone);
            scanned++;
            if (matches(cron, local)) candidates.push({ key: `${job.id}:${local.key}@${job.schedule.timezone}`, local: local.key, scheduled: minuteMs });
          }
        }
        if (candidates.length) await this.ownershipCheck(job, current());
        if (this.#releaseLocked()) throw new Error('Job-definition release lock is held');
        if (this.#admissionFenced()) throw new Error('Profile admission is fenced');
        this.db.transaction(() => {
          for (const item of candidates) {
            const result = this.db.prepare(`INSERT OR IGNORE INTO job_windows
              (window_key,job_id,local_key,scheduled_ms,definition_revision,definition_sha256,state,attempts,next_attempt_ms,receipt_json,receipt_sha256,error,updated_ms)
              VALUES (?,?,?,?,?,?,'queued',0,?,NULL,NULL,NULL,?)`).run(item.key, job.id, item.local, item.scheduled,
              definitions.revision, definitionSha256, now.getTime(), now.getTime());
            claimed += result.changes;
          }
          this.db.prepare(`INSERT INTO job_scan(job_id,scanned_ms,updated_ms,definition_revision,definition_sha256)
            VALUES (?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET scanned_ms=excluded.scanned_ms,
            updated_ms=excluded.updated_ms,definition_revision=excluded.definition_revision,
            definition_sha256=excluded.definition_sha256`)
            .run(job.id, nowMinute, now.getTime(), definitions.revision, definitionSha256);
        })();
        const due = this.db.prepare("SELECT * FROM job_windows WHERE job_id=? AND state IN ('queued','retry') AND next_attempt_ms<=? ORDER BY scheduled_ms LIMIT 100")
          .all(job.id, now.getTime()).map(row => rowSchema.parse(row));
        for (const window of due) {
          if (stopClaims.aborted) break;
          if (window.definition_sha256 !== definitionSha256) {
            this.db.prepare("UPDATE job_windows SET state='superseded',error='active definition changed before execution',updated_ms=? WHERE window_key=? AND state IN ('queued','retry')")
              .run(current().getTime(), window.window_key);
            continue;
          }
          await this.ownershipCheck(job, current());
          if (this.#releaseLocked()) throw new Error('Job-definition release lock is held');
          if (this.#admissionFenced()) throw new Error('Profile admission is fenced');
          if (stopClaims.aborted) break;
          const claimedAt = current();
          const update = this.db.prepare("UPDATE job_windows SET state='running',attempts=attempts+1,updated_ms=? WHERE window_key=? AND state IN ('queued','retry')")
            .run(claimedAt.getTime(), window.window_key);
          if (!update.changes) continue;
          const attempt = window.attempts + 1;
          const result = await this.#run(job, window, attempt, claimedAt, signal, stopClaims);
          const finishedMs = current().getTime();
          // Interval cadence is measured from a completed window's updated_ms;
          // anchor it at the claim so a handler's run time does not drift the
          // schedule. Failed, unknown and retry rows record when they ended.
          const settledMs = result.state === 'completed' ? claimedAt.getTime() : finishedMs;
          const receiptJson = encode(result.receipt);
          const receiptSha = sha256(receiptJson);
          const canRetry = result.state === 'retry' && result.receipt.effect_status === 'none' && attempt < job.policy.max_attempts;
          const state = result.state === 'retry' ? canRetry ? 'retry' : result.receipt.effect_status === 'none' ? 'failed' : 'unknown' : result.state;
          const delay = job.policy.retry_backoff_seconds * 1000 * Math.pow(2, attempt - 1);
          this.db.transaction(() => {
            this.db.prepare('INSERT INTO job_attempts(window_key,attempt,state,receipt_json,receipt_sha256,recorded_ms) VALUES (?,?,?,?,?,?)')
              .run(window.window_key, attempt, state, receiptJson, receiptSha, finishedMs);
            this.db.prepare('UPDATE job_windows SET state=?,next_attempt_ms=?,receipt_json=?,receipt_sha256=?,error=?,updated_ms=? WHERE window_key=? AND state=\'running\'')
              .run(state, canRetry ? finishedMs + delay : settledMs, receiptJson, receiptSha,
                state === 'failed' ? 'handler failed or retry budget exhausted' : state === 'unknown' ? 'effect outcome unknown' : null,
                settledMs, window.window_key);
          })();
          if (state === 'completed') completed++; else if (state === 'retry') retry++; else if (state === 'unknown') unknown++;
        }
      }
      return { scanned, claimed, completed, retry, unknown };
    } finally {
      // A marker cleanup failure must not wedge the scheduler; the marker
      // itself still fails closed on the next tick or restart.
      try {
        if (marker) {
          try { await marker.close(); }
          finally { await unlink(tickMarker); }
        }
      } finally { this.#busy = false; }
    }
  }
  #admissionFenced(): boolean {
    try { return Boolean(this.db.prepare('SELECT 1 FROM admission_fence WHERE singleton=1').get()); }
    catch { return true; }
  }
  #releaseLocked(): boolean { return existsSync(join(this.profileDir, 'state', 'job-definition-releases', '.release.lock')); }
  #tickMarker(): string { return join(this.profileDir, 'state', 'job-definition-releases', '.tick.lock'); }
  async #run(job: JobDefinition, window: JobWindow, attempt: number, now: Date, signal: AbortSignal, stopping: AbortSignal): Promise<JobResult> {
    const handler = this.registry[job.handler];
    if (!handler) return { state: 'unknown', receipt: { effect_status: 'unknown', evidence: 'handler disappeared' } };
    try {
      if (signal.aborted) throw new Error('Job handler aborted');
      const invocation = handler.run({ job, input: handler.input.parse(job.input), window_key: window.window_key,
        scheduled_at: new Date(window.scheduled_ms), now, attempt, signal, stopping });
      const result = await new Promise<JobResult>((resolve, reject) => {
        const aborted = () => reject(new Error('Job handler aborted'));
        signal.addEventListener('abort', aborted, { once: true });
        void invocation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted)).catch(() => {});
      });
      if (!['completed', 'retry', 'failed', 'unknown'].includes(result.state) ||
        !['none', 'confirmed', 'unknown'].includes(result.receipt.effect_status)) throw new Error('Invalid handler receipt');
      if (result.state === 'retry' && result.receipt.effect_status !== 'none')
        return { state: 'unknown', receipt: { effect_status: 'unknown', evidence: 'retry requested without no-effect proof' } };
      return result;
    } catch (error) {
      const ambiguous = signal.aborted || handler.effect === 'external';
      return { state: ambiguous ? 'unknown' : 'retry',
        receipt: { effect_status: ambiguous ? 'unknown' : 'none',
          evidence: error instanceof Error ? error.message.slice(0, 500) : 'handler error' } };
    }
  }
}
