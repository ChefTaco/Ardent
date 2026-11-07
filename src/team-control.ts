import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import { TeamEnvelope } from './team-contract.js';

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const EventsPayload = z.object({ native_task_id: id, after_cursor: z.number().int().min(0), limit: z.number().int().min(1).max(100) }).strict();
const ControlPayload = z.object({ native_task_id: id, task_id: id, mission_revision: z.number().int().min(1), control_id: id, control_version: z.number().int().min(1), action: z.enum(['pause', 'resume', 'cancel']) }).strict();
const TeamControl = z.discriminatedUnion('action', [
  z.object({ version: z.literal('1.0'), action: z.literal('task_events'), key: id, payload: EventsPayload }).strict(),
  z.object({ version: z.literal('1.0'), action: z.literal('task_control'), key: id, payload: ControlPayload }).strict()
]);
type TeamControl = z.infer<typeof TeamControl>;
const MissionRow = z.object({ envelope_json: z.string(), tenant: z.string(), caller: z.string(), operation_id: z.string() });
const RequestRow = z.object({ request_digest: z.string(), receipt_json: z.string() });
const AdmissionRow = z.object({ version: z.number(), admission: z.enum(['open', 'paused', 'cancel_requested']) });
const ControlRow = z.object({ payload_sha256: z.string(), receipt_json: z.string() });
const EventRow = z.object({ sequence: z.number(), kind: z.string(), detail_json: z.string(), created_ms: z.number() });

function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]));
    return input;
  };
  return JSON.stringify(sort(value));
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

