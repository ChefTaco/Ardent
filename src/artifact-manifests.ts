import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { isExecutionRef } from '@hivemagnus/hive-common/execution';
import { ARTIFACT_MAX_BYTES_LIMIT, ArtifactStoreError, formatBytes, type Artifact, type ArtifactInspector, type ArtifactSource, type ArtifactStore } from './artifacts.js';
import type { TaskStore } from './store.js';
import { ProvenNoEffectError } from './tools.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const safeName = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);

/**
 * Manifest 1.0, as peers exchange it over the v1 (single-response) team
 * transfer. Its size bound is that transfer's 2 MiB limit.
 */
export const TeamArtifactManifestSchema = z.object({
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
export type TeamArtifactManifest = z.infer<typeof TeamArtifactManifestSchema>;

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

const ExecutionRef = z.string().max(256).refine(isExecutionRef, 'Invalid execution reference');
/** Execution ancestry of an artifact: attribution only, never an authority. */
export const ArtifactExecutionSchema = z.object({ root: ExecutionRef, task: ExecutionRef.optional(), step: ExecutionRef.optional() }).strict();
export type ArtifactExecution = z.infer<typeof ArtifactExecutionSchema>;
export const RenditionRoleSchema = z.enum(['original', 'preview', 'model_input']);
const TransformParam = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
/** How a rendition was derived from its original. */
export const ArtifactTransformSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), version: z.string().min(1).max(64),
  params: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), TransformParam).refine(value => Object.keys(value).length <= 32, 'At most 32 transform parameters')
}).strict();
export type ArtifactTransform = z.infer<typeof ArtifactTransformSchema>;
const Purpose = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const ArtifactRenditionInfoSchema = z.object({ role: RenditionRoleSchema, of_sha256: digest, purpose: Purpose, transform: ArtifactTransformSchema }).strict();
/**
 * Manifest 1.1: a strict superset of 1.0 that may name the original a
 * rendition derives from and the execution that produced it. It is as
 * immutable as 1.0 and is shown only to transfer-v2 consumers.
 */
export const ArtifactManifest11Schema = ArtifactManifestSchema.extend({
  schema_version: z.literal('1.1'),
  provenance: ArtifactManifestSchema.shape.provenance.extend({ execution: ArtifactExecutionSchema.optional() }).strict(),
  rendition: ArtifactRenditionInfoSchema.optional()
}).strict();
export type ArtifactManifest11 = z.infer<typeof ArtifactManifest11Schema>;
/** A manifest 1.1 record, as transfer-v2 routes return it. */
export const ArtifactRecordV2Schema = z.object({ task_id: z.string(), superseded_by_sha256: digest.nullable(), manifest: ArtifactManifest11Schema }).strict();
export type ArtifactRecordV2 = z.infer<typeof ArtifactRecordV2Schema>;
/** One available form of an artifact (the HiveCommon `Rendition` shape plus its purpose). */
export const ArtifactRenditionSchema = z.object({ sha256: digest, role: RenditionRoleSchema, mime: z.string(), size: z.number().int().min(0),
  purpose: z.string(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), has_alpha: z.boolean().optional() }).strict();
export type ArtifactRendition = z.infer<typeof ArtifactRenditionSchema>;
const StoredManifest = z.discriminatedUnion('schema_version', [ArtifactManifestSchema, ArtifactManifest11Schema]);

/** The 1.0 view of a stored manifest: the fields 1.1 added are left out. A 1.0 manifest is returned as it is. */
export function manifestV10(manifest: ArtifactManifest | ArtifactManifest11): ArtifactManifest {
  if (manifest.schema_version === '1.0') return manifest;
  const provenance = { producer: manifest.provenance.producer, source_id: manifest.provenance.source_id,
    producer_task_id: manifest.provenance.producer_task_id, lineage: manifest.provenance.lineage };
  const copy: Record<string, unknown> = { ...manifest, schema_version: '1.0', provenance };
  delete copy.rendition;
  return ArtifactManifestSchema.parse(copy);
}
/** The 1.1 view of a stored manifest. A 1.0 manifest needs none of the optional 1.1 fields. */
export function manifestV11(manifest: ArtifactManifest | ArtifactManifest11): ArtifactManifest11 {
  return manifest.schema_version === '1.1' ? manifest : ArtifactManifest11Schema.parse({ ...manifest, schema_version: '1.1' });
}

