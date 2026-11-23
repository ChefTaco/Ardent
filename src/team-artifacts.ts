import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ARTIFACT_TRANSFER_ERRORS, ARTIFACT_TRANSFER_V1_MAX_BYTES, ARTIFACT_TRANSFER_V2_URN } from '@hivemagnus/hive-common/artifact';
import type { ArdentRuntime } from './runtime.js';
import type { ArdentConfig } from './config.js';
import { collectPluginTeamEvidence } from './plugin-evidence.js';
import { ARTIFACT_MAX_BYTES_LIMIT } from './artifacts.js';
import { ArtifactManifest11Schema, ArtifactManifestSchema, ArtifactRenditionSchema, manifestV11, TeamArtifactManifestSchema,
  type ArtifactManifest11, type ArtifactRendition, type TeamArtifactManifest } from './artifact-manifests.js';

export { TeamArtifactManifestSchema, type TeamArtifactManifest } from './artifact-manifests.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const safeName = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
const Manifest = TeamArtifactManifestSchema;
/** An export manifest as stored: 1.0 for a v1-sized export, 1.1 above 2 MiB or for a rendition. */
const StoredManifest = z.discriminatedUnion('schema_version', [ArtifactManifestSchema, ArtifactManifest11Schema]);
/** The v1 transfer descriptor: one A2A text part, at most 2 MiB. Unchanged by transfer v2. */
export const TeamArtifactDescriptorSchema = z.object({ artifact_id: identifier, name: safeName, mime: z.string().min(1), sha256: digest,
  size: z.number().int().min(0).max(ARTIFACT_TRANSFER_V1_MAX_BYTES), producer_task_id: z.string().min(1), artifact_manifest: Manifest }).strict();
export type TeamArtifactDescriptor = z.infer<typeof TeamArtifactDescriptorSchema>;
const teamPath = (suffix: string) => z.string().max(600).regex(new RegExp(`^/team/artifacts/[a-f0-9]{32}${suffix}\\?context=[A-Za-z0-9%._~-]{1,400}$`));
/**
 * The transfer-v2 descriptor: an A2A data part with media type
 * `ARTIFACT_TRANSFER_V2_MEDIA_TYPE`. Paths resolve against the exporting
 * peer's pinned A2A origin.
 */
export const TeamArtifactDescriptorV2Schema = z.object({ manifest_1_1: ArtifactManifest11Schema, content_path: teamPath(''),
  renditions_path: teamPath('/renditions'), size: z.number().int().min(0).max(ARTIFACT_MAX_BYTES_LIMIT), sha256: digest }).strict()
  .refine(value => value.size === value.manifest_1_1.size && value.sha256 === value.manifest_1_1.sha256, 'Descriptor differs from its manifest');
export type TeamArtifactDescriptorV2 = z.infer<typeof TeamArtifactDescriptorV2Schema>;
/** The explicit result a v1 consumer receives for an export larger than the v1 limit. */
export const TeamArtifactRequiresV2Schema = z.object({ error: z.literal(ARTIFACT_TRANSFER_ERRORS.requiresV2), capability: z.literal(ARTIFACT_TRANSFER_V2_URN),
  message: z.string(), artifact_id: identifier, name: safeName, mime: z.string().min(1), sha256: digest,
  size: z.number().int().min(0).max(ARTIFACT_MAX_BYTES_LIMIT), producer_task_id: z.string().min(1) }).strict();
export type TeamArtifactRequiresV2 = z.infer<typeof TeamArtifactRequiresV2Schema>;
/** One export: the v2 descriptor always, and either the v1 descriptor (at most 2 MiB) or the explicit v2 requirement. */
export type TeamArtifactExport = { v2: TeamArtifactDescriptorV2 } & ({ v1: TeamArtifactDescriptor; requires_v2?: never } | { v1?: never; requires_v2: TeamArtifactRequiresV2 });
/** An export a peer may fetch: its stored manifest in both views. `manifest_1_0` is absent above 2 MiB or for a rendition. */
export type ResolvedTeamArtifact = { status: 200; id: string; peer: string; context_id: string; a2a_task_id: string; manifest: ArtifactManifest11; manifest_1_0?: TeamArtifactManifest };
const LocalRow = z.object({ id: identifier, peer: z.string(), context_id: z.string(), a2a_task_id: z.string(),
  digest, name: safeName, mime: z.string(), size: z.number(), manifest_json: z.string(), status: z.string(), expires: z.number() });
const TransferRow = z.object({ id: digest, owner: z.string(), local_task_id: z.string(), peer: z.string(),
  remote_task_id: z.string(), remote_context_id: z.string(), remote_artifact_id: identifier,
  digest, manifest_json: z.string(), status: z.string() });
const TTL_SECONDS = 7 * 24 * 3600;