/** Deterministic receiver-side lifecycle controls for an accepted team task. */
export class TeamControlService {
  constructor(readonly runtime: ArdentRuntime) {
    runtime.store.db.exec(`CREATE TABLE IF NOT EXISTS a2a_team_control_requests (
      tenant TEXT NOT NULL, caller TEXT NOT NULL, request_key TEXT NOT NULL,
      request_digest TEXT NOT NULL, receipt_json TEXT NOT NULL,
      PRIMARY KEY(tenant,caller,request_key));
      CREATE TABLE IF NOT EXISTS a2a_team_admission (
        a2a_task_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, version INTEGER NOT NULL,
        admission TEXT NOT NULL, updated_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS a2a_team_controls (
        a2a_task_id TEXT NOT NULL, control_id TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
        receipt_json TEXT NOT NULL, PRIMARY KEY(a2a_task_id,control_id));
      CREATE TABLE IF NOT EXISTS a2a_operation_links (
        a2a_task_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        PRIMARY KEY(a2a_task_id,operation_id));`);
  }
  #mission(taskId: string, tenant: string, caller: string): { envelope: TeamEnvelope; operationId: string } {
    const row = this.runtime.store.db.prepare(`SELECT m.envelope_json,m.tenant,m.caller,o.operation_id FROM a2a_team_missions m
      JOIN a2a_operation_map o ON o.a2a_task_id=m.a2a_task_id
      JOIN a2a_tasks t ON t.id=m.a2a_task_id
      WHERE m.a2a_task_id=? AND t.tenant=? AND t.caller=?`).get(taskId, tenant, caller);
    if (!row) throw new Error('Accepted team task is unavailable to this peer');
    const bound = MissionRow.parse(row);
    if (bound.tenant !== tenant || bound.caller !== caller) throw new Error('Team task owner differs');
    const raw: unknown = JSON.parse(bound.envelope_json);
    return { envelope: TeamEnvelope.parse(raw), operationId: bound.operation_id };
  }
  #events(payload: z.infer<typeof EventsPayload>, tenant: string, caller: string): object {
    const { envelope } = this.#mission(payload.native_task_id, tenant, caller);
    const rows = this.runtime.store.db.prepare(`SELECT e.sequence,e.kind,e.detail_json,e.created_ms FROM events e
      JOIN a2a_operation_links l ON l.operation_id=e.task_id
      WHERE l.a2a_task_id=? AND e.sequence>? ORDER BY e.sequence LIMIT ?`).all(payload.native_task_id, payload.after_cursor, payload.limit + 1)
      .map(row => EventRow.parse(row));
    const events: object[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, payload.limit)) {
      const detail: unknown = JSON.parse(row.detail_json);
      let item = { cursor: row.sequence, task_id: payload.native_task_id, kind: row.kind,
        stage: row.kind.startsWith('tool_') ? 'tool' : row.kind.startsWith('model_') ? 'model' : 'task',
        status: 'observed', summary: row.kind.replaceAll('_', ' ').slice(0, 160), data: detail,
        created: row.created_ms / 1000 };
      if (Buffer.byteLength(canonical(item)) > 32_768) item = { ...item, data: { truncated: true } };
      const size = Buffer.byteLength(canonical(item));
      if (events.length && bytes + size > 32_768) break;
      events.push(item); bytes += size;
    }
    const last = events.at(-1) as { cursor?: number } | undefined;
    const nextCursor = last?.cursor ?? payload.after_cursor;
    return { native_task_id: payload.native_task_id, task_id: envelope.task_id, events,
      next_cursor: nextCursor, has_more: rows.some(row => row.sequence > nextCursor) };
  }
  #control(payload: z.infer<typeof ControlPayload>, tenant: string, caller: string): { data: object; cancelOperation?: string } {
    const { envelope, operationId } = this.#mission(payload.native_task_id, tenant, caller);
    if (envelope.task_id !== payload.task_id || envelope.mission.revision !== payload.mission_revision) throw new Error('Team control task or mission revision differs');
    const db = this.runtime.store.db;
    return db.transaction(() => {
      const priorRaw = db.prepare('SELECT payload_sha256,receipt_json FROM a2a_team_controls WHERE a2a_task_id=? AND control_id=?')
        .get(payload.native_task_id, payload.control_id);
      const fingerprint = digest(payload);
      if (priorRaw) {
        const prior = ControlRow.parse(priorRaw);
        if (prior.payload_sha256 !== fingerprint) throw new Error('Team control ID reused with different content');
        const data: unknown = JSON.parse(prior.receipt_json);
        return { data: z.record(z.string(), z.unknown()).parse(data), ...(payload.action === 'cancel' ? { cancelOperation: operationId } : {}) };
      }
      const currentRaw = db.prepare('SELECT version,admission FROM a2a_team_admission WHERE a2a_task_id=?').get(payload.native_task_id);
      const current = currentRaw ? AdmissionRow.parse(currentRaw) : { version: 0, admission: 'open' as const };
      if (payload.control_version <= current.version) throw new Error('Stale team control version');
      if (current.admission === 'cancel_requested' && payload.action !== 'cancel') throw new Error('Cancellation admission cannot be reopened');
      if (payload.action === 'resume' && envelope.mission.deadline <= Date.now() / 1000) throw new Error('Expired team mission cannot resume');
      const admission = payload.action === 'pause' ? 'paused' : payload.action === 'resume' ? 'open' : 'cancel_requested';
      db.prepare(`INSERT INTO a2a_team_admission(a2a_task_id,operation_id,version,admission,updated_ms) VALUES (?,?,?,?,?)
        ON CONFLICT(a2a_task_id) DO UPDATE SET operation_id=excluded.operation_id,version=excluded.version,admission=excluded.admission,updated_ms=excluded.updated_ms`)
        .run(payload.native_task_id, operationId, payload.control_version, admission, Date.now());
      const data = { control_id: payload.control_id, native_task_id: payload.native_task_id,
        control_version: payload.control_version, admission, execution_stopped: false,
        provider_work_stopped: false, undo: false, delivery: 'acknowledged' };
      db.prepare('INSERT INTO a2a_team_controls(a2a_task_id,control_id,payload_sha256,receipt_json) VALUES (?,?,?,?)')
        .run(payload.native_task_id, payload.control_id, fingerprint, canonical(data));
      this.runtime.store.append(operationId, 'team_control', data);
      return { data, ...(payload.action === 'cancel' ? { cancelOperation: operationId } : {}) };
    })();
  }
  handle(raw: unknown, tenant: string, caller: string): object {
    const control: TeamControl = TeamControl.parse(raw);
    const requestDigest = digest(control);
    const db = this.runtime.store.db;
    const priorRaw = db.prepare('SELECT request_digest,receipt_json FROM a2a_team_control_requests WHERE tenant=? AND caller=? AND request_key=?')
      .get(tenant, caller, control.key);
    if (priorRaw) {
      const prior = RequestRow.parse(priorRaw);
      if (prior.request_digest !== requestDigest) throw new Error('Team control key reused with different content');
      const stored: unknown = JSON.parse(prior.receipt_json);
      // A crash between persisting a cancel receipt and signaling the local
      // operation must not make a retried request a no-op.
      if (control.action === 'task_control' && control.payload.action === 'cancel') {
        const { operationId } = this.#mission(control.payload.native_task_id, tenant, caller);
        this.runtime.cancel(operationId);
      }
      return z.record(z.string(), z.unknown()).parse(stored);
    }
    const result = control.action === 'task_events'
      ? { data: this.#events(control.payload, tenant, caller) }
      : this.#control(control.payload, tenant, caller);
    const receipt = { version: '1.0', request_digest: requestDigest, data: result.data };
    db.prepare('INSERT INTO a2a_team_control_requests(tenant,caller,request_key,request_digest,receipt_json) VALUES (?,?,?,?,?)')
      .run(tenant, caller, control.key, requestDigest, canonical(receipt));
    if (result.cancelOperation) this.runtime.cancel(result.cancelOperation);
    return receipt;
  }
}
