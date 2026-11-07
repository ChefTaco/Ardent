import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TaskState, type Task } from '@a2a-js/sdk';
import type { ArdentRuntime } from './runtime.js';
import type { ArdentConfig } from './config.js';
import { ArdentA2AClient } from './a2a-client.js';
import { TeamEnvelope } from './team-contract.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const safeName = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const Manifest = z.object({
  schema_version: z.literal('1.0'), revision: z.number().int().min(1), source_revision: z.string().min(1),
  visibility: z.enum(['private', 'gm', 'player']), license: z.string().min(1),
  preview: z.object({ mode: z.enum(['inline', 'thumbnail', 'download_only', 'none']), mime: z.string().min(1) }).strict(),
  supersedes_sha256: digest.nullable(), acceptance_status: z.enum(['unreviewed', 'approved', 'partial', 'rejected']),
  name: safeName, mime: z.string().min(1), sha256: digest, size: z.number().int().min(0).max(2 * 1024 * 1024),
  created_at: z.number().finite(), expires_at: z.number().finite(),
  provenance: z.object({ producer: z.string().min(1), source_id: z.string(), producer_task_id: z.string().min(1),
    lineage: z.array(z.object({ producer: z.string().min(1), source_id: z.string() }).strict()).min(1).max(4) }).strict(),
  recovery: z.object({ on_expiry: z.literal('request_verified_reexport') }).strict(), artifact_id: identifier
}).strict();
export type TeamArtifactManifest = z.infer<typeof Manifest>;
export const TeamArtifactDescriptorSchema = z.object({ artifact_id: identifier, name: safeName, mime: z.string().min(1), sha256: digest,
  size: z.number().int().min(0).max(2 * 1024 * 1024), producer_task_id: z.string().min(1), artifact_manifest: Manifest }).strict();
export type TeamArtifactDescriptor = z.infer<typeof TeamArtifactDescriptorSchema>;
const LocalRow = z.object({ id: identifier, peer: z.string(), context_id: z.string(), a2a_task_id: z.string(),
  digest, name: safeName, mime: z.string(), size: z.number(), manifest_json: z.string(), status: z.string(), expires: z.number() });
const TransferRow = z.object({ id: digest, owner: z.string(), local_task_id: z.string(), peer: z.string(),
  remote_task_id: z.string(), remote_context_id: z.string(), remote_artifact_id: identifier,
  digest, manifest_json: z.string(), status: z.string() });
const MAX_BYTES = 2 * 1024 * 1024;
const TTL_SECONDS = 7 * 24 * 3600;

function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function textParts(task: Task): string[] {
  return task.artifacts.flatMap(artifact => artifact.parts.flatMap(part =>
    part.content?.$case === 'text' && typeof part.content.value === 'string' ? [part.content.value] : []));
}

/** Peer artifact receipts. A transfer is retained evidence, never a delivery claim. */
export class TeamArtifacts {
  constructor(readonly runtime: ArdentRuntime, readonly config: ArdentConfig = runtime.config,
    readonly env: NodeJS.ProcessEnv = process.env) {
    runtime.store.db.exec(`CREATE TABLE IF NOT EXISTS a2a_team_artifacts (
      id TEXT PRIMARY KEY, peer TEXT NOT NULL, context_id TEXT NOT NULL, a2a_task_id TEXT NOT NULL,
      digest TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
      manifest_json TEXT NOT NULL, status TEXT NOT NULL, expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS a2a_team_artifact_transfers (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, local_task_id TEXT NOT NULL, peer TEXT NOT NULL,
      remote_task_id TEXT NOT NULL, remote_context_id TEXT NOT NULL, remote_artifact_id TEXT NOT NULL,
      digest TEXT NOT NULL, manifest_json TEXT NOT NULL, status TEXT NOT NULL);`);
  }

