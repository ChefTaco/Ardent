import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';

export const ArtifactSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), media_type: z.string(), name: z.string() }).strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
/** Default per-artifact limit (`artifacts.max_bytes`). */
export const ARTIFACT_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** Largest per-artifact limit a profile may configure; also the bound on reading a stored artifact. */
export const ARTIFACT_MAX_BYTES_LIMIT = 64 * 1024 * 1024;

const DIGEST = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** A stored artifact's identity and size, without reading its bytes. */
export type ArtifactStat = { id: string; sha256: string; size: number };
/** An inclusive byte range; both ends default to the whole artifact. */
export type ArtifactReadRange = { start?: number | undefined; end?: number | undefined };
/** A stream over stored bytes. `start` and `end` are the inclusive offsets it yields. */
export type ArtifactRead = { stream: Readable; size: number; sha256: string; start: number; end: number };
/**
 * Sees every byte `putStream` stores, in order, before the file becomes visible.
 * Throwing from `write` or `end` refuses the artifact; nothing is stored.
 */
export type ArtifactInspector = { write(chunk: Uint8Array): void; end(): void };
export type ArtifactSource = Readable | AsyncIterable<Uint8Array> | WebReadableStream<Uint8Array>;
export type ArtifactPutStreamOptions = {
  name: string; mediaType: string;
  /** Refuse the artifact unless its bytes hash to this lowercase hex SHA-256. */
  expectedSha256?: string | undefined;
  /** Refuse the artifact unless it has exactly this many bytes. */
  expectedSize?: number | undefined;
  /** A tighter per-call bound; never above the store's own limit. */
  maxBytes?: number | undefined;
  inspect?: ArtifactInspector | undefined;
  signal?: AbortSignal | undefined;
};
/** Codes on errors that `putStream`, `openRead` and `adoptFile` throw for refused input. */
export type ArtifactStoreErrorCode = 'INVALID_ARTIFACT' | 'ARTIFACT_TOO_LARGE' | 'SIZE_MISMATCH' | 'DIGEST_MISMATCH' | 'RANGE_NOT_SATISFIABLE' | 'NOT_FOUND';
export class ArtifactStoreError extends Error {
  constructor(message: string, readonly code: ArtifactStoreErrorCode) { super(message); this.name = 'ArtifactStoreError'; }
}

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
function sourceStream(source: ArtifactSource): AsyncIterable<unknown> {
  if (source instanceof Readable) return source;
  if (Symbol.asyncIterator in source) return source;
  return Readable.fromWeb(source);
}
async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength;) offset += (await file.write(bytes, offset, bytes.byteLength - offset)).bytesWritten;
}
/**
 * Pass bytes through while hashing them, holding back the last chunk until the
 * digest matches, so a reader of tampered bytes never sees a complete body.
 */
function verifyingStream(expected: string): Transform {
  const hash = createHash('sha256');
  let held: Buffer | undefined;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      const previous = held;
      held = chunk;
      done(null, previous);
    },
    flush(done) {
      if (hash.digest('hex') !== expected) { done(new Error('Artifact bytes differ from their ID')); return; }
      done(null, held);
    }
  });
}

/**
 * Feed `length` bytes of an open file from `start` to `hash` through one
 * reused buffer, so hashing a large file allocates nothing per chunk.
 */
export async function hashFileRange(file: FileHandle, hash: { update(data: Uint8Array): unknown }, start: number, length: number): Promise<number> {
  const buffer = Buffer.allocUnsafe(Math.min(Math.max(length, 1), 256 * 1024));
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.byteLength, length - done), start + done);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    done += bytesRead;
  }
  return done;
}

