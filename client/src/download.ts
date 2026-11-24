import { backoffDelay, sleepAbortable } from '@hivemagnus/hive-common/retry';
import { parseReprDigest, selectRendition, type RenditionRequest } from '@hivemagnus/hive-common/artifact';
import { anySignal, type Connection } from './transport.js';
import { ArdentClientError, DigestMismatchError, NotFoundError, TransportError } from './errors.js';
import { Sha256 } from './sha256.js';
import type { ArtifactRendition } from './types.js';

/** Bytes of an earlier, interrupted download of the same artifact, from its first byte. */
export type ResumeSource = Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface DownloadProgress {
  /** Bytes of the artifact received, including those from `resumeFrom`. */
  readonly received: number;
  readonly total: number;
  /** Times the transfer was resumed after a dropped connection. */
  readonly resumes: number;
}

export interface DownloadOptions {
  /** Pick a rendition (preview, model input) instead of the original; `download` always resolves to the original. */
  readonly rendition?: RenditionRequest;
  /**
   * The bytes you already hold from an interrupted download of this artifact. They are hashed
   * again as a stream, and the transfer continues after them with `Range` and `If-Range`, so
   * the final digest still covers the whole file.
   */
  readonly resumeFrom?: ResumeSource;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly signal?: AbortSignal;
  /** Resumptions after dropped connections before the download fails. Default 5. */
  readonly maxResumes?: number;
}

export interface ArtifactDownload {
  /**
   * The bytes after `offset`. It closes only after the whole file hashed to `sha256`; on a
   * mismatch it errors with `DigestMismatchError`, and the bytes must be discarded.
   */
  readonly stream: ReadableStream<Uint8Array>;
  /** The digest of the bytes being downloaded (the chosen rendition's, when one was asked for). */
  readonly sha256: string;
  readonly size: number;
  /** Bytes taken from `resumeFrom`; the stream starts after them. */
  readonly offset: number;
  readonly mime: string;
  readonly filename: string | undefined;
}

async function* read(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  // Readers rather than async iteration: not every browser iterates a ReadableStream.
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally { reader.releaseLock(); }
}
function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
async function* chunks(source: ResumeSource): AsyncGenerator<Uint8Array> {
  if (source instanceof ArrayBuffer) yield new Uint8Array(source);
  else if (ArrayBuffer.isView(source)) yield new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  else if (source instanceof ReadableStream) yield* read(source);
  else if (typeof Blob !== 'undefined' && source instanceof Blob) yield* read(source.stream());
  else if (isAsyncIterable(source)) yield* source;
  else throw new ArdentClientError('invalid_request', 'resumeFrom must be a Blob, ArrayBuffer, typed array, ReadableStream or async iterable', { status: 400 });
}

function contentRange(value: string | null): { start: number; end: number; size: number } | { size: number } | undefined {
  const partial = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (partial) return { start: Number(partial[1]), end: Number(partial[2]), size: Number(partial[3]) };
  const unsatisfied = /^bytes \*\/(\d+)$/.exec(value ?? '');
  return unsatisfied ? { size: Number(unsatisfied[1]) } : undefined;
}

function filename(disposition: string | null): string | undefined {
  const match = /filename="((?:[^"\\]|\\.)*)"/i.exec(disposition ?? '');
  return match ? match[1]!.replace(/\\(.)/g, '$1') : undefined;
}

