import { createHash, randomBytes, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TaskState, type AgentCard, type Task } from '@a2a-js/sdk';
import { ARTIFACT_TRANSFER_ERRORS, ARTIFACT_TRANSFER_V1_MAX_BYTES, ARTIFACT_TRANSFER_V2_MEDIA_TYPE, ARTIFACT_TRANSFER_V2_URN,
  parseReprDigest } from '@hivemagnus/hive-common/artifact';
import type { RetryPolicy } from '@hivemagnus/hive-common/retry';
import { responseFailure, RetryStoppedError, retryWithPolicy, type AttemptFailure } from './retry.js';
import { ArdentA2AClient } from './a2a-client.js';
import { ARTIFACT_MIME_TYPES, ArtifactManifest11Schema, ArtifactMimeSchema, artifactContentInspector, manifestV11, TeamArtifactManifestSchema,
  type ArtifactManifest11 } from './artifact-manifests.js';
import { ArtifactStoreError, hashFileRange } from './artifacts.js';
import type { ArdentRuntime } from './runtime.js';
import { TeamArtifactDescriptorSchema, TeamArtifactDescriptorV2Schema, TeamArtifactRequiresV2Schema } from './team-artifacts.js';
import { ProvenNoEffectError } from './tools.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-f0-9]{32}$/);

export const ArtifactImportStateSchema = z.enum(['queued', 'transferring', 'verifying', 'completed', 'failed']);
export type ArtifactImportState = z.infer<typeof ArtifactImportStateSchema>;
/** Ask this profile to pull one artifact a peer exported from one of its A2A tasks. */
export const ArtifactImportRequestSchema = z.object({
  peer_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), a2a_task_id: z.string().min(1).max(256), artifact_id: identifier,
  /** A local task to attach the imported artifact to; without one, the import records its own completed task. */
  task_id: z.string().guid().optional()
}).strict();
export type ArtifactImportRequest = z.infer<typeof ArtifactImportRequestSchema>;
export const ArtifactImportSchema = z.object({
  import_id: identifier, peer_id: z.string(), a2a_task_id: z.string(), artifact_id: identifier, state: ArtifactImportStateSchema,
  received_bytes: z.number().int().min(0), size: z.number().int().min(0).nullable(), sha256: digest.nullable(),
  mime: z.string().nullable(), name: z.string().nullable(), protocol: z.enum(['v1', 'v2']).nullable(), attempts: z.number().int().min(0),
  local_task_id: z.string().nullable(), error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  created_ms: z.number().int(), updated_ms: z.number().int()
}).strict();
export type ArtifactImport = z.infer<typeof ArtifactImportSchema>;

/** A transfer outcome. `retryable` failures are transport problems a resumed attempt may get past. */
export class ArtifactTransferError extends Error {
  /** What a retryable failure tells the retry policy (a transport error unless a response said otherwise). */
  readonly failure: AttemptFailure | undefined;
  constructor(message: string, readonly code: string, retryable: boolean | AttemptFailure = false) {
    super(message);
    this.name = 'ArtifactTransferError';
    this.failure = retryable === true ? { network: true } : retryable === false ? undefined : retryable;
  }
  get retryable(): boolean { return this.failure !== undefined; }
}

export type ArtifactTransferOptions = {
  fetch?: typeof fetch;
  /** Commit `received_bytes` (after an fsync) at least this often. Default 4 MiB. */
  commitBytes?: number;
  /** Abort a response that delivers no byte for this long. Default 60 s. */
  idleTimeoutMs?: number;
  /** Total time one run may spend retrying transport failures. Default 30 min. */
  deadlineMs?: number;
  /** Defaults to the named `artifact_transfer` policy in `src/retry.ts`. */
  retryPolicy?: RetryPolicy;
  /** Observe progress, for example to report it. Never called with more than `size`. */
  onProgress?: (progress: { import_id: string; received_bytes: number; size: number }) => void;
};