export function formatBytes(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`;
}

export class ArtifactStore {
  constructor(readonly directory: string, readonly maxBytes = ARTIFACT_DEFAULT_MAX_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ARTIFACT_MAX_BYTES_LIMIT) throw new Error('Invalid artifact byte limit');
  }
  async put(name: string, mediaType: string, bytes: Uint8Array): Promise<Artifact> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error('Invalid artifact name');
    if (bytes.length > this.maxBytes) throw new Error(`Artifact exceeds ${formatBytes(this.maxBytes)}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Unique per call: two tasks may store identical bytes at the same instant.
    const temporary = join(this.directory, `.${digest}.${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(this.directory, digest));
    return { id: digest, sha256: digest, bytes: bytes.length, media_type: mediaType, name };
  }
  /** Remove stored bytes. Callers must prove nothing else still references them. */
  async delete(id: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid artifact ID');
    await unlink(join(this.directory, id)).catch((error: unknown) => {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
  /** Where resumable transfers keep their partial files; inside the store so a finished file is one rename away. */
  get partialDirectory(): string { return join(this.directory, '.partial'); }

  /** Size of a stored artifact, or undefined when it is absent. Never follows a symbolic link. */
  async stat(id: string): Promise<ArtifactStat | undefined> {
    if (!DIGEST.test(id)) throw new ArtifactStoreError('Invalid artifact ID', 'INVALID_ARTIFACT');
    try {
      const info = await lstat(join(this.directory, id));
      if (!info.isFile() || info.size > ARTIFACT_MAX_BYTES_LIMIT) throw new Error('Artifact file is unsafe');
      return { id, sha256: id, size: info.size };
    } catch (error: unknown) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  /**
   * Stream stored bytes, optionally one inclusive range. With `verify`, a read
   * of the whole artifact checks the digest as it streams and fails before the
   * final chunk when the bytes differ. A partial read is never verified.
   */
  async openRead(id: string, range: ArtifactReadRange = {}, options: { verify?: boolean } = {}): Promise<ArtifactRead> {
    if (!DIGEST.test(id)) throw new ArtifactStoreError('Invalid artifact ID', 'INVALID_ARTIFACT');
    let file: FileHandle;
    try { file = await open(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: unknown) { throw missing(error) ? new ArtifactStoreError('Artifact not found', 'NOT_FOUND') : error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > ARTIFACT_MAX_BYTES_LIMIT) throw new Error('Artifact file is unsafe');
      const size = info.size;
      const start = range.start ?? 0;
      const end = range.end ?? size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
        (size === 0 ? start !== 0 || end !== -1 : start > end || end >= size))
        throw new ArtifactStoreError('Artifact range is not satisfiable', 'RANGE_NOT_SATISFIABLE');
      let stream: Readable;
      if (size === 0) { await file.close(); stream = Readable.from([]); }
      else stream = file.createReadStream({ start, end, autoClose: true });
      if (options.verify && start === 0 && end === size - 1) {
        const source = stream;
        const verifier = verifyingStream(id);
        source.once('error', error => verifier.destroy(error));
        verifier.once('close', () => { if (!source.destroyed) source.destroy(); });
        stream = source.pipe(verifier);
      }
      return { stream, size, sha256: id, start, end };
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    }
  }

  /** Hash stored bytes as a stream; throws when they differ from their ID. Returns the size. */
  async verify(id: string): Promise<number> {
    if (!DIGEST.test(id)) throw new ArtifactStoreError('Invalid artifact ID', 'INVALID_ARTIFACT');
    let file: FileHandle;
    try { file = await open(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error: unknown) { throw missing(error) ? new ArtifactStoreError('Artifact not found', 'NOT_FOUND') : error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > ARTIFACT_MAX_BYTES_LIMIT) throw new Error('Artifact file is unsafe');
      const hash = createHash('sha256');
      if (await hashFileRange(file, hash, 0, info.size) !== info.size || hash.digest('hex') !== id) throw new Error('Artifact bytes differ from their ID');
      return info.size;
    } finally { await file.close(); }
  }

  /**
   * Store bytes from a stream without holding them in memory: a private
   * temporary file, an incremental SHA-256, a size bound, fsync, then an atomic
   * rename to the digest. Every refusal happens before the rename.
   */
  async putStream(source: ArtifactSource, options: ArtifactPutStreamOptions): Promise<Artifact> {
    if (!NAME.test(options.name)) throw new ArtifactStoreError('Invalid artifact name', 'INVALID_ARTIFACT');
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0))
      throw new ArtifactStoreError('Invalid artifact byte limit', 'INVALID_ARTIFACT');
    const limit = Math.min(options.maxBytes ?? this.maxBytes, this.maxBytes);
    if (options.expectedSha256 !== undefined && !DIGEST.test(options.expectedSha256))
      throw new ArtifactStoreError('Invalid expected SHA-256', 'INVALID_ARTIFACT');
    if (options.expectedSize !== undefined && (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 0))
      throw new ArtifactStoreError('Invalid expected size', 'INVALID_ARTIFACT');
    if (options.expectedSize !== undefined && options.expectedSize > limit)
      throw new ArtifactStoreError(`Artifact exceeds ${formatBytes(limit)}`, 'ARTIFACT_TOO_LARGE');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.put.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    let closed = false;
    try {
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of sourceStream(source)) {
        options.signal?.throwIfAborted();
        const bytes = chunk instanceof Uint8Array ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : undefined;
        if (!bytes) throw new ArtifactStoreError('Artifact stream yielded a non-byte chunk', 'INVALID_ARTIFACT');
        size += bytes.byteLength;
        if (size > limit) throw new ArtifactStoreError(`Artifact exceeds ${formatBytes(limit)}`, 'ARTIFACT_TOO_LARGE');
        if (options.expectedSize !== undefined && size > options.expectedSize)
          throw new ArtifactStoreError('Artifact is larger than its expected size', 'SIZE_MISMATCH');
        hash.update(bytes);
        options.inspect?.write(bytes);
        await writeAll(file, bytes);
      }
      options.signal?.throwIfAborted();
      options.inspect?.end();
      if (options.expectedSize !== undefined && size !== options.expectedSize)
        throw new ArtifactStoreError('Artifact is smaller than its expected size', 'SIZE_MISMATCH');
      const digest = hash.digest('hex');
      if (options.expectedSha256 !== undefined && digest !== options.expectedSha256)
        throw new ArtifactStoreError('Artifact bytes differ from the expected SHA-256', 'DIGEST_MISMATCH');
      await file.sync();
      closed = true;
      await file.close();
      await rename(temporary, join(this.directory, digest));
      return { id: digest, sha256: digest, bytes: size, media_type: options.mediaType, name: options.name };
    } catch (error) {
      if (!closed) await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  /**
   * Move a complete file (for example a finished transfer's partial file on the
   * same file system) into the store under its digest. The bytes are hashed
   * again first. If the digest is already stored, the file is discarded, so a
   * repeated call is harmless.
   */
  async adoptFile(path: string, expected: { sha256: string; size: number }): Promise<ArtifactStat> {
    if (!DIGEST.test(expected.sha256)) throw new ArtifactStoreError('Invalid artifact ID', 'INVALID_ARTIFACT');
    const existing = await this.stat(expected.sha256);
    if (existing) {
      await unlink(path).catch((error: unknown) => { if (!missing(error)) throw error; });
      if (existing.size !== expected.size) throw new Error('Stored artifact size differs from its manifest');
      return existing;
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256');
    let size = 0;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== expected.size || info.size > ARTIFACT_MAX_BYTES_LIMIT)
        throw new ArtifactStoreError('File size differs from the expected size', 'SIZE_MISMATCH');
      size = await hashFileRange(file, hash, 0, info.size);
    } finally { await file.close(); }
    if (size !== expected.size) throw new ArtifactStoreError('File size differs from the expected size', 'SIZE_MISMATCH');
    if (hash.digest('hex') !== expected.sha256) throw new ArtifactStoreError('File bytes differ from the expected SHA-256', 'DIGEST_MISMATCH');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await rename(path, join(this.directory, expected.sha256));
    return { id: expected.sha256, sha256: expected.sha256, size };
  }

  async get(id: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid artifact ID');
    const file = await open(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      // Reads accept anything a profile could have stored under its largest
      // permitted limit, so lowering the limit never hides earlier artifacts.
      if (!stat.isFile() || stat.size > ARTIFACT_MAX_BYTES_LIMIT) throw new Error('Artifact file is unsafe');
      const bytes = await file.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Artifact bytes differ from their ID');
      return bytes;
    } finally { await file.close(); }
  }
}