export async function downloadArtifact(connection: Connection, sha: string, options: DownloadOptions,
  renditions: (sha: string, signal?: AbortSignal) => Promise<ArtifactRendition[]>): Promise<ArtifactDownload> {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new ArdentClientError('invalid_request', 'An artifact is named by its lowercase hex SHA-256', { status: 400 });
  const signal = anySignal(connection.signal, options.signal);
  let target = sha;
  if (options.rendition) {
    const chosen = selectRendition(await renditions(sha, signal), options.rendition);
    if (!chosen) throw new NotFoundError('NOT_FOUND', 'No rendition of the artifact fits the request', { status: 404 });
    target = chosen.sha256;
  }
  const hash = new Sha256();
  if (options.resumeFrom !== undefined) for await (const chunk of chunks(options.resumeFrom)) {
    if (signal?.aborted) throw signal.reason;
    hash.update(chunk);
  }
  const offset = hash.length;
  const url = connection.url(`artifacts/${target}/content`);
  const etag = `"${target}"`;
  const open = async (from: number) => {
    const response = await connection.raw({ url, gate: 'artifact_transfer', allow: [416], signal,
      headers: from > 0 ? { range: `bytes=${from}-`, 'if-range': etag } : {} });
    const declared = response.headers.get('x-content-sha256') ?? parseReprDigest(response.headers.get('repr-digest'));
    if (declared && declared !== target) {
      await response.body?.cancel().catch(() => undefined);
      throw new DigestMismatchError(target, declared);
    }
    const range = contentRange(response.headers.get('content-range'));
    if (response.status === 416) {
      await response.body?.cancel().catch(() => undefined);
      if (!range || range.size !== from) throw new ArdentClientError('RANGE_NOT_SATISFIABLE', 'The artifact is shorter than the bytes already held', { status: 416 });
      return { response: undefined, size: range.size, skip: 0 };
    }
    if (response.status === 206) {
      if (!range || !('start' in range) || range.start !== from) {
        await response.body?.cancel().catch(() => undefined);
        throw new TransportError('invalid_response', 'The server answered a different byte range', { status: 502 });
      }
      return { response, size: range.size, skip: 0 };
    }
    // A whole representation: the server ignored the range, so skip the bytes already held.
    const length = Number(response.headers.get('content-length') ?? NaN);
    return { response, size: Number.isSafeInteger(length) ? length : -1, skip: from };
  };

  const first = await open(offset);
  const size = first.size;
  if (size >= 0 && offset > size) throw new ArdentClientError('RANGE_NOT_SATISFIABLE', 'The artifact is shorter than the bytes already held', { status: 416 });
  const mime = first.response?.headers.get('content-type') ?? 'application/octet-stream';
  const name = filename(first.response?.headers.get('content-disposition') ?? null);
  const maxResumes = options.maxResumes ?? 5;
  let position = offset;
  let resumes = 0;
  let failuresWithoutProgress = 0;
  let current: { reader: ReadableStreamDefaultReader<Uint8Array> | undefined; skip: number } = { reader: first.response?.body?.getReader(), skip: first.skip };
  let finished = false;

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    finished = true;
    const actual = hash.hex();
    if (actual !== target) controller.error(new DigestMismatchError(target, actual));
    else controller.close();
  };
  const resume = async (cause: unknown) => {
    await current.reader?.cancel().catch(() => undefined);
    current = { reader: undefined, skip: 0 };
    if (signal?.aborted) throw signal.reason;
    if (resumes >= maxResumes || failuresWithoutProgress >= 3)
      throw new TransportError('download_interrupted', `The download was interrupted ${resumes + 1} times`, { status: 503, cause });
    resumes++;
    failuresWithoutProgress++;
    const delay = backoffDelay(failuresWithoutProgress, { ...connection.retryPolicy, maxAttempts: Number.MAX_SAFE_INTEGER }) ?? connection.retryPolicy.maxMs;
    await sleepAbortable(delay, signal);
    const next = await open(position);
    current = { reader: next.response?.body?.getReader(), skip: next.skip };
  };

  const stream = new ReadableStream<Uint8Array>({
    pull: async controller => {
      for (;;) {
        if (finished) return;
        if (!current.reader) {
          if (size >= 0 && position === size) { finish(controller); return; }
          await resume(new Error('No response body'));
          continue;
        }
        let read: ReadableStreamReadResult<Uint8Array>;
        try { read = await current.reader.read(); }
        catch (error: unknown) {
          if (signal?.aborted) throw signal.reason;
          await resume(error);
          continue;
        }
        if (read.done) {
          if (size < 0 || position === size) { finish(controller); return; }
          // A body that ended early is a dropped transfer.
          await resume(new Error('The response ended early'));
          continue;
        }
        let chunk = read.value;
        if (current.skip) {
          const skipped = Math.min(current.skip, chunk.length);
          current.skip -= skipped;
          chunk = chunk.subarray(skipped);
          if (!chunk.length) continue;
        }
        if (size >= 0 && position + chunk.length > size) {
          await current.reader.cancel().catch(() => undefined);
          throw new TransportError('invalid_response', 'The artifact is longer than its declared size', { status: 502 });
        }
        hash.update(chunk);
        position += chunk.length;
        failuresWithoutProgress = 0;
        options.onProgress?.({ received: position, total: size, resumes });
        controller.enqueue(chunk);
        return;
      }
    },
    cancel: async reason => { finished = true; await current.reader?.cancel(reason).catch(() => undefined); },
  });
  return { stream, sha256: target, size, offset, mime, filename: name };
}