const Row = z.object({
  id: identifier, peer_id: z.string(), a2a_task_id: z.string(), artifact_id: identifier, sha256: digest.nullable(), size: z.number().int().nullable(),
  mime: z.string().nullable(), name: z.string().nullable(), received_bytes: z.number().int(), state: ArtifactImportStateSchema,
  partial_path: z.string(), attempts: z.number().int(), error: z.string().nullable(), error_code: z.string().nullable(),
  context_id: z.string().nullable(), protocol: z.enum(['v1', 'v2']).nullable(), content_path: z.string().nullable(),
  manifest_json: z.string().nullable(), manifest_1_0_json: z.string().nullable(), caller: z.string(), local_task_id: z.string().nullable(),
  created_ms: z.number().int(), updated_ms: z.number().int()
});
type ImportRow = z.infer<typeof Row>;
type Resolved = ImportRow & { sha256: string; size: number; mime: string; name: string; protocol: 'v1' | 'v2'; content_path: string; manifest_json: string };

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function texts(task: Task): string[] {
  return task.artifacts.flatMap(artifact => artifact.parts.flatMap(part =>
    part.content?.$case === 'text' && typeof part.content.value === 'string' ? [part.content.value] : []));
}
function v2Parts(task: Task): unknown[] {
  return task.artifacts.flatMap(artifact => artifact.parts.flatMap(part =>
    part.content?.$case === 'data' && part.mediaType === ARTIFACT_TRANSFER_V2_MEDIA_TYPE ? [part.content.value] : []));
}
function parseEach<T>(values: unknown[], schema: z.ZodType<T>): T[] {
  return values.flatMap(value => { const parsed = schema.safeParse(value); return parsed.success ? [parsed.data] : []; });
}
function json(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { return undefined; } }
/** The transfer-v2 parameters a peer card advertises, or undefined. */
export function peerTransferV2(card: AgentCard): { max_bytes?: number } | undefined {
  const extension = card.capabilities?.extensions.find(item => item.uri === ARTIFACT_TRANSFER_V2_URN);
  if (!extension) return undefined;
  const params = z.object({ max_bytes: z.number().int().positive().optional() }).passthrough().safeParse(extension.params ?? {});
  return params.success && params.data.max_bytes !== undefined ? { max_bytes: params.data.max_bytes } : {};
}
function jsonRpcOrigin(card: AgentCard): string {
  const url = card.supportedInterfaces.find(item => item.protocolBinding.toUpperCase() === 'JSONRPC' && item.protocolVersion === '1.0')?.url;
  if (!url) throw new ArtifactTransferError('Remote peer has no pinned JSON-RPC origin', 'PEER_UNSUPPORTED');
  return url;
}
async function writeAll(file: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength;)
    offset += (await file.write(bytes, offset, bytes.byteLength - offset, position + offset)).bytesWritten;
}

/**
 * Resumable pulls of peer artifacts (transfer v2, with the v1 path for older
 * peers up to 2 MiB). Progress lives in `artifact_transfers` and a partial file
 * under `<profile>/artifacts/.partial/<import id>`; a restart re-hashes the
 * retained bytes as a stream and asks the peer for the rest with Range and
 * If-Range. The finished file is verified, renamed into the content store and
 * registered with a manifest 1.1 that records the peer hop.
 */
export class ArtifactTransfers {
  readonly #running = new Map<string, Promise<ArtifactImport>>();
  readonly #fetch: typeof fetch;
  constructor(readonly runtime: ArdentRuntime, readonly env: NodeJS.ProcessEnv = process.env, readonly options: ArtifactTransferOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    runtime.store.db.exec(`CREATE TABLE IF NOT EXISTS artifact_transfers (
      id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, a2a_task_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
      sha256 TEXT, size INTEGER, mime TEXT, name TEXT, received_bytes INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
      partial_path TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, error_code TEXT,
      context_id TEXT, protocol TEXT, content_path TEXT, manifest_json TEXT, manifest_1_0_json TEXT,
      caller TEXT NOT NULL, local_task_id TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
      UNIQUE(peer_id, a2a_task_id, artifact_id));
      CREATE INDEX IF NOT EXISTS artifact_transfers_state ON artifact_transfers(state, updated_ms);`);
  }

