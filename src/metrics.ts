import { z } from 'zod';
import type { TaskStore } from './store.js';

/** The OpenMetrics text format's media type. */
export const OPENMETRICS_CONTENT_TYPE = 'application/openmetrics-text; version=1.0.0; charset=utf-8';

type Labels = Readonly<Record<string, string>>;
const labelKey = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

/**
 * In-process counters of things the journal does not record, such as A2A
 * rate-limit refusals. They start at zero when the process starts.
 */
export class RuntimeCounters {
  readonly #counts = new Map<string, Map<string, { labels: Labels; value: number }>>();
  increment(name: string, labels: Labels = {}, by = 1): void {
    const series = this.#counts.get(name) ?? new Map<string, { labels: Labels; value: number }>();
    const key = labelKey(labels);
    const entry = series.get(key) ?? { labels, value: 0 };
    entry.value += by;
    series.set(key, entry);
    this.#counts.set(name, series);
  }
  value(name: string, labels: Labels = {}): number { return this.#counts.get(name)?.get(labelKey(labels))?.value ?? 0; }
  series(name: string): Array<{ labels: Labels; value: number }> { return [...this.#counts.get(name)?.values() ?? []]; }
}

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const sample = (name: string, labels: Labels, value: number) => {
  const entries = Object.entries(labels);
  return `${name}${entries.length ? `{${entries.map(([key, label]) => `${key}="${escapeLabel(label)}"`).join(',')}}` : ''} ${Number.isFinite(value) ? value : 0}`;
};

/** A2A rate-limit refusal scopes: by client address, per peer, and the per-peer task cap. */
export const A2A_REFUSAL_SCOPES = ['ip', 'peer', 'tasks'] as const;

export interface MetricsSource {
  readonly version: string;
  readonly profile: string;
  readonly backend: string;
  readonly store: TaskStore;
  readonly counters: RuntimeCounters;
  readonly startedMs: number;
  readonly now?: () => number;
}

/**
 * The profile's metrics in the OpenMetrics text format. Gauges are read from
 * the journal at scrape time; counters are this process's own.
 */
export function renderMetrics(source: MetricsSource): string {
  const now = source.now?.() ?? Date.now();
  const lines: string[] = [];
  const family = (name: string, type: 'gauge' | 'counter' | 'info', help: string, samples: Array<{ labels?: Labels; value: number; suffix?: string }>) => {
    lines.push(`# TYPE ${name} ${type}`, `# HELP ${name} ${help}`);
    for (const item of samples) lines.push(sample(`${name}${item.suffix ?? ''}`, item.labels ?? {}, item.value));
  };
  const db = source.store.db;
  const tables = new Set(z.array(z.object({ name: z.string() })).parse(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).map(row => row.name));
  /** Rows per state of a journal table; a table this profile never created (no jobs, no A2A) counts nothing. */
  const counts = (table: string) => tables.has(table)
    ? z.array(z.object({ key: z.string(), count: z.number().int() })).parse(db.prepare(`SELECT state AS key, count(*) AS count FROM ${table} GROUP BY state`).all()) : [];

  family('ardent_build', 'info', 'Ardent version, profile and selected backend', [{ labels: { version: source.version, profile: source.profile, backend: source.backend }, value: 1, suffix: '_info' }]);
  family('ardent_process_start_time_seconds', 'gauge', 'When this gateway process started (Unix time)', [{ value: source.startedMs / 1000 }]);

  const tasks = source.store.taskCounts();
  const states = ['queued', 'running', 'input_required', 'completed', 'partial', 'failed', 'cancelled', 'unknown'];
  family('ardent_tasks', 'gauge', 'Tasks in the journal, by state', states.map(state => ({ labels: { state }, value: tasks.by_state[state] ?? 0 })));

  const recovery = source.store.executionState.counts();
  family('ardent_recovery_tasks', 'gauge', 'Tasks in each open execution recovery status', Object.entries(recovery).map(([status, value]) => ({ labels: { status }, value })));

  const windows = counts('job_windows');
  family('ardent_job_windows', 'gauge', 'Scheduled job windows in the journal, by state', ['queued', 'running', 'retry', 'completed', 'failed', 'unknown', 'superseded']
    .map(state => ({ labels: { state }, value: windows.find(row => row.key === state)?.count ?? 0 })));

  const deliveries = counts('channel_deliveries');
  family('ardent_channel_deliveries', 'gauge', 'Channel replies in the journal, by delivery state', ['queued', 'sent', 'failed', 'unknown']
    .map(state => ({ labels: { state }, value: deliveries.find(row => row.key === state)?.count ?? 0 })));

  const push = counts('a2a_push_deliveries');
  family('ardent_a2a_push_deliveries', 'gauge', 'A2A push notifications in the journal, by delivery state', ['queued', 'sent', 'failed', 'unknown']
    .map(state => ({ labels: { state }, value: push.find(row => row.key === state)?.count ?? 0 })));

  family('ardent_a2a_rate_limited', 'counter', 'A2A requests refused with 429 since the process started, by limit', A2A_REFUSAL_SCOPES
    .map(scope => ({ labels: { scope }, value: source.counters.value('a2a_rate_limited', { scope }), suffix: '_total' })));

  // Mattermost catch-up: how old each channel's settled boundary and its last finished walk are.
  const catchup = source.store.catchup.status('mattermost');
  const boundaries = new Map((tables.has('channel_cursors') ? z.array(z.object({ key: z.string(), value: z.string() })).parse(db.prepare("SELECT key,value FROM channel_cursors WHERE key LIKE 'mattermost:%:%:last_ms'").all()) : [])
    .map(row => [row.key.split(':').slice(1, 3).join(':'), Number(row.value)]));
  family('ardent_mattermost_catchup_boundary_age_seconds', 'gauge', 'Seconds since the newest Mattermost post up to which every older post is settled, per channel',
    catchup.flatMap(item => { const at = boundaries.get(`${item.account}:${item.channel}`); return at && Number.isFinite(at) ? [{ labels: { channel: item.channel }, value: Math.max(0, (now - at) / 1000) }] : []; }));
  family('ardent_mattermost_catchup_walk_age_seconds', 'gauge', 'Seconds since the last finished Mattermost catch-up walk, per channel',
    catchup.flatMap(item => item.finished_ms === null ? [] : [{ labels: { channel: item.channel, state: item.state }, value: Math.max(0, (now - item.finished_ms) / 1000) }]));
  family('ardent_mattermost_catchup_gaps', 'gauge', 'Recorded Mattermost history gaps catch-up could not walk, per channel', catchup.map(item => ({ labels: { channel: item.channel }, value: item.gaps })));

  lines.push('# EOF');
  return `${lines.join('\n')}\n`;
}