function contentPath(id: string, contextId: string, suffix = ''): string {
  return `/team/artifacts/${id}${suffix}?context=${encodeURIComponent(contextId)}`;
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

  async registerResearch(a2aTaskId: string): Promise<TeamArtifactExport[]> {
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
    const envelope = this.runtime.decodeTeamEnvelope(JSON.parse(bound.envelope_json) as unknown);
    const extensions = await collectPluginTeamEvidence(this.runtime, operation, envelope, this.env);
    const events = this.runtime.store.events(bound.operation_id, 0, 500);
    const event = events.find(item => item.kind === 'research_artifacts');
    const actual = z.object({ report: z.object({ id: digest }), markdown: z.object({ id: digest }) }).safeParse(event?.detail);
    const entries: Array<{ name: string; mime: string; digest: string; producer: string; sourceId: string }> = envelope.mission.allowed_actions.includes('create_artifact') && actual.success ? [
      { name: 'research-brief.json', mime: 'application/json', digest: actual.data.report.id, producer: 'ardent-research', sourceId: '' },
      { name: 'research-brief.md', mime: 'text/markdown', digest: actual.data.markdown.id, producer: 'ardent-research', sourceId: '' }
    ] : [];
    entries.push(...extensions.artifacts.map(item => ({ name: item.name, mime: item.mime, digest: item.sha256, producer: item.producer, sourceId: item.source })));
    const result: TeamArtifactExport[] = [];
    for (const entry of entries) {
      const row = await this.#export(bound.caller, bound.context_id, a2aTaskId, entry);
      const exported = this.#exported(row);
      if (!exported) throw new Error('Team artifact export is inconsistent');
      result.push(exported);
      // Renditions are exported with their original so a v2 peer can choose one; they are listed, not announced.
      for (const rendition of (await this.runtime.artifactManifests.renditions(entry.digest)) ?? []) {
        if (rendition.role === 'original' || rendition.sha256 === entry.digest) continue;
        const record = this.runtime.artifactManifests.manifestV2(rendition.sha256);
        if (!record?.manifest.rendition) continue;
        await this.#export(bound.caller, bound.context_id, a2aTaskId, { name: record.manifest.name, mime: record.manifest.mime,
          digest: rendition.sha256, producer: record.manifest.provenance.producer, sourceId: record.manifest.provenance.source_id,
          rendition: record.manifest.rendition });
      }
    }
    return result;
  }

  /** Record one export row, or return the current one for the same task, digest and name. */
  async #export(peer: string, contextId: string, a2aTaskId: string, entry: { name: string; mime: string; digest: string; producer: string;
    sourceId: string; rendition?: ArtifactManifest11['rendition'] }): Promise<z.infer<typeof LocalRow>> {
    const db = this.runtime.store.db;
    // Hash the stored bytes as a stream: the export never holds the artifact in memory.
    const size = await this.runtime.artifacts.verify(entry.digest);
    if (size > this.runtime.artifacts.maxBytes) throw new Error('Team artifact exceeds the byte limit');
    const previous = db.prepare(`SELECT * FROM a2a_team_artifacts WHERE a2a_task_id=? AND digest=? AND name=? AND status='available' AND expires>?`)
      .get(a2aTaskId, entry.digest, entry.name, Date.now() / 1000);
    if (previous) return LocalRow.parse(previous);
    const id = randomBytes(16).toString('hex');
    const created = Date.now() / 1000;
    const base = {
      revision: 1, source_revision: entry.digest,
      visibility: 'private', license: 'NOASSERTION', preview: { mode: 'download_only', mime: entry.mime },
      supersedes_sha256: null, acceptance_status: 'unreviewed', name: entry.name, mime: entry.mime,
      sha256: entry.digest, size, created_at: created, expires_at: created + TTL_SECONDS,
      provenance: { producer: entry.producer, source_id: entry.sourceId, producer_task_id: a2aTaskId,
        lineage: [{ producer: entry.producer, source_id: entry.sourceId }] },
      recovery: { on_expiry: 'request_verified_reexport' }, artifact_id: id
    } as const;
    // A v1-sized original keeps the exact 1.0 manifest v1 consumers verify.
    const manifest = size <= ARTIFACT_TRANSFER_V1_MAX_BYTES && !entry.rendition
      ? Manifest.parse({ schema_version: '1.0', ...base })
      : ArtifactManifest11Schema.parse({ schema_version: '1.1', ...base, ...(entry.rendition ? { rendition: entry.rendition } : {}) });
    db.prepare(`INSERT INTO a2a_team_artifacts(id,peer,context_id,a2a_task_id,digest,name,mime,size,manifest_json,status,expires)
      VALUES (?,?,?,?,?,?,?,?,?,'available',?)`).run(id, peer, contextId, a2aTaskId,
      entry.digest, entry.name, entry.mime, size, JSON.stringify(manifest), manifest.expires_at);
    return LocalRow.parse(db.prepare('SELECT * FROM a2a_team_artifacts WHERE id=?').get(id));
  }

  #exported(row: z.infer<typeof LocalRow>): TeamArtifactExport | undefined {
    const stored = StoredManifest.safeParse(JSON.parse(row.manifest_json) as unknown);
    if (!stored.success) return undefined;
    const manifest = manifestV11(stored.data);
    const v2: TeamArtifactDescriptorV2 = { manifest_1_1: manifest, content_path: contentPath(row.id, row.context_id),
      renditions_path: contentPath(row.id, row.context_id, '/renditions'), size: row.size, sha256: row.digest };
    if (stored.data.schema_version === '1.0') {
      const v1 = Manifest.safeParse(stored.data);
      if (!v1.success) return undefined;
      return { v2, v1: { artifact_id: row.id, name: row.name, mime: row.mime, sha256: row.digest, size: row.size,
        producer_task_id: row.a2a_task_id, artifact_manifest: v1.data } };
    }
    return { v2, requires_v2: { error: ARTIFACT_TRANSFER_ERRORS.requiresV2, capability: ARTIFACT_TRANSFER_V2_URN,
      message: `This artifact is larger than ${ARTIFACT_TRANSFER_V1_MAX_BYTES} bytes; fetch it with ${ARTIFACT_TRANSFER_V2_URN}`,
      artifact_id: row.id, name: row.name, mime: row.mime, sha256: row.digest, size: row.size, producer_task_id: row.a2a_task_id } };
  }

  /**
   * The export a peer may fetch in a context, checked against its stored
   * manifest and the size of the stored bytes. Bytes are read by the caller.
   */
  async resolve(peer: string, id: string, contextId: string): Promise<ResolvedTeamArtifact | { status: 404 | 409 | 410 }> {
    if (!identifier.safeParse(id).success || !contextId || contextId.length > 128) return { status: 404 };
    const raw = this.runtime.store.db.prepare('SELECT * FROM a2a_team_artifacts WHERE id=? AND peer=? AND context_id=?').get(id, peer, contextId);
    if (!raw) return { status: 404 };
    const row = LocalRow.parse(raw);
    if (row.status !== 'available' || row.expires <= Date.now() / 1000) return { status: 410 };
    const stored = StoredManifest.safeParse(JSON.parse(row.manifest_json) as unknown);
    if (!stored.success) return { status: 410 };
    const manifest = stored.data;
    if (manifest.artifact_id !== id || manifest.sha256 !== row.digest || manifest.expires_at !== row.expires ||
      manifest.name !== row.name || manifest.mime !== row.mime || manifest.size !== row.size ||
      manifest.provenance.producer_task_id !== row.a2a_task_id)
      return { status: 410 };
    try {
      const file = await this.runtime.artifacts.stat(row.digest);
      if (!file || file.size !== row.size) return { status: 409 };
    } catch { return { status: 409 }; }
    const v10 = manifest.schema_version === '1.0' ? Manifest.safeParse(manifest) : undefined;
    return { status: 200, id, peer, context_id: row.context_id, a2a_task_id: row.a2a_task_id, manifest: manifestV11(manifest),
      ...(v10?.success ? { manifest_1_0: v10.data } : {}) };
  }

  /**
   * The exported forms of an export's artifact in the same task and context,
   * the original first, each with the export ID and path that serves it.
   */
  async renditions(resolved: ResolvedTeamArtifact): Promise<Array<ArtifactRendition & { artifact_id: string; content_path: string }>> {
    const local = await this.runtime.artifactManifests.renditions(resolved.manifest.sha256) ?? [];
    const exported = z.array(LocalRow).parse(this.runtime.store.db.prepare(`SELECT * FROM a2a_team_artifacts
      WHERE a2a_task_id=? AND peer=? AND context_id=? AND status='available' AND expires>?`)
      .all(resolved.a2a_task_id, resolved.peer, resolved.context_id, Date.now() / 1000));
    const forms: ArtifactRendition[] = local.length ? local : [ArtifactRenditionSchema.parse({ sha256: resolved.manifest.sha256,
      role: resolved.manifest.rendition?.role ?? 'original', mime: resolved.manifest.mime, size: resolved.manifest.size,
      purpose: resolved.manifest.rendition?.purpose ?? 'download' })];
    return forms.flatMap(form => {
      const row = exported.find(item => item.digest === form.sha256);
      return row ? [{ ...form, artifact_id: row.id, content_path: contentPath(row.id, row.context_id) }] : [];
    });
  }

  revokeLocal(peer: string, a2aTaskId: string, id: string): void {
    const changed = this.runtime.store.db.prepare(`UPDATE a2a_team_artifacts SET status='revoked'
      WHERE id=? AND peer=? AND a2a_task_id=? AND status='available'`).run(id, peer, a2aTaskId).changes;
    if (changed !== 1) throw new Error('Owned artifact export is unavailable');
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