  /**
   * Record an import, or return the existing one for the same peer, task and
   * artifact. A failed import is queued again from what it retained: that is
   * the operator's explicit reissue.
   */
  request(input: ArtifactImportRequest, caller = 'management'): ArtifactImport {
    const request = ArtifactImportRequestSchema.parse(input);
    if (request.task_id && !this.runtime.store.get(request.task_id)) throw new Error('Local task not found');
    const db = this.runtime.store.db;
    return db.transaction(() => {
      const existing = db.prepare('SELECT * FROM artifact_transfers WHERE peer_id=? AND a2a_task_id=? AND artifact_id=?')
        .get(request.peer_id, request.a2a_task_id, request.artifact_id);
      if (existing) {
        const row = Row.parse(existing);
        if (row.state === 'failed') db.prepare(`UPDATE artifact_transfers SET state='queued',error=NULL,error_code=NULL,updated_ms=? WHERE id=?`).run(Date.now(), row.id);
        return this.#view(this.#row(row.id));
      }
      const id = randomBytes(16).toString('hex');
      const now = Date.now();
      db.prepare(`INSERT INTO artifact_transfers(id,peer_id,a2a_task_id,artifact_id,state,partial_path,caller,local_task_id,created_ms,updated_ms)
        VALUES (?,?,?,?,'queued',?,?,?,?,?)`).run(id, request.peer_id, request.a2a_task_id, request.artifact_id,
        join(this.runtime.artifacts.partialDirectory, id), caller, request.task_id ?? null, now, now);
      return this.#view(this.#row(id));
    })();
  }

  /** Record an import and run it in the background. */
  start(input: ArtifactImportRequest, caller = 'management'): ArtifactImport {
    const record = this.request(input, caller);
    if (record.state !== 'completed') void this.run(record.import_id).catch(() => { /* The row keeps the outcome. */ });
    return record;
  }

  /** Resume every import a previous process left unfinished. */
  resumePending(): string[] {
    const ids = z.array(z.object({ id: identifier })).parse(this.runtime.store.db.prepare(
      `SELECT id FROM artifact_transfers WHERE state IN ('queued','transferring','verifying') ORDER BY created_ms LIMIT 100`).all()).map(row => row.id);
    for (const id of ids) void this.run(id).catch(() => { /* The row keeps the outcome. */ });
    return ids;
  }

  get(id: string): ArtifactImport | undefined {
    if (!identifier.safeParse(id).success) return undefined;
    const raw = this.runtime.store.db.prepare('SELECT * FROM artifact_transfers WHERE id=?').get(id);
    return raw ? this.#view(Row.parse(raw)) : undefined;
  }

