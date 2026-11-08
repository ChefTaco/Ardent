import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const ArtifactSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), media_type: z.string(), name: z.string() }).strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
/** Default per-artifact limit (`artifacts.max_bytes`). */
export const ARTIFACT_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** Largest per-artifact limit a profile may configure; also the bound on reading a stored artifact. */
export const ARTIFACT_MAX_BYTES_LIMIT = 64 * 1024 * 1024;

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
    const temporary = join(this.directory, `.${digest}.${process.pid}.${Date.now()}`);
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