  async registerResearch(a2aTaskId: string): Promise<TeamArtifactDescriptor[]> {
    const db = this.runtime.store.db;
    const row = db.prepare(`SELECT t.caller,t.context_id,o.tenant,o.operation_id,m.envelope_json FROM a2a_tasks t
      JOIN a2a_operation_map o ON o.a2a_task_id=t.id JOIN a2a_team_missions m ON m.a2a_task_id=t.id
      WHERE t.id=? AND t.caller=o.caller AND t.caller=m.caller`)
      .get(a2aTaskId);
    const bound = z.object({ caller: z.string(), context_id: z.string(), tenant: z.string(),
      operation_id: z.string(), envelope_json: z.string() }).parse(row);
    const operation = this.runtime.store.get(bound.operation_id);
    if (operation?.state !== 'completed' || operation.context !== 'peer' ||
        operation.caller !== `a2a:${bound.tenant}:${bound.caller}`) return [];
    const envelope = TeamEnvelope.parse(JSON.parse(bound.envelope_json) as unknown);
    if (!envelope.mission.allowed_actions.includes('create_artifact')) return [];
    const events = this.runtime.store.events(bound.operation_id, 0, 500);
    const event = events.find(item => item.kind === 'research_artifacts');
    const actual = z.object({ report: z.object({ id: digest }), markdown: z.object({ id: digest }) }).safeParse(event?.detail);
    const entries: Array<{ name: string; mime: string; digest: string; producer: string; sourceId: string }> = actual.success ? [
      { name: 'research-brief.json', mime: 'application/json', digest: actual.data.report.id, producer: 'ardent-research', sourceId: '' },
      { name: 'research-brief.md', mime: 'text/markdown', digest: actual.data.markdown.id, producer: 'ardent-research', sourceId: '' }
    ] : [];
    const result: TeamArtifactDescriptor[] = [];
    for (const entry of entries) {
      const bytes = await this.runtime.artifacts.get(entry.digest);
      const size = bytes.byteLength;
      if (size > MAX_BYTES) throw new Error('Team artifact exceeds the byte limit');
      const previous = db.prepare(`SELECT * FROM a2a_team_artifacts WHERE a2a_task_id=? AND digest=? AND name=? AND status='available' AND expires>?`)
        .get(a2aTaskId, entry.digest, entry.name, Date.now() / 1000);
      if (previous) {
        const old = LocalRow.parse(previous);
        result.push({ artifact_id: old.id, name: old.name, mime: old.mime, sha256: old.digest, size: old.size,
          producer_task_id: a2aTaskId, artifact_manifest: Manifest.parse(JSON.parse(old.manifest_json) as unknown) });
        continue;
      }
      const id = randomBytes(16).toString('hex');
      const created = Date.now() / 1000;
      const manifest: TeamArtifactManifest = {
        schema_version: '1.0', revision: 1, source_revision: entry.digest,
        visibility: 'private', license: 'NOASSERTION', preview: { mode: 'download_only', mime: entry.mime },
        supersedes_sha256: null, acceptance_status: 'unreviewed', name: entry.name, mime: entry.mime,
        sha256: entry.digest, size, created_at: created, expires_at: created + TTL_SECONDS,
        provenance: { producer: entry.producer, source_id: entry.sourceId, producer_task_id: a2aTaskId,
          lineage: [{ producer: entry.producer, source_id: entry.sourceId }] },
        recovery: { on_expiry: 'request_verified_reexport' }, artifact_id: id
      };
      db.prepare(`INSERT INTO a2a_team_artifacts(id,peer,context_id,a2a_task_id,digest,name,mime,size,manifest_json,status,expires)
        VALUES (?,?,?,?,?,?,?,?,?,'available',?)`).run(id, bound.caller, bound.context_id, a2aTaskId,
        entry.digest, entry.name, entry.mime, size, JSON.stringify(manifest), manifest.expires_at);
      result.push({ artifact_id: id, name: entry.name, mime: entry.mime, sha256: entry.digest, size,
        producer_task_id: a2aTaskId, artifact_manifest: manifest });
    }
    return result;
  }

  async serve(peer: string, id: string, contextId: string): Promise<{ status: number; bytes?: Uint8Array; descriptor?: TeamArtifactDescriptor }> {
    if (!identifier.safeParse(id).success || !contextId || contextId.length > 128) return { status: 404 };
    const raw = this.runtime.store.db.prepare('SELECT * FROM a2a_team_artifacts WHERE id=? AND peer=? AND context_id=?').get(id, peer, contextId);
    if (!raw) return { status: 404 };
    const row = LocalRow.parse(raw);
    if (row.status !== 'available' || row.expires <= Date.now() / 1000) return { status: 410 };
    try {
      const bytes = await this.runtime.artifacts.get(row.digest);
      if (bytes.byteLength !== row.size) return { status: 409 };
      const manifest = Manifest.parse(JSON.parse(row.manifest_json) as unknown);
      if (manifest.artifact_id !== id || manifest.sha256 !== row.digest || manifest.expires_at !== row.expires ||
        manifest.name !== row.name || manifest.mime !== row.mime || manifest.size !== row.size ||
        manifest.provenance.producer_task_id !== row.a2a_task_id)
        return { status: 410 };
      return { status: 200, bytes, descriptor: { artifact_id: id, name: row.name, mime: row.mime,
        sha256: row.digest, size: row.size, producer_task_id: row.a2a_task_id, artifact_manifest: manifest } };
    } catch { return { status: 409 }; }
  }

  revokeLocal(peer: string, a2aTaskId: string, id: string): void {
    const changed = this.runtime.store.db.prepare(`UPDATE a2a_team_artifacts SET status='revoked'
      WHERE id=? AND peer=? AND a2a_task_id=? AND status='available'`).run(id, peer, a2aTaskId).changes;
    if (changed !== 1) throw new Error('Owned artifact export is unavailable');
  }