const Row = z.object({ artifact_id: z.string(), task_id: z.string(), sha256: digest, manifest_json: z.string(), superseded_by: digest.nullable() });
const RenditionRow = z.object({ sha256: digest, role: RenditionRoleSchema, purpose: z.string(), mime: z.string(), size: z.number().int(),
  width: z.number().int().nullable(), height: z.number().int().nullable(), has_alpha: z.number().int().nullable() });
/** JSON artifacts registered from a stream are parsed whole; larger ones are refused. */
const JSON_STREAM_LIMIT = 8 * 1024 * 1024;
const EXTENSIONS: Record<ArtifactMime, string> = { 'text/markdown': 'md', 'text/plain': 'txt', 'application/json': 'json', 'text/csv': 'csv',
  'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };

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
 * Check streamed bytes against their declared media type as they arrive, with
 * the same rules as `checkArtifactContent`, without holding binary content.
 */
export function artifactContentInspector(mime: ArtifactMime): ArtifactInspector {
  const kind = ARTIFACT_MIME_TYPES[mime];
  const fail = (): never => { throw new ProvenNoEffectError(`Artifact content is not valid ${mime}`, 'INVALID_ARTIFACT'); };
  if (kind === 'png' || kind === 'jpeg' || kind === 'webp' || kind === 'pdf' || kind === 'docx') {
    let head = Buffer.alloc(0);
    return { write(chunk) { if (head.byteLength < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.byteLength)]); },
      end() { checkArtifactContent(mime, head); } };
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let length = 0;
  return {
    write(chunk) {
      length += chunk.byteLength;
      let decoded = '';
      try { decoded = decoder.decode(chunk, { stream: true }); } catch { fail(); }
      if (kind === 'json') { if (length > JSON_STREAM_LIMIT) throw new ProvenNoEffectError('Streamed JSON artifacts are limited to 8 MiB', 'ARTIFACT_TOO_LARGE'); text += decoded; }
      else if (kind === 'svg' && text.length < 4096) text += decoded.slice(0, 4096 - text.length);
    },
    end() {
      let rest = '';
      try { rest = decoder.decode(); } catch { fail(); }
      if (kind === 'json') { try { JSON.parse(text + rest); } catch { fail(); } }
      if (kind === 'svg' && !/<svg[\s>]/i.test((text + rest).slice(0, 4096))) fail();
    }
  };
}

/** Width, height and transparency of a PNG from its IHDR chunk, when the header is well formed. */
export function pngInfo(head: Uint8Array): { width: number; height: number; has_alpha: boolean } | undefined {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (bytes.byteLength < 26 || !startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) || bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), colorType = bytes[25];
  if (!width || !height || colorType === undefined) return undefined;
  return { width, height, has_alpha: colorType === 4 || colorType === 6 };
}

