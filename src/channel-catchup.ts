import { z } from 'zod';
import type Database from './sqlite.js';

/** Why part of a channel's history was not walked: the walk bound was reached, or the server no longer holds it. */
export type CatchupGapReason = 'walk_bound' | 'retention';
export type CatchupRunState = 'catching_up' | 'complete' | 'gap' | 'interrupted';
export type CatchupCounters = { recovered: number; skipped_stale: number; already_claimed: number; pages: number };
export const CatchupStatusSchema = z.object({
  account: z.string(), channel: z.string(),
  state: z.enum(['idle', 'catching_up', 'complete', 'gap']),
  recovered: z.number().int(), skipped_stale: z.number().int(), already_claimed: z.number().int(), pages: z.number().int(),
  started_ms: z.number().int().nullable(), finished_ms: z.number().int().nullable(),
  gaps: z.number().int(),
  last_gap: z.object({ from_ms: z.number().int(), to_ms: z.number().int(), reason: z.enum(['walk_bound', 'retention']), detected_ms: z.number().int() }).nullable()
});
export type CatchupStatus = z.infer<typeof CatchupStatusSchema>;
const GapRow = z.object({ from_ms: z.number().int(), to_ms: z.number().int(), reason: z.enum(['walk_bound', 'retention']), detected_ms: z.number().int() });
const RunRow = z.object({ account: z.string(), channel: z.string(), state: z.enum(['catching_up', 'complete', 'gap', 'interrupted']),
  recovered: z.number().int(), skipped_stale: z.number().int(), already_claimed: z.number().int(), pages: z.number().int(),
  started_ms: z.number().int(), finished_ms: z.number().int().nullable() });
/** Finished runs kept per channel; older ones are pruned. */
const RUNS_KEPT = 100;

/**
 * Durable record of channel catch-up walks: one row per walk that found work,
 * and one row per permanent gap. Gaps are facts about history, never retried.
 */