  async fetchHermes(input: { owner: string; localTaskId: string; peer: string; remoteTaskId: string;
    remoteContextId: string; artifactId: string; sha256: string }): Promise<TeamArtifactDescriptor & { local_artifact_id: string }> {
    const owned = this.runtime.store.get(input.localTaskId);
    if (!owned || owned.caller !== input.owner || !['direct', 'peer'].includes(owned.context)) throw new Error('Local recipient task is not owned');
    const id = identifier.parse(input.artifactId);
    const expected = digest.parse(input.sha256);
    if (!input.remoteTaskId || !input.remoteContextId) throw new Error('Remote task receipt is incomplete');
    const transferId = sha(Buffer.from(JSON.stringify([input.owner, input.localTaskId, input.peer,
      input.remoteTaskId, input.remoteContextId, id, expected])));
    const priorRaw = this.runtime.store.db.prepare('SELECT * FROM a2a_team_artifact_transfers WHERE id=?').get(transferId);
    if (priorRaw) {
      const prior = TransferRow.parse(priorRaw);
      if (prior.status !== 'complete') throw new Error('Artifact transfer requires reconciliation');
      await this.runtime.artifacts.get(prior.digest);
      const manifest = Manifest.parse(JSON.parse(prior.manifest_json) as unknown);
      return { artifact_id: id, name: manifest.name, mime: manifest.mime, sha256: expected, size: manifest.size,
        producer_task_id: input.remoteTaskId, artifact_manifest: manifest, local_artifact_id: prior.digest };
    }
    const { card, client, authorization } = await new ArdentA2AClient(this.runtime.profileDir, this.config, this.env).open(input.peer);
    const remote = await client.getTask({ tenant: '', id: input.remoteTaskId },
      { serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' } });
    if (remote.id !== input.remoteTaskId || remote.contextId !== input.remoteContextId ||
      remote.status?.state !== TaskState.TASK_STATE_COMPLETED) throw new Error('Remote task receipt is not complete or bound');
    const descriptors = textParts(remote).flatMap(value => {
      try { return [TeamArtifactDescriptorSchema.parse(JSON.parse(value) as unknown)]; } catch { return []; }
    });
    const declared = descriptors.find(item => item.artifact_id === id && item.sha256 === expected &&
      item.producer_task_id === input.remoteTaskId);
    if (!declared) throw new Error('Remote task did not declare this exact artifact');
    const interfaceUrl = card.supportedInterfaces.find(item => item.protocolBinding.toUpperCase() === 'JSONRPC' &&
      item.protocolVersion === '1.0')?.url;
    if (!interfaceUrl) throw new Error('Remote peer has no pinned JSON-RPC origin');
    const url = new URL(`/team/artifacts/${id}`, interfaceUrl);
    url.searchParams.set('context', input.remoteContextId);
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: authorization } });
    if (!response.ok) throw new Error(`Artifact fetch HTTP ${response.status}`);
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader === null ? NaN : Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0 || length > MAX_BYTES || length !== declared.size)
      throw new Error('Artifact size differs from task receipt');
    if (response.headers.get('x-hermes-task-id') !== input.remoteTaskId ||
      decodeURIComponent(response.headers.get('x-artifact-name') ?? '') !== declared.name ||
      response.headers.get('content-type')?.split(';')[0] !== declared.mime)
      throw new Error('Artifact response differs from task receipt');
    const encoded = response.headers.get('x-hermes-artifact-manifest');
    if (!encoded || encoded.length > 8192) throw new Error('Artifact manifest is missing or oversized');
    const manifest = Manifest.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown);
    if (JSON.stringify(manifest) !== JSON.stringify(declared.artifact_manifest) ||
      manifest.expires_at <= Date.now() / 1000 || manifest.provenance.producer_task_id !== input.remoteTaskId)
      throw new Error('Artifact manifest differs from task receipt');
    if (!response.body) throw new Error('Artifact response has no body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES || total > length) throw new Error('Artifact response exceeds declared size');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.byteLength !== length || sha(bytes) !== expected) throw new Error('Artifact bytes differ from task receipt');
    const local = await this.runtime.artifacts.put(manifest.name, manifest.mime, bytes);
    this.runtime.store.db.prepare(`INSERT INTO a2a_team_artifact_transfers(id,owner,local_task_id,peer,remote_task_id,
      remote_context_id,remote_artifact_id,digest,manifest_json,status) VALUES (?,?,?,?,?,?,?,?,?,'complete')`)
      .run(transferId, input.owner, input.localTaskId, input.peer, input.remoteTaskId,
        input.remoteContextId, id, local.id, JSON.stringify(manifest));
    return { ...declared, local_artifact_id: local.id };
  }

  project(owner: string, localTaskId: string): Array<{ local_artifact_id: string; peer: string;
    remote_task_id: string; artifact_manifest: TeamArtifactManifest; delivery: 'unverified' }> {
    const task = this.runtime.store.get(localTaskId);
    if (!task || task.caller !== owner) throw new Error('Recipient task owner differs');
    return this.runtime.store.db.prepare(`SELECT * FROM a2a_team_artifact_transfers
      WHERE owner=? AND local_task_id=? AND status='complete'`).all(owner, localTaskId).map(raw => {
      const row = TransferRow.parse(raw);
      return { local_artifact_id: row.digest, peer: row.peer, remote_task_id: row.remote_task_id,
        artifact_manifest: Manifest.parse(JSON.parse(row.manifest_json) as unknown), delivery: 'unverified' as const };
    });
  }
}
