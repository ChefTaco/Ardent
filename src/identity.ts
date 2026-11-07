import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArdentConfig } from './config.js';

export type IdentityKind = 'soul' | 'identity';
export type IdentityFile = { kind: IdentityKind; name: string; text: string; revision: string };
function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function name(config: ArdentConfig, kind: IdentityKind): string { return kind === 'soul' ? config.identity.soul_file : config.identity.identity_file; }
function historyDir(dir: string, kind: IdentityKind): string { return join(dir, 'state', 'identity-history', kind); }
const historyNamePattern = /^\d+-[a-f0-9]{12}-([a-f0-9]{64})\.md$/;

export async function readIdentity(dir: string, config: ArdentConfig, kind: IdentityKind): Promise<IdentityFile> {
  const filename = name(config, kind);
  const text = await readFile(join(dir, filename), 'utf8');
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Identity file exceeds 128 KiB');
  return { kind, name: filename, text, revision: digest(text) };
}

export async function writeIdentity(dir: string, config: ArdentConfig, kind: IdentityKind, nextText: string, expectedRevision: string): Promise<IdentityFile> {
  if (!nextText.trim() || Buffer.byteLength(nextText) > 128 * 1024) throw new Error('Identity text must be 1 to 128 KiB');
  const history = historyDir(dir, kind);
  await mkdir(history, { recursive: true, mode: 0o700 });
  const lockPath = join(history, '.write.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Identity edit is already in progress'); });
  try {
    const previous = await readIdentity(dir, config, kind);
    if (previous.revision !== expectedRevision) throw new Error('Identity revision conflict');
    await writeFile(join(history, `${Date.now()}-${randomUUID().replaceAll('-', '').slice(0, 12)}-${previous.revision}.md`), previous.text, { mode: 0o600, flag: 'wx' });
    const temporary = join(dir, `.${previous.name}.${randomUUID()}.tmp`);
    await writeFile(temporary, nextText, { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(dir, previous.name));
    const snapshots = (await readdir(history)).filter(file => historyNamePattern.test(file)).sort().reverse();
    for (const stale of snapshots.slice(20)) await unlink(join(history, stale));
    return readIdentity(dir, config, kind);
  } finally { await lock.close(); await unlink(lockPath); }
}

export async function identityHistory(dir: string, kind: IdentityKind): Promise<{ name: string; revision: string }[]> {
  const files = await readdir(historyDir(dir, kind)).catch(() => []);
  return files.filter(file => historyNamePattern.test(file)).sort().reverse().slice(0, 20).map(file => ({ name: file, revision: historyNamePattern.exec(file)?.[1] ?? '' }));
}

export async function restoreIdentity(dir: string, config: ArdentConfig, kind: IdentityKind, historyName: string, expectedRevision: string): Promise<IdentityFile> {
  const revision = historyNamePattern.exec(historyName)?.[1];
  if (!revision) throw new Error('Invalid identity history entry');
  const text = await readFile(join(historyDir(dir, kind), historyName), 'utf8');
  if (digest(text) !== revision) throw new Error('Identity history checksum mismatch');
  return writeIdentity(dir, config, kind, text, expectedRevision);
}
