import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const ArtifactSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), media_type: z.string(), name: z.string() }).strict();
export type Artifact = z.infer<typeof ArtifactSchema>;

export class ArtifactStore {
  constructor(readonly directory: string) {}
  async put(name: string, mediaType: string, bytes: Uint8Array): Promise<Artifact> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error('Invalid artifact name');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Artifact exceeds 2 MiB');
    const digest = createHash('sha256').update(bytes).digest('hex');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${digest}.${process.pid}.${Date.now()}`);
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(this.directory, digest));
    return { id: digest, sha256: digest, bytes: bytes.length, media_type: mediaType, name };
  }
  async get(id: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid artifact ID');
    const file = await open(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Artifact file is unsafe');
      const bytes = await file.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Artifact bytes differ from their ID');
      return bytes;
    } finally { await file.close(); }
  }
}