export class CatchupJournal {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS channel_catchup_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, account TEXT NOT NULL, channel TEXT NOT NULL,
        from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('walk_bound','retention')),
        detected_ms INTEGER NOT NULL, UNIQUE(platform, account, channel, from_ms, reason));
      CREATE TABLE IF NOT EXISTS channel_catchup_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, account TEXT NOT NULL, channel TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK(trigger IN ('connect','timer')),
        state TEXT NOT NULL CHECK(state IN ('catching_up','complete','gap','interrupted')),
        started_ms INTEGER NOT NULL, finished_ms INTEGER,
        recovered INTEGER NOT NULL DEFAULT 0, skipped_stale INTEGER NOT NULL DEFAULT 0,
        already_claimed INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
        gap TEXT CHECK(gap IS NULL OR gap IN ('walk_bound','retention')));
      CREATE INDEX IF NOT EXISTS channel_catchup_runs_channel ON channel_catchup_runs(platform, account, channel, id);`);
    this.#migrateReconcileGaps();
  }
  /** Ardent 3.1 recorded an over-long reconcile window as an unread `…:reconcile_gap` cursor. Move each into the gap table once. */
  #migrateReconcileGaps(): void {
    const rows = z.array(z.object({ key: z.string(), value: z.string(), updated_ms: z.number().int() }))
      .parse(this.db.prepare("SELECT key,value,updated_ms FROM channel_cursors WHERE key LIKE 'mattermost:%:%:reconcile_gap'").all());
    if (!rows.length) return;
    this.db.transaction(() => {
      for (const row of rows) {
        const [, account, channel] = row.key.split(':');
        const range = /^(\d+):(\d+)$/.exec(row.value);
        if (account && channel && range) this.recordGap('mattermost', account, channel, Number(range[1]), Number(range[2]), 'walk_bound', row.updated_ms);
        this.db.prepare('DELETE FROM channel_cursors WHERE key=?').run(row.key);
      }
    })();
  }
  /** Records a permanent gap once; detecting the same gap again changes nothing. */
  recordGap(platform: string, account: string, channel: string, fromMs: number, toMs: number, reason: CatchupGapReason, detectedMs = Date.now()): void {
    this.db.prepare(`INSERT INTO channel_catchup_gaps(platform,account,channel,from_ms,to_ms,reason,detected_ms) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(platform,account,channel,from_ms,reason) DO NOTHING`).run(platform, account, channel, fromMs, Math.max(fromMs, toMs), reason, detectedMs);
  }
  gaps(platform: string, account: string, channel: string): z.infer<typeof GapRow>[] {
    return z.array(GapRow).parse(this.db.prepare('SELECT from_ms,to_ms,reason,detected_ms FROM channel_catchup_gaps WHERE platform=? AND account=? AND channel=? ORDER BY id').all(platform, account, channel));
  }
  startRun(platform: string, account: string, channel: string, trigger: 'connect' | 'timer', pages: number): number {
    const result = this.db.prepare(`INSERT INTO channel_catchup_runs(platform,account,channel,trigger,state,started_ms,pages) VALUES (?,?,?,?,'catching_up',?,?)`)
      .run(platform, account, channel, trigger, Date.now(), pages);
    return Number(result.lastInsertRowid);
  }
  updateRun(id: number, counters: CatchupCounters): void {
    this.db.prepare('UPDATE channel_catchup_runs SET recovered=?,skipped_stale=?,already_claimed=?,pages=? WHERE id=?')
      .run(counters.recovered, counters.skipped_stale, counters.already_claimed, counters.pages, id);
  }
  finishRun(id: number, counters: CatchupCounters, state: Exclude<CatchupRunState, 'catching_up'>, gap: CatchupGapReason | null): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE channel_catchup_runs SET recovered=?,skipped_stale=?,already_claimed=?,pages=?,state=?,gap=?,finished_ms=? WHERE id=?')
        .run(counters.recovered, counters.skipped_stale, counters.already_claimed, counters.pages, state, gap, Date.now(), id);
      this.db.prepare(`DELETE FROM channel_catchup_runs WHERE id IN (SELECT r.id FROM channel_catchup_runs r JOIN channel_catchup_runs c
        ON c.platform=r.platform AND c.account=r.account AND c.channel=r.channel WHERE c.id=? AND r.finished_ms IS NOT NULL
        ORDER BY r.id DESC LIMIT -1 OFFSET ?)`).run(id, RUNS_KEPT);
    })();
  }
  /** A walk that a stopped process left open is closed as interrupted; the next walk resumes from the saved boundary. */
  closeOpenRuns(platform: string, account: string): void {
    this.db.prepare("UPDATE channel_catchup_runs SET state='interrupted',finished_ms=? WHERE platform=? AND account=? AND finished_ms IS NULL").run(Date.now(), platform, account);
  }
  /** Latest walk per channel with a saved boundary or a recorded walk. A channel never walked with work is `idle`. */
  status(platform: string, limit = 200): CatchupStatus[] {
    const channels = new Map<string, { account: string; channel: string }>();
    const keys = z.array(z.object({ key: z.string() })).parse(this.db.prepare(`SELECT key FROM channel_cursors WHERE key LIKE ? OR key LIKE ? ORDER BY key LIMIT ?`)
      .all(`${platform}:%:%:last`, `${platform}:%:%:last_ms`, limit * 2));
    for (const { key } of keys) {
      const parts = key.split(':');
      if (parts.length === 4 && parts[1] && parts[2]) channels.set(`${parts[1]}:${parts[2]}`, { account: parts[1], channel: parts[2] });
    }
    const runs = z.array(RunRow).parse(this.db.prepare(`SELECT account,channel,state,recovered,skipped_stale,already_claimed,pages,started_ms,finished_ms
      FROM channel_catchup_runs WHERE id IN (SELECT max(id) FROM channel_catchup_runs WHERE platform=? GROUP BY account,channel)`).all(platform));
    const latest = new Map(runs.map(run => [`${run.account}:${run.channel}`, run]));
    for (const run of runs) channels.set(`${run.account}:${run.channel}`, { account: run.account, channel: run.channel });
    return [...channels.values()].slice(0, limit).map(({ account, channel }) => {
      const run = latest.get(`${account}:${channel}`);
      const gaps = this.gaps(platform, account, channel);
      return { account, channel, state: !run || run.state === 'interrupted' ? 'idle' : run.state,
        recovered: run?.recovered ?? 0, skipped_stale: run?.skipped_stale ?? 0, already_claimed: run?.already_claimed ?? 0, pages: run?.pages ?? 0,
        started_ms: run?.started_ms ?? null, finished_ms: run?.finished_ms ?? null, gaps: gaps.length, last_gap: gaps.at(-1) ?? null };
    });
  }
}
