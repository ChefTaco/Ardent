import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
import { z } from 'zod';
import type { ArdentPlugin, ArdentTaskPluginContext } from './plugins.js';

const Image = z.object({ path: z.string().min(1).max(2048), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** Validate retained bytes, never accepting a client-supplied path or a peer image grant. */
export async function pluginInputImages(plugins: readonly ArdentPlugin[], ctx: ArdentTaskPluginContext): Promise<string[]> {
  const images = z.array(Image).max(5).parse((await Promise.all(plugins.map(plugin => plugin.inputImages?.(ctx) ?? []))).flat());
  if (!images.length) return [];
  if (ctx.task.context !== 'direct' || ctx.task.backend !== 'codex') throw new Error('Extension images require a direct Codex task');
  const root = join(await realpath(ctx.profileDir), 'artifacts');
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || await realpath(root) !== root)
    throw new Error('Extension image directory is not an owned profile artifact directory');
  const seen = new Set<string>();
  for (const image of images) {
    const path = await realpath(image.path);
    if (path !== image.path || !path.startsWith(root + sep) || seen.has(path)) throw new Error('Extension image path is not a unique retained artifact');
    seen.add(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size < 8 || stat.size > 8 * 1024 * 1024)
        throw new Error('Extension image ownership or size differs');
      const bytes = await file.readFile();
      if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== image.sha256)
        throw new Error('Extension image digest differs');
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
        throw new Error('Extension input is not a supported image');
    } finally { await file.close(); }
  }
  return images.map(image => image.path);
}