  list(limit = 50): ArtifactImport[] {
    return this.runtime.store.db.prepare('SELECT * FROM artifact_transfers ORDER BY created_ms DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 200))).map(raw => this.#view(Row.parse(raw)));
  }

  /**
   * Run (or resume) an import to its outcome. An abort leaves it resumable.
   * Concurrent calls for one import share a single run.
   */
  run(id: string, signal?: AbortSignal): Promise<ArtifactImport> {
    const active = this.#running.get(id);
    if (active) return active;
    const running = this.#execute(id, signal).finally(() => this.#running.delete(id));
    this.#running.set(id, running);
    return running;
  }

  async #execute(id: string, signal: AbortSignal | undefined): Promise<ArtifactImport> {
    let row = this.#row(id);
    if (row.state === 'completed' || row.state === 'failed') return this.#view(row);
    const deadlineMs = Date.now() + (this.options.deadlineMs ?? 30 * 60_000);
    this.#set(id, { state: row.state === 'verifying' ? 'verifying' : 'transferring', attempts: row.attempts + 1 });
    try {
      const policy = this.options.retryPolicy ?? 'artifact_transfer';
      // Every attempt is a read that resumes from the retained bytes, so a repeat is safe by contract.
      const options = { signal, deadlineMs, effect: 'idempotent' as const,
        classify: (error: unknown) => error instanceof ArtifactTransferError ? error.failure : undefined,
        onAttempt: (record: { delayMs: number | null }) => {
          if (record.delayMs !== null) this.#set(id, { attempts: this.#row(id).attempts + 1 });
        } };
      row = this.#row(id);
      const resolved = this.#resolvedRow(row) ?? await retryWithPolicy(policy, () => this.#resolve(row), options);
      if (resolved.state !== 'verifying') {
        await retryWithPolicy(policy, () => this.#transferOnce(resolved, signal), options);
        this.#set(id, { state: 'verifying' });
      }
      await this.#finalize(this.#resolvedRow(this.#row(id)) ?? resolved);
    } catch (error: unknown) {
      // An aborted run (shutdown, or a caller that stopped waiting) stays resumable.
      if (signal?.aborted) throw error;
      const failure = error instanceof RetryStoppedError
        ? new ArtifactTransferError(`Transfer interrupted: ${error.message}`, 'TRANSFER_INTERRUPTED')
        : error instanceof ArtifactTransferError ? error
          : error instanceof ProvenNoEffectError ? new ArtifactTransferError(error.message, error.code)
            : error instanceof ArtifactStoreError ? new ArtifactTransferError(error.message, error.code)
              : new ArtifactTransferError(error instanceof Error ? error.message : 'Artifact import failed', 'TRANSFER_FAILED');
      // Bytes that failed verification are never kept; anything else stays for a reissue.
      if ([ARTIFACT_TRANSFER_ERRORS.digestMismatch, ARTIFACT_TRANSFER_ERRORS.gone, 'INVALID_ARTIFACT'].includes(failure.code)) await this.#discard(id);
      this.#set(id, { state: 'failed', error: failure.message.slice(0, 500), error_code: failure.code });
    }
    return this.#view(this.#row(id));
  }

  /** Resolve the peer's descriptor for the artifact and negotiate the protocol and limit. */
  async #resolve(row: ImportRow): Promise<Resolved> {
    const { card, client, authorization } = await this.#open(row.peer_id);
    let remote: Task;
    try {
      remote = await client.getTask({ tenant: '', id: row.a2a_task_id }, { serviceParameters: { Authorization: authorization, 'A2A-Version': '1.0' } });
    } catch (error: unknown) {
      throw new ArtifactTransferError(`Remote task is unavailable: ${error instanceof Error ? error.message : 'unknown error'}`, 'PEER_UNAVAILABLE', true);
    }
    if (remote.id !== row.a2a_task_id || remote.status?.state !== TaskState.TASK_STATE_COMPLETED)
      throw new ArtifactTransferError('Remote task receipt is not complete or bound', 'REMOTE_TASK_INCOMPLETE');
    const v2 = peerTransferV2(card);
    const allTexts = texts(remote).map(json);
    const declaredV1 = parseEach(allTexts, TeamArtifactDescriptorSchema).find(item => item.artifact_id === row.artifact_id && item.producer_task_id === remote.id);
    const declaredV2 = parseEach(v2Parts(remote), TeamArtifactDescriptorV2Schema).find(item =>
      item.manifest_1_1.artifact_id === row.artifact_id && item.manifest_1_1.provenance.producer_task_id === remote.id);
    const requiresV2 = parseEach(allTexts, TeamArtifactRequiresV2Schema).find(item => item.artifact_id === row.artifact_id && item.producer_task_id === remote.id);
    let plan: { protocol: 'v1' | 'v2'; manifest: ArtifactManifest11; manifest10: string | null; contentPath: string };
    if (v2 && declaredV2) plan = { protocol: 'v2', manifest: declaredV2.manifest_1_1, manifest10: null, contentPath: declaredV2.content_path };
    else if (declaredV1) plan = { protocol: 'v1', manifest: manifestV11(declaredV1.artifact_manifest), manifest10: JSON.stringify(declaredV1.artifact_manifest),
      contentPath: `/team/artifacts/${row.artifact_id}?context=${encodeURIComponent(remote.contextId)}` };
    else if (declaredV2 || requiresV2) throw new ArtifactTransferError(`Peer ${row.peer_id} does not advertise ${ARTIFACT_TRANSFER_V2_URN}; ` +
      `artifacts larger than ${ARTIFACT_TRANSFER_V1_MAX_BYTES} bytes need it`, ARTIFACT_TRANSFER_ERRORS.requiresV2);
    else throw new ArtifactTransferError('Remote task did not declare this exact artifact', 'ARTIFACT_NOT_DECLARED');
    if (!ArtifactMimeSchema.safeParse(plan.manifest.mime).success)
      throw new ArtifactTransferError(`Artifact media type ${plan.manifest.mime.slice(0, 100)} is not accepted`, 'INVALID_ARTIFACT');
    const limit = Math.min(this.runtime.artifacts.maxBytes, v2?.max_bytes ?? Number.MAX_SAFE_INTEGER);
    if (plan.manifest.size > limit) throw new ArtifactTransferError(`Artifact size ${plan.manifest.size} exceeds the negotiated limit of ${limit} bytes`,
      ARTIFACT_TRANSFER_ERRORS.tooLarge);
    if (plan.manifest.expires_at <= Date.now() / 1000) throw new ArtifactTransferError('Remote artifact export has expired', ARTIFACT_TRANSFER_ERRORS.gone);
    this.#set(row.id, { sha256: plan.manifest.sha256, size: plan.manifest.size, mime: plan.manifest.mime, name: plan.manifest.name,
      protocol: plan.protocol, context_id: remote.contextId, content_path: plan.contentPath, manifest_json: JSON.stringify(plan.manifest),
      manifest_1_0_json: plan.manifest10 });
    const resolved = this.#resolvedRow(this.#row(row.id));
    if (!resolved) throw new Error('Import descriptor was not recorded');
    return resolved;
  }

  /** One attempt: resume from the retained bytes and append the rest. */
  async #transferOnce(row: Resolved, signal: AbortSignal | undefined): Promise<void> {
    const { card, authorization } = await this.#open(row.peer_id);
    const origin = jsonRpcOrigin(card);
    const url = new URL(row.content_path, origin);
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/team/artifacts/'))
      throw new ArtifactTransferError('Artifact path leaves the peer origin', 'PEER_UNSUPPORTED');
    await mkdir(this.runtime.artifacts.partialDirectory, { recursive: true, mode: 0o700 });
    const file = await open(row.partial_path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    let received = 0;
    let committed = 0;
    let writable = true;
    try {
      // Only committed bytes were fsynced; anything after them is discarded.
      const info = await file.stat();
      received = row.protocol === 'v2' ? Math.min(this.#row(row.id).received_bytes, info.size, row.size) : 0;
      await file.truncate(received);
      const hash = await this.#rehash(file, received);
      committed = received;
      this.#commit(row.id, received);
      if (received === row.size) { this.#verify(hash, row); return; }
      const idle = new AbortController();
      const idleMs = this.options.idleTimeoutMs ?? 60_000;
      let timer = setTimeout(() => idle.abort(new Error('Artifact response stalled')), idleMs);
      const headers: Record<string, string> = { Authorization: authorization };
      if (row.protocol === 'v2') { headers.Range = `bytes=${received}-`; headers['If-Range'] = `"${row.sha256}"`; }
      let response: Response;
      try {
        response = await this.#fetch(url, { redirect: 'manual', headers, signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal });
      } catch (error: unknown) {
        clearTimeout(timer);
        if (signal?.aborted) throw error;
        throw new ArtifactTransferError(`Artifact fetch failed: ${error instanceof Error ? error.message : 'network error'}`, 'TRANSFER_INTERRUPTED', true);
      }
      try {
        let hashState = hash;
        if (response.status === 404 || response.status === 410) throw new ArtifactTransferError(`Peer no longer serves the artifact (HTTP ${response.status})`, ARTIFACT_TRANSFER_ERRORS.gone);
        if (RETRYABLE_STATUS.has(response.status)) throw new ArtifactTransferError(`Artifact fetch HTTP ${response.status}`, 'TRANSFER_INTERRUPTED', responseFailure(response));
        if (response.status === 416 && received === row.size) { this.#verify(hashState, row); return; }
        if (response.status !== 200 && response.status !== 206) throw new ArtifactTransferError(`Artifact fetch HTTP ${response.status}`, 'TRANSFER_REJECTED');
        this.#checkHeaders(response, row);
        if (response.status === 206) {
          if (row.protocol !== 'v2' || response.headers.get('content-range') !== `bytes ${received}-${row.size - 1}/${row.size}`)
            throw new ArtifactTransferError('Partial response does not continue the retained bytes', 'TRANSFER_REJECTED');
        } else if (received > 0) {
          // The peer sent the whole representation (no Range support, or a changed one): start over.
          received = 0;
          committed = 0;
          await file.truncate(0);
          this.#commit(row.id, 0);
          hashState = createHash('sha256');
        }
        const length = Number(response.headers.get('content-length') ?? NaN);
        if (Number.isFinite(length) && length !== row.size - received) throw new ArtifactTransferError('Artifact length differs from its descriptor', ARTIFACT_TRANSFER_ERRORS.digestMismatch);
        if (!response.body) throw new ArtifactTransferError('Artifact response has no body', 'TRANSFER_INTERRUPTED', true);
        const reader = response.body.getReader();
        const commitBytes = this.options.commitBytes ?? 4 * 1024 * 1024;
        try {
          while (true) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try { chunk = await reader.read(); }
            catch (error: unknown) {
              if (signal?.aborted) throw error;
              throw new ArtifactTransferError(`Artifact response ended early: ${error instanceof Error ? error.message : 'read error'}`, 'TRANSFER_INTERRUPTED', true);
            }
            if (chunk.done) break;
            clearTimeout(timer);
            timer = setTimeout(() => idle.abort(new Error('Artifact response stalled')), idleMs);
            const bytes = chunk.value;
            if (received + bytes.byteLength > row.size) throw new ArtifactTransferError('Artifact response exceeds its declared size', ARTIFACT_TRANSFER_ERRORS.digestMismatch);
            writable = false;
            await writeAll(file, bytes, received);
            writable = true;
            hashState.update(bytes);
            received += bytes.byteLength;
            if (received - committed >= commitBytes) { await file.sync(); this.#commit(row.id, received); committed = received; }
            this.options.onProgress?.({ import_id: row.id, received_bytes: received, size: row.size });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        if (received !== row.size) throw new ArtifactTransferError('Artifact response ended before its declared size', 'TRANSFER_INTERRUPTED', true);
        this.#verify(hashState, row);
      } finally { clearTimeout(timer); }
    } finally {
      // Retain what was written: an interrupted attempt resumes from it.
      if (writable && received > committed) { await file.sync().catch(() => {}); this.#commit(row.id, received); }
      await file.close().catch(() => {});
    }
  }

  #verify(hash: Hash, row: Resolved): void {
    if (hash.digest('hex') !== row.sha256)
      throw new ArtifactTransferError('Received bytes differ from the declared SHA-256', ARTIFACT_TRANSFER_ERRORS.digestMismatch);
  }

  #checkHeaders(response: Response, row: Resolved): void {
    const etag = response.headers.get('etag');
    const repr = parseReprDigest(response.headers.get('repr-digest'));
    const declared = response.headers.get('x-content-sha256');
    if ((etag !== null && etag !== `"${row.sha256}"`) || (repr !== undefined && repr !== row.sha256) || (declared !== null && declared !== row.sha256))
      throw new ArtifactTransferError('Peer serves a different representation than it declared', ARTIFACT_TRANSFER_ERRORS.digestMismatch);
    if (row.protocol === 'v1') {
      if (response.headers.get('x-hermes-task-id') !== row.a2a_task_id ||
        decodeURIComponent(response.headers.get('x-artifact-name') ?? '') !== row.name ||
        response.headers.get('content-type')?.split(';')[0] !== row.mime)
        throw new ArtifactTransferError('Artifact response differs from the task receipt', 'TRANSFER_REJECTED');
      const encoded = response.headers.get('x-hermes-artifact-manifest');
      if (!encoded || encoded.length > 8192) throw new ArtifactTransferError('Artifact manifest is missing or oversized', 'TRANSFER_REJECTED');
      const manifest = TeamArtifactManifestSchema.safeParse(json(Buffer.from(encoded, 'base64url').toString('utf8')));
      if (!manifest.success || JSON.stringify(manifest.data) !== row.manifest_1_0_json)
        throw new ArtifactTransferError('Artifact manifest differs from the task receipt', 'TRANSFER_REJECTED');
    }
  }

  async #rehash(file: FileHandle, length: number): Promise<Hash> {
    const hash = createHash('sha256');
    if (await hashFileRange(file, hash, 0, length) !== length) throw new ArtifactTransferError('Partial file is shorter than its committed bytes', 'TRANSFER_INTERRUPTED', true);
    return hash;
  }

  /** Rename the verified file into the store (or find it there) and register it; safe to repeat. */
  async #finalize(row: Resolved): Promise<void> {
    await this.#inspect(row);
    try {
      await this.runtime.artifacts.adoptFile(row.partial_path, { sha256: row.sha256, size: row.size });
    } catch (error: unknown) {
      const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      if (!missing) throw error;
      // The partial file is gone and the digest is not stored: transfer again from the start.
      this.#set(row.id, { state: 'transferring', received_bytes: 0 });
      throw new ArtifactTransferError('Verified bytes are no longer retained; reissue the import', 'TRANSFER_INTERRUPTED');
    }
    const manifest = ArtifactManifest11Schema.parse(JSON.parse(row.manifest_json) as unknown);
    const taskId = row.local_task_id ?? this.#importTask(row);
    await this.runtime.artifactManifests.registerImported({ taskId, peer: row.peer_id, remoteTaskId: row.a2a_task_id, manifest,
      artifactId: row.id, onRegistered: () => this.#set(row.id, { state: 'completed', received_bytes: row.size, local_task_id: taskId, error: null, error_code: null }) });
  }

  /** Check the verified partial file against its media type before it enters the store. */
  async #inspect(row: Resolved): Promise<void> {
    const mime = ArtifactMimeSchema.parse(row.mime);
    let file: FileHandle;
    try { file = await open(row.partial_path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    try {
      const inspector = artifactContentInspector(mime);
      const binary = ['png', 'jpeg', 'webp', 'pdf', 'docx'].includes(ARTIFACT_MIME_TYPES[mime]);
      await hashFileRange(file, { update: chunk => inspector.write(chunk) }, 0, binary ? Math.min(16, row.size) : row.size);
      inspector.end();
    } finally { await file.close(); }
  }

  /** A completed local task that owns an import made without one. Idempotent per import. */
  #importTask(row: Resolved): string {
    const store = this.runtime.store;
    return store.db.transaction(() => {
      const task = store.accept({ caller: row.caller, context: 'direct', prompt: `Import artifact ${row.name} from A2A peer ${row.peer_id} task ${row.a2a_task_id}`.slice(0, 16000),
        idempotencyKey: `artifact-import:${row.id}`, backend: this.runtime.config.execution.backend, deadlineMs: Date.now() });
      if (task.state === 'queued') store.setState(task.id, 'completed', `Imported artifact ${row.name} (sha256 ${row.sha256})`);
      this.#set(row.id, { local_task_id: task.id });
      return task.id;
    })();
  }

  async #discard(id: string): Promise<void> {
    await unlink(this.#row(id).partial_path).catch(() => {});
    this.#commit(id, 0);
  }

  async #open(peer: string): ReturnType<ArdentA2AClient['open']> {
    try { return await new ArdentA2AClient(this.runtime.profileDir, this.runtime.config, this.env).open(peer); }
    catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Peer unavailable';
      // Configuration problems are permanent; a peer that does not answer may come back.
      throw new ArtifactTransferError(message, /not configured|credential/i.test(message) ? 'PEER_UNAVAILABLE' : 'PEER_UNREACHABLE', !/not configured|credential/i.test(message));
    }
  }

  #row(id: string): ImportRow {
    const raw = this.runtime.store.db.prepare('SELECT * FROM artifact_transfers WHERE id=?').get(id);
    if (!raw) throw new Error('Artifact import not found');
    return Row.parse(raw);
  }

  #resolvedRow(row: ImportRow): Resolved | undefined {
    const { sha256, size, mime, name, protocol, content_path: contentPath, manifest_json: manifestJson } = row;
    if (sha256 === null || size === null || mime === null || name === null || protocol === null || contentPath === null || manifestJson === null) return undefined;
    return { ...row, sha256, size, mime, name, protocol, content_path: contentPath, manifest_json: manifestJson };
  }

  #commit(id: string, received: number): void {
    this.runtime.store.db.prepare('UPDATE artifact_transfers SET received_bytes=?,updated_ms=? WHERE id=?').run(received, Date.now(), id);
  }

  #set(id: string, fields: Partial<Omit<ImportRow, 'id'>>): void {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    const allowed = new Set(Object.keys(Row.shape));
    for (const [key] of entries) if (!allowed.has(key) || key === 'id') throw new Error(`Unknown import field ${key}`);
    this.runtime.store.db.prepare(`UPDATE artifact_transfers SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_ms=? WHERE id=?`)
      .run(...entries.map(([, value]) => value ?? null), Date.now(), id);
  }

  #view(row: ImportRow): ArtifactImport {
    return ArtifactImportSchema.parse({ import_id: row.id, peer_id: row.peer_id, a2a_task_id: row.a2a_task_id, artifact_id: row.artifact_id,
      state: row.state, received_bytes: row.received_bytes, size: row.size, sha256: row.sha256, mime: row.mime, name: row.name,
      protocol: row.protocol, attempts: row.attempts, local_task_id: row.local_task_id,
      ...(row.error ? { error: { code: row.error_code ?? 'TRANSFER_FAILED', message: row.error } } : {}),
      created_ms: row.created_ms, updated_ms: row.updated_ms });
  }
}