function storeRefusal(error: unknown): unknown {
  return error instanceof ArtifactStoreError ? new ProvenNoEffectError(error.message, error.code === 'SIZE_MISMATCH' ? 'DIGEST_MISMATCH' : error.code) : error;
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
        BEGIN SELECT RAISE(ABORT, 'Artifact manifests are immutable'); END;
      CREATE TABLE IF NOT EXISTS artifact_sweeps (sha256 TEXT PRIMARY KEY, outcome TEXT NOT NULL, swept_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_renditions (
        original_sha256 TEXT NOT NULL, rendition_sha256 TEXT NOT NULL, role TEXT NOT NULL, purpose TEXT NOT NULL,
        rendition_artifact_id TEXT NOT NULL REFERENCES artifact_manifests(artifact_id),
        width INTEGER, height INTEGER, has_alpha INTEGER, created_ms INTEGER NOT NULL,
        PRIMARY KEY(original_sha256, rendition_sha256));
      CREATE INDEX IF NOT EXISTS artifact_renditions_rendition ON artifact_renditions(rendition_sha256);
      CREATE TRIGGER IF NOT EXISTS artifact_renditions_immutable BEFORE UPDATE ON artifact_renditions
        BEGIN SELECT RAISE(ABORT, 'Artifact renditions are immutable'); END;`);
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
    this.store.db.transaction(() => this.#insert(input.taskId, manifest, created))();
    return { task_id: input.taskId, superseded_by_sha256: null, manifest };
  }

  /**
   * Stream bytes into the store for a task and record a manifest 1.1 for them.
   * The content check, size bound and any expected digest are applied while the
   * bytes arrive; a refusal stores nothing. `execution` is attribution only.
   */
  async registerStream(input: { taskId: string; name: string; mime: ArtifactMime; stream: ArtifactSource; source: string;
    expectedSha256?: string | undefined; expectedSize?: number | undefined; revisesSha256?: string | undefined;
    ttlSeconds?: number | undefined; execution?: ArtifactExecution | undefined; signal?: AbortSignal | undefined }): Promise<ArtifactRecordV2> {
    if (!safeName.safeParse(input.name).success) throw new ProvenNoEffectError('Invalid artifact name', 'INVALID_ARTIFACT');
    const mime = ArtifactMimeSchema.safeParse(input.mime);
    if (!mime.success) throw new ProvenNoEffectError('Unsupported artifact media type', 'INVALID_ARTIFACT');
    const execution = input.execution === undefined ? undefined : ArtifactExecutionSchema.safeParse(input.execution);
    if (execution && !execution.success) throw new ProvenNoEffectError('Invalid execution provenance', 'INVALID_ARTIFACT');
    if (!this.store.get(input.taskId)) throw new ProvenNoEffectError('Task not found', 'NOT_FOUND');
    const prior = input.revisesSha256 ? this.manifest(input.revisesSha256) : undefined;
    if (input.revisesSha256 && !prior) throw new ProvenNoEffectError('revises_sha256 does not name a current artifact', 'NOT_FOUND');
    const stored = await this.#putStream(input.stream, input.name, mime.data, input);
    if (prior && prior.manifest.sha256 === stored.sha256)
      throw new ProvenNoEffectError('Revision content is identical to the revised artifact', 'INVALID_ARTIFACT');
    const created = Date.now();
    const manifest = ArtifactManifest11Schema.parse({
      ...this.#baseManifest(stored, mime.data, created, input.ttlSeconds), schema_version: '1.1',
      revision: prior ? prior.manifest.revision + 1 : 1, supersedes_sha256: prior?.manifest.sha256 ?? null,
      provenance: { producer: this.producer, source_id: input.source, producer_task_id: input.taskId,
        lineage: [{ producer: this.producer, source_id: input.source }], ...(execution?.data ? { execution: execution.data } : {}) }
    });
    this.store.db.transaction(() => this.#insert(input.taskId, manifest, created))();
    return { task_id: input.taskId, superseded_by_sha256: null, manifest };
  }

  /**
   * Register a preview or model-input rendition of a current original. The
   * rendition is a separate artifact with its own digest and a manifest 1.1
   * that names the original; the original is never changed. Registering the
   * same bytes for the same original again returns the existing record.
   */
  async registerRendition(input: { originalSha256: string; role: 'preview' | 'model_input'; purpose: string; transform: ArtifactTransform;
    mime: ArtifactMime; bytes?: Uint8Array | undefined; stream?: ArtifactSource | undefined; name?: string | undefined;
    width?: number | undefined; height?: number | undefined; has_alpha?: boolean | undefined; producer?: string | undefined;
    signal?: AbortSignal | undefined }): Promise<ArtifactRecordV2> {
    if ((input.bytes === undefined) === (input.stream === undefined)) throw new ProvenNoEffectError('Give exactly one of bytes or stream', 'INVALID_ARTIFACT');
    const mime = ArtifactMimeSchema.safeParse(input.mime);
    const info = z.object({ role: z.enum(['preview', 'model_input']), purpose: Purpose, transform: ArtifactTransformSchema,
      width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), has_alpha: z.boolean().optional(),
      producer: z.string().min(1).max(128).optional() }).safeParse({ role: input.role, purpose: input.purpose, transform: input.transform,
      width: input.width, height: input.height, has_alpha: input.has_alpha, producer: input.producer });
    if (!mime.success || !info.success) throw new ProvenNoEffectError('Invalid rendition', 'INVALID_ARTIFACT');
    const original = this.manifestV2(input.originalSha256);
    if (!original) throw new ProvenNoEffectError('Original artifact has no current manifest', 'NOT_FOUND');
    if (original.manifest.rendition && original.manifest.rendition.role !== 'original')
      throw new ProvenNoEffectError('A rendition derives from an original, not from another rendition', 'INVALID_ARTIFACT');
    const stem = original.manifest.name.replace(/\.[A-Za-z0-9]{1,8}$/, '').slice(0, 100);
    const name = input.name ?? `${stem}.${input.role === 'preview' ? 'preview' : 'model-input'}.${EXTENSIONS[mime.data]}`;
    if (!safeName.safeParse(name).success) throw new ProvenNoEffectError('Invalid artifact name', 'INVALID_ARTIFACT');
    const stored = await this.#putStream(input.stream ?? Readable.from([input.bytes ?? new Uint8Array()]), name, mime.data, input);
    if (stored.sha256 === original.manifest.sha256) throw new ProvenNoEffectError('A rendition must differ from its original', 'INVALID_ARTIFACT');
    const existing = this.store.db.prepare('SELECT rendition_artifact_id FROM artifact_renditions WHERE original_sha256=? AND rendition_sha256=?')
      .get(original.manifest.sha256, stored.sha256);
    if (existing) {
      const prior = this.#byId(z.object({ rendition_artifact_id: identifier }).parse(existing).rendition_artifact_id);
      if (prior) return prior;
    }
    const producer = info.data.producer ?? this.producer;
    const created = Date.now();
    const sourceId = `ardent-artifact:${original.manifest.sha256}`;
    const manifest = ArtifactManifest11Schema.parse({
      ...this.#baseManifest(stored, mime.data, created, undefined), schema_version: '1.1',
      visibility: original.manifest.visibility, license: original.manifest.license, expires_at: original.manifest.expires_at,
      provenance: { producer, source_id: sourceId, producer_task_id: original.task_id,
        lineage: [...original.manifest.provenance.lineage.slice(-3), { producer, source_id: sourceId }],
        ...(original.manifest.provenance.execution ? { execution: original.manifest.provenance.execution } : {}) },
      rendition: { role: info.data.role, of_sha256: original.manifest.sha256, purpose: info.data.purpose, transform: info.data.transform }
    });
    this.store.db.transaction(() => {
      this.#insert(original.task_id, manifest, created, 'artifact_rendition_registered');
      this.store.db.prepare(`INSERT INTO artifact_renditions(original_sha256,rendition_sha256,role,purpose,rendition_artifact_id,width,height,has_alpha,created_ms)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(original.manifest.sha256, stored.sha256, info.data.role, info.data.purpose, manifest.artifact_id,
        info.data.width ?? null, info.data.height ?? null, info.data.has_alpha === undefined ? null : info.data.has_alpha ? 1 : 0, created);
    })();
    return { task_id: original.task_id, superseded_by_sha256: null, manifest };
  }

  /**
   * Record a manifest 1.1 for bytes already in the store, received from a peer.
   * The peer's manifest supplies name, media type, revision and provenance; the
   * local record adds the peer hop to the lineage and does not expire.
   */
  async registerImported(input: { taskId: string; peer: string; remoteTaskId: string; manifest: ArtifactManifest11;
    /** A stable local manifest ID; registering the same ID again returns the existing record. */
    artifactId?: string | undefined;
    /** Runs in the registering transaction, for example to settle the import that produced the bytes. */
    onRegistered?: (() => void) | undefined }): Promise<ArtifactRecordV2> {
    if (input.artifactId !== undefined && !identifier.safeParse(input.artifactId).success) throw new ProvenNoEffectError('Invalid artifact ID', 'INVALID_ARTIFACT');
    const already = input.artifactId === undefined ? undefined : this.#byId(input.artifactId);
    if (already) { this.store.db.transaction(() => input.onRegistered?.())(); return already; }
    const remote = ArtifactManifest11Schema.parse(input.manifest);
    const mime = ArtifactMimeSchema.safeParse(remote.mime);
    if (!mime.success) throw new ProvenNoEffectError('Unsupported artifact media type', 'INVALID_ARTIFACT');
    // The store is content-addressed and its writers verify digests; check the size and the content rules.
    const stored = await this.artifacts.stat(remote.sha256);
    if (!stored || stored.size !== remote.size) throw new ProvenNoEffectError('Stored artifact size differs from its manifest', 'DIGEST_MISMATCH');
    const binary = ['png', 'jpeg', 'webp', 'pdf', 'docx'].includes(ARTIFACT_MIME_TYPES[mime.data]);
    const read = await this.artifacts.openRead(remote.sha256, binary && stored.size > 0 ? { start: 0, end: Math.min(15, stored.size - 1) } : {});
    const inspector = artifactContentInspector(mime.data);
    for await (const chunk of read.stream) inspector.write(z.instanceof(Buffer).parse(chunk));
    inspector.end();
    const created = Date.now();
    const hop = { producer: `a2a:${input.peer}`.slice(0, 200), source_id: `a2a-task:${input.remoteTaskId}`.slice(0, 300) };
    const manifest = ArtifactManifest11Schema.parse({ ...remote, created_at: created / 1000, expires_at: NO_EXPIRY_SECONDS,
      artifact_id: input.artifactId ?? randomBytes(16).toString('hex'),
      provenance: { ...remote.provenance, producer_task_id: input.remoteTaskId, lineage: [...remote.provenance.lineage.slice(-3), hop] } });
    this.store.db.transaction(() => { this.#insert(input.taskId, manifest, created); input.onRegistered?.(); })();
    return { task_id: input.taskId, superseded_by_sha256: null, manifest };
  }

  /**
   * Delete the bytes of artifacts whose every manifest has expired, unless a
   * task outside preview still refers to the digest in its journal.
   */
  async sweepExpired(nowMs = Date.now()): Promise<{ deleted: string[]; retained: string[] }> {
    const candidates = z.array(z.object({ sha256: digest })).parse(this.store.db.prepare(`SELECT DISTINCT m.sha256 FROM artifact_manifests m
      WHERE m.expires_ms<=? AND NOT EXISTS (SELECT 1 FROM artifact_manifests n WHERE n.sha256=m.sha256 AND n.expires_ms>?)
        AND NOT EXISTS (SELECT 1 FROM artifact_sweeps s WHERE s.sha256=m.sha256
          AND s.swept_ms>=(SELECT max(k.created_ms) FROM artifact_manifests k WHERE k.sha256=m.sha256)) LIMIT 100`).all(nowMs, nowMs)).map(row => row.sha256);
    const result = { deleted: [] as string[], retained: [] as string[] };
    for (const sha of candidates) {
      const referenced = this.store.db.prepare(`SELECT 1 FROM events e JOIN tasks t ON t.id=e.task_id
        WHERE t.context!='preview' AND instr(e.detail_json, ?)>0 LIMIT 1`).get(sha);
      if (!referenced) await this.artifacts.delete(sha);
      this.store.db.prepare('INSERT OR REPLACE INTO artifact_sweeps(sha256,outcome,swept_ms) VALUES (?,?,?)').run(sha, referenced ? 'retained' : 'deleted', nowMs);
      (referenced ? result.retained : result.deleted).push(sha);
    }
    return result;
  }

  /**
   * Current (unexpired) manifests a task registered, oldest first, as 1.0.
   * Renditions are listed with their original (`renditions`), not here.
   */
  forTask(taskId: string, limit = 100): ArtifactRecord[] {
    return this.store.db.prepare(`${this.#select} WHERE m.task_id=? AND m.expires_ms>?
      AND NOT EXISTS (SELECT 1 FROM artifact_renditions r WHERE r.rendition_artifact_id=m.artifact_id)
      ORDER BY m.created_ms, m.artifact_id LIMIT ?`)
      .all(taskId, Date.now(), Math.max(1, Math.min(limit, 500))).map(raw => this.#v10(this.#record(raw)));
  }

  /** The newest current manifest for a digest, as 1.0. */
  manifest(sha256: string): ArtifactRecord | undefined {
    const record = this.#newest(sha256);
    return record ? this.#v10(record) : undefined;
  }

  /** The newest current manifest for a digest, as 1.1 (for transfer-v2 consumers). */
  manifestV2(sha256: string): ArtifactRecordV2 | undefined {
    const record = this.#newest(sha256);
    return record ? { ...record, manifest: manifestV11(record.manifest) } : undefined;
  }

  /**
   * Every current form of an artifact, the original first: given an original or
   * any of its renditions, the same list. Undefined when the digest has no
   * current manifest.
   */
  async renditions(sha256: string): Promise<ArtifactRendition[] | undefined> {
    const record = this.manifestV2(sha256);
    if (!record) return undefined;
    const ofSha = record.manifest.rendition && record.manifest.rendition.role !== 'original' ? record.manifest.rendition.of_sha256 : record.manifest.sha256;
    const original = ofSha === record.manifest.sha256 ? record : this.manifestV2(ofSha);
    const list: ArtifactRendition[] = [];
    if (original) {
      let dimensions: ReturnType<typeof pngInfo>;
      if (original.manifest.mime === 'image/png') {
        try {
          const head = await this.artifacts.openRead(original.manifest.sha256, { start: 0, end: Math.min(31, original.manifest.size - 1) });
          const chunks: Buffer[] = [];
          for await (const chunk of head.stream) chunks.push(z.instanceof(Buffer).parse(chunk));
          dimensions = pngInfo(Buffer.concat(chunks));
        } catch { dimensions = undefined; }
      }
      list.push(ArtifactRenditionSchema.parse({ sha256: original.manifest.sha256, role: 'original', mime: original.manifest.mime,
        size: original.manifest.size, purpose: 'download', ...(dimensions ?? {}) }));
    }
    const rows = this.store.db.prepare(`SELECT r.rendition_sha256 AS sha256, r.role, r.purpose, m.mime, m.size, r.width, r.height, r.has_alpha
      FROM artifact_renditions r JOIN artifact_manifests m ON m.artifact_id=r.rendition_artifact_id
      WHERE r.original_sha256=? AND m.expires_ms>? ORDER BY r.created_ms, r.rendition_sha256`).all(ofSha, Date.now());
    for (const raw of rows) {
      const row = RenditionRow.parse(raw);
      list.push(ArtifactRenditionSchema.parse({ sha256: row.sha256, role: row.role, mime: row.mime, size: row.size, purpose: row.purpose,
        ...(row.width === null ? {} : { width: row.width }), ...(row.height === null ? {} : { height: row.height }),
        ...(row.has_alpha === null ? {} : { has_alpha: row.has_alpha === 1 }) }));
    }
    return list;
  }

  readonly #select = `SELECT m.artifact_id, m.task_id, m.sha256, m.manifest_json,
    (SELECT n.sha256 FROM artifact_manifests n WHERE n.supersedes_sha256=m.sha256 ORDER BY n.created_ms DESC LIMIT 1) AS superseded_by
    FROM artifact_manifests m`;

  #newest(sha256: string): { task_id: string; superseded_by_sha256: string | null; manifest: ArtifactManifest | ArtifactManifest11 } | undefined {
    if (!digest.safeParse(sha256).success) return undefined;
    const raw = this.store.db.prepare(`${this.#select} WHERE m.sha256=? AND m.expires_ms>? ORDER BY m.created_ms DESC, m.artifact_id DESC LIMIT 1`)
      .get(sha256, Date.now());
    return raw ? this.#record(raw) : undefined;
  }

  #byId(id: string): ArtifactRecordV2 | undefined {
    const raw = this.store.db.prepare(`${this.#select} WHERE m.artifact_id=?`).get(id);
    if (!raw) return undefined;
    const record = this.#record(raw);
    return { ...record, manifest: manifestV11(record.manifest) };
  }

  #record(raw: unknown): { task_id: string; superseded_by_sha256: string | null; manifest: ArtifactManifest | ArtifactManifest11 } {
    const row = Row.parse(raw);
    return { task_id: row.task_id, superseded_by_sha256: row.superseded_by,
      manifest: StoredManifest.parse(JSON.parse(row.manifest_json) as unknown) };
  }

  #v10(record: { task_id: string; superseded_by_sha256: string | null; manifest: ArtifactManifest | ArtifactManifest11 }): ArtifactRecord {
    return { ...record, manifest: manifestV10(record.manifest) };
  }

  #baseManifest(stored: Artifact, mime: ArtifactMime, created: number, ttlSeconds: number | undefined) {
    return { revision: 1, source_revision: stored.sha256, visibility: 'private', license: 'NOASSERTION',
      preview: { mode: mime === 'application/pdf' || ARTIFACT_MIME_TYPES[mime] === 'docx' ? 'download_only' : 'inline', mime },
      supersedes_sha256: null, acceptance_status: 'unreviewed', name: stored.name, mime, sha256: stored.sha256, size: stored.bytes,
      created_at: created / 1000, expires_at: ttlSeconds ? created / 1000 + ttlSeconds : NO_EXPIRY_SECONDS,
      recovery: { on_expiry: 'request_verified_reexport' }, artifact_id: randomBytes(16).toString('hex') } as const;
  }

  async #putStream(stream: ArtifactSource, name: string, mime: ArtifactMime,
    options: { expectedSha256?: string | undefined; expectedSize?: number | undefined; signal?: AbortSignal | undefined }): Promise<Artifact> {
    try {
      return await this.artifacts.putStream(stream, { name, mediaType: mime, expectedSha256: options.expectedSha256,
        expectedSize: options.expectedSize, inspect: artifactContentInspector(mime), signal: options.signal });
    } catch (error: unknown) { throw storeRefusal(error); }
  }

  /** Insert a manifest and journal it on its task. Call inside a transaction. */
  #insert(taskId: string, manifest: ArtifactManifest | ArtifactManifest11, created: number, kind = 'artifact_registered'): void {
    this.store.db.prepare(`INSERT INTO artifact_manifests(artifact_id,task_id,sha256,name,mime,size,revision,supersedes_sha256,manifest_json,created_ms,expires_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(manifest.artifact_id, taskId, manifest.sha256, manifest.name, manifest.mime, manifest.size,
      manifest.revision, manifest.supersedes_sha256, JSON.stringify(manifest), created, Math.floor(manifest.expires_at * 1000));
    this.store.append(taskId, kind, { artifact_id: manifest.artifact_id, name: manifest.name, mime: manifest.mime,
      sha256: manifest.sha256, size: manifest.size, revision: manifest.revision, supersedes_sha256: manifest.supersedes_sha256, manifest });
  }
}
