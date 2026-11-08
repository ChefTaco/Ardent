import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ARTIFACT_MAX_BYTES_LIMIT, formatBytes, type ArtifactStore } from './artifacts.js';
import type { TaskStore } from './store.js';
import { TeamArtifactManifestSchema } from './team-artifacts.js';
import { ProvenNoEffectError } from './tools.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Media types an agent may register, with the bytes each must start with (binary) or the text it must hold. */
export const ARTIFACT_MIME_TYPES = {
  'text/markdown': 'text', 'text/plain': 'text', 'application/json': 'json', 'text/csv': 'text', 'image/svg+xml': 'svg',
  'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
} as const;
export type ArtifactMime = keyof typeof ARTIFACT_MIME_TYPES;
export const ArtifactMimeSchema = z.enum(['text/markdown', 'text/plain', 'application/json', 'text/csv', 'image/svg+xml', 'image/png', 'image/jpeg',
  'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) satisfies z.ZodType<ArtifactMime>;
/** Local artifacts never expire unless they were produced by a preview; the manifest field is still required. */
export const NO_EXPIRY_SECONDS = 253402300799;

/** Manifest of a registered artifact: the peer export manifest with the profile's larger size bound. */
export const ArtifactManifestSchema = TeamArtifactManifestSchema.extend({ size: z.number().int().min(0).max(ARTIFACT_MAX_BYTES_LIMIT) }).strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
/** A manifest with the task that produced it and the artifact that later revised it, if any. */
export const ArtifactRecordSchema = z.object({ task_id: z.string(), superseded_by_sha256: digest.nullable(), manifest: ArtifactManifestSchema }).strict();
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

const Row = z.object({ artifact_id: z.string(), task_id: z.string(), sha256: digest, manifest_json: z.string(), superseded_by: digest.nullable() });

function startsWith(bytes: Uint8Array, ...prefix: number[]): boolean { return prefix.every((value, index) => bytes[index] === value); }

/** Reject bytes that are not what their declared media type says. Text must be valid UTF-8. */
export function checkArtifactContent(mime: ArtifactMime, bytes: Uint8Array): void {
  const kind = ARTIFACT_MIME_TYPES[mime];
  const fail = () => { throw new ProvenNoEffectError(`Artifact content is not valid ${mime}`, 'INVALID_ARTIFACT'); };
  if (kind === 'png') { if (!startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) fail(); return; }
  if (kind === 'jpeg') { if (!startsWith(bytes, 0xff, 0xd8, 0xff)) fail(); return; }
  if (kind === 'webp') { if (!startsWith(bytes, 0x52, 0x49, 0x46, 0x46) || Buffer.from(bytes.subarray(8, 12)).toString('latin1') !== 'WEBP') fail(); return; }
  if (kind === 'pdf') { if (!startsWith(bytes, 0x25, 0x50, 0x44, 0x46, 0x2d)) fail(); return; }
  if (kind === 'docx') { if (!startsWith(bytes, 0x50, 0x4b, 0x03, 0x04)) fail(); return; }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail(); }
  if (kind === 'json') { try { JSON.parse(text); } catch { fail(); } }
  if (kind === 'svg' && !/<svg[\s>]/i.test(text.slice(0, 4096))) fail();
}

/**
 * Registered artifacts with their manifests. A manifest is an immutable producer
 * record; a later artifact may revise (supersede) an earlier one by digest.
 */
export class ArtifactManifests {
  constructor(readonly store: TaskStore, readonly artifacts: ArtifactStore, readonly producer: string) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS artifact_manifests (
      artifact_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sha256 TEXT NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, revision INTEGER NOT NULL,
      supersedes_sha256 TEXT, manifest_json TEXT NOT NULL, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS artifact_manifests_task ON artifact_manifests(task_id, created_ms);
      CREATE INDEX IF NOT EXISTS artifact_manifests_sha ON artifact_manifests(sha256, created_ms);
      CREATE INDEX IF NOT EXISTS artifact_manifests_supersedes ON artifact_manifests(supersedes_sha256);
      CREATE TRIGGER IF NOT EXISTS artifact_manifests_immutable BEFORE UPDATE ON artifact_manifests
        BEGIN SELECT RAISE(ABORT, 'Artifact manifests are immutable'); END;`);
  }

  /**
   * Store bytes for a task and record their manifest and an `artifact_registered`
   * journal event. `revisesSha256` must name a current registered artifact.
   */
  async register(input: { taskId: string; name: string; mime: ArtifactMime; bytes: Uint8Array; source: string;
    revisesSha256?: string | undefined; ttlSeconds?: number | undefined }): Promise<ArtifactRecord> {
    // Every check that can refuse the artifact runs before any byte is stored.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.name)) throw new ProvenNoEffectError('Invalid artifact name', 'INVALID_ARTIFACT');
    if (input.bytes.length > this.artifacts.maxBytes) throw new ProvenNoEffectError(`Artifact exceeds ${formatBytes(this.artifacts.maxBytes)}`, 'ARTIFACT_TOO_LARGE');
    checkArtifactContent(input.mime, input.bytes);
    const prior = input.revisesSha256 ? this.manifest(input.revisesSha256) : undefined;
    if (input.revisesSha256 && !prior) throw new ProvenNoEffectError('revises_sha256 does not name a current artifact', 'NOT_FOUND');
    if (prior && prior.manifest.sha256 === createHash('sha256').update(input.bytes).digest('hex'))
      throw new ProvenNoEffectError('Revision content is identical to the revised artifact', 'INVALID_ARTIFACT');
    const stored = await this.artifacts.put(input.name, input.mime, input.bytes);
    const created = Date.now();
    const id = randomBytes(16).toString('hex');
    const manifest: ArtifactManifest = ArtifactManifestSchema.parse({
      schema_version: '1.0', revision: prior ? prior.manifest.revision + 1 : 1, source_revision: stored.sha256,
      visibility: 'private', license: 'NOASSERTION',
      preview: { mode: input.mime === 'application/pdf' || ARTIFACT_MIME_TYPES[input.mime] === 'docx' ? 'download_only' : 'inline', mime: input.mime },
      supersedes_sha256: prior?.manifest.sha256 ?? null, acceptance_status: 'unreviewed', name: input.name, mime: input.mime,
      sha256: stored.sha256, size: stored.bytes, created_at: created / 1000,
      expires_at: input.ttlSeconds ? created / 1000 + input.ttlSeconds : NO_EXPIRY_SECONDS,
      provenance: { producer: this.producer, source_id: input.source, producer_task_id: input.taskId,
        lineage: [{ producer: this.producer, source_id: input.source }] },
      recovery: { on_expiry: 'request_verified_reexport' }, artifact_id: id
    });
    this.store.db.transaction(() => {
      this.store.db.prepare(`INSERT INTO artifact_manifests(artifact_id,task_id,sha256,name,mime,size,revision,supersedes_sha256,manifest_json,created_ms,expires_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.taskId, manifest.sha256, manifest.name, manifest.mime, manifest.size,
        manifest.revision, manifest.supersedes_sha256, JSON.stringify(manifest), created, Math.floor(manifest.expires_at * 1000));
      this.store.append(input.taskId, 'artifact_registered', { artifact_id: id, name: manifest.name, mime: manifest.mime,
        sha256: manifest.sha256, size: manifest.size, revision: manifest.revision, supersedes_sha256: manifest.supersedes_sha256, manifest });
    })();
    return { task_id: input.taskId, superseded_by_sha256: null, manifest };
  }

  /** Current (unexpired) manifests a task registered, oldest first. */
  forTask(taskId: string, limit = 100): ArtifactRecord[] {
    return this.store.db.prepare(`${this.#select} WHERE m.task_id=? AND m.expires_ms>? ORDER BY m.created_ms, m.artifact_id LIMIT ?`)
      .all(taskId, Date.now(), Math.max(1, Math.min(limit, 500))).map(raw => this.#record(raw));
  }

  /** The newest current manifest for a digest. */
  manifest(sha256: string): ArtifactRecord | undefined {
    if (!digest.safeParse(sha256).success) return undefined;
    const raw = this.store.db.prepare(`${this.#select} WHERE m.sha256=? AND m.expires_ms>? ORDER BY m.created_ms DESC, m.artifact_id DESC LIMIT 1`)
      .get(sha256, Date.now());
    return raw ? this.#record(raw) : undefined;
  }

  readonly #select = `SELECT m.artifact_id, m.task_id, m.sha256, m.manifest_json,
    (SELECT n.sha256 FROM artifact_manifests n WHERE n.supersedes_sha256=m.sha256 ORDER BY n.created_ms DESC LIMIT 1) AS superseded_by
    FROM artifact_manifests m`;

  #record(raw: unknown): ArtifactRecord {
    const row = Row.parse(raw);
    return { task_id: row.task_id, superseded_by_sha256: row.superseded_by,
      manifest: ArtifactManifestSchema.parse(JSON.parse(row.manifest_json) as unknown) };
  }
}
