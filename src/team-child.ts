import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ArdentRuntime } from './runtime.js';
import { ArdentA2AClient } from './a2a-client.js';
import { TeamEnvelope, type TeamResult } from './team-contract.js';

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const TeamChildReference = z.object({ version: z.literal('1.0'), root: id, child_id: id, sha256: sha }).strict();
export type TeamChildReference = z.infer<typeof TeamChildReference>;
const Grant = z.object({ version: z.literal('1.0'), root: id, child_id: id, target: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), parent_task: id,
  context: id, envelope: TeamEnvelope, budget_id: id, depth: z.number().int().min(1).max(4), deadline: z.number().int().positive(), sha256: sha }).strict();
const ClaimResponse = z.object({ grant: Grant, state: z.literal('claimed'), claim_id: id }).passthrough();
const SettlementResponse = z.object({ native_id: id, status: z.string() }).passthrough();
const Row = z.object({ child_id: id, a2a_task_id: z.string(), fingerprint: sha, claim_id: id, root: id, grant_json: z.string(),
  operation_id: z.string().nullable(), settlement_json: z.string().nullable(), acknowledged: z.number().int() });

function stable(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, nested]) => [key, sort(nested)]));
    return item;
  };
  return JSON.stringify(sort(value));
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }

/** A child is admitted only after the retained Hermes root grants its exact scope. */
export class TeamChildService {
  readonly #client: ArdentA2AClient;
  constructor(readonly runtime: ArdentRuntime, env: NodeJS.ProcessEnv) {
    this.#client = new ArdentA2AClient(runtime.profileDir, runtime.config, env);
    runtime.store.db.exec(`CREATE TABLE IF NOT EXISTS a2a_team_child_claims (
      child_id TEXT PRIMARY KEY, a2a_task_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      claim_id TEXT NOT NULL, root TEXT NOT NULL, grant_json TEXT NOT NULL,
      operation_id TEXT, settlement_json TEXT, acknowledged INTEGER NOT NULL DEFAULT 0);`);
  }
  #row(childId: string): z.infer<typeof Row> | undefined {
    const raw = this.runtime.store.db.prepare('SELECT * FROM a2a_team_child_claims WHERE child_id=?').get(childId);
    return raw ? Row.parse(raw) : undefined;
  }
  async #call(root: string, action: string, payload: object, key: string): Promise<Record<string, unknown>> {
    const control = { version: '1.0' as const, action, key, payload };
    const receipt = await this.#client.teamControl(root, control);
    if (receipt['request_digest'] !== digest(control)) throw new Error('Root coordination receipt digest differs');
    return z.record(z.string(), z.unknown()).parse(receipt['data']);
  }
  async claim(raw: unknown, envelope: z.infer<typeof TeamEnvelope>, a2aTaskId: string, contextId: string,
    authenticatedCaller: string, requestFingerprint: string): Promise<TeamChildReference> {
    const ref = TeamChildReference.parse(raw);
    if (ref.child_id !== envelope.task_id || envelope.mission.parent_task === null ||
      authenticatedCaller !== envelope.caller || !envelope.mission.allowed_actions.every(action => action === 'observe' || action === 'analyze'))
      throw new Error('Child reference is outside the authenticated read-only mission');
    const fingerprint = digest({ reference: ref, envelope, contextId, caller: authenticatedCaller, requestFingerprint });
    const db = this.runtime.store.db;
    let row = this.#row(ref.child_id);
    if (row && (row.fingerprint !== fingerprint || row.root !== ref.root || row.a2a_task_id !== a2aTaskId))
      throw new Error('Child receipt already binds different work');
    if (!row) {
      const claimId = `claim-${randomUUID().replaceAll('-', '')}`;
      db.prepare('INSERT INTO a2a_team_child_claims(child_id,a2a_task_id,fingerprint,claim_id,root,grant_json) VALUES (?,?,?,?,?,?)')
        .run(ref.child_id, a2aTaskId, fingerprint, claimId, ref.root, '{}');
      row = this.#row(ref.child_id);
    }
    if (!row) throw new Error('Child claim was not retained');
    if (row.operation_id) throw new Error('Child already has a native execution receipt; reconcile without replay');
    if (row.grant_json !== '{}') {
      if (Grant.parse(JSON.parse(row.grant_json) as unknown).deadline <= Date.now() / 1000)
        throw new Error('Retained child grant has expired');
      return ref;
    }
    const response = ClaimResponse.parse(await this.#call(ref.root, 'claim_child',
      { child_id: ref.child_id, grant_sha256: ref.sha256, claim_id: row.claim_id }, `claim-${digest([ref.child_id, row.claim_id])}`));
    const grant = response.grant;
    const { sha256, ...unsigned } = grant;
    if (response.claim_id !== row.claim_id || sha256 !== ref.sha256 || digest(unsigned) !== sha256 ||
      grant.target !== this.runtime.config.profile || grant.root !== ref.root || grant.child_id !== ref.child_id || grant.context !== contextId ||
      stable(grant.envelope) !== stable(envelope) || grant.deadline <= Date.now() / 1000 ||
      grant.deadline > envelope.mission.deadline || grant.parent_task !== envelope.mission.parent_task)
      throw new Error('Root child grant does not authorize these exact parameters');
    db.prepare('UPDATE a2a_team_child_claims SET grant_json=? WHERE child_id=?').run(stable(grant), ref.child_id);
    return ref;
  }
  attach(ref: TeamChildReference, operationId: string): void {
    const row = this.#row(ref.child_id);
    if (!row || row.grant_json === '{}') throw new Error('Child execution has no retained root claim');
    if (row.operation_id && row.operation_id !== operationId) throw new Error('Child native execution identity changed');
    this.runtime.store.db.prepare('UPDATE a2a_team_child_claims SET operation_id=? WHERE child_id=?').run(operationId, ref.child_id);
  }
  deadline(ref: TeamChildReference): number {
    const row = this.#row(ref.child_id);
    if (!row || row.grant_json === '{}') throw new Error('Child has no retained root budget');
    return Grant.parse(JSON.parse(row.grant_json) as unknown).deadline;
  }
  async settle(ref: TeamChildReference, outcome: TeamResult['outcome'], result: string): Promise<void> {
    const row = this.#row(ref.child_id);
    if (!row?.operation_id) throw new Error('Child settlement has no native execution');
    const value = { child_id: ref.child_id, claim_id: row.claim_id, native_id: row.a2a_task_id,
      result: Buffer.byteLength(result, 'utf8') > 40_000 ? 'Child result exceeds root settlement limit; inspect retained Ardent task' : result,
      outcome: Buffer.byteLength(result, 'utf8') > 40_000 ? 'unknown' : outcome };
    const serialized = stable(value);
    if (row.settlement_json && row.settlement_json !== serialized) throw new Error('Child settlement cannot change after first publication');
    if (!row.settlement_json) this.runtime.store.db.prepare('UPDATE a2a_team_child_claims SET settlement_json=? WHERE child_id=?').run(serialized, ref.child_id);
    if (row.acknowledged) return;
    const response = SettlementResponse.parse(await this.#call(row.root, 'settle_child', value, `settle-${digest(value)}`));
    if (response.native_id !== row.a2a_task_id || response.status !== value.outcome) throw new Error('Root child settlement binding differs');
    this.runtime.store.db.prepare('UPDATE a2a_team_child_claims SET acknowledged=1 WHERE child_id=?').run(ref.child_id);
  }
  async flush(): Promise<void> {
    const rows = this.runtime.store.db.prepare('SELECT * FROM a2a_team_child_claims WHERE settlement_json IS NOT NULL AND acknowledged=0 LIMIT 16').all();
    for (const raw of rows) {
      try {
        const row = Row.parse(raw);
        const value: unknown = JSON.parse(row.settlement_json ?? '');
        const settlement = z.object({ outcome: z.enum(['completed', 'partial', 'failed', 'blocked', 'input_required', 'cancelled', 'unknown']), result: z.string() }).passthrough().parse(value);
        await this.settle({ version: '1.0', root: row.root, child_id: row.child_id, sha256: Grant.parse(JSON.parse(row.grant_json) as unknown).sha256 }, settlement.outcome, settlement.result);
      } catch { /* Retained settlement is retried later; native work is never replayed. */ }
    }
  }
}
