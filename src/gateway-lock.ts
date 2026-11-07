import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export type GatewayLock = { readonly path: string; readonly pid: number; readonly ino: number; release(): Promise<void> };

/**
 * Publishes a profile lock that already contains this PID. The PID is written
 * to a private temporary file first and then hard-linked into place, so the
 * lock is never observable empty and link() fails with EEXIST if any lock exists.
 */
export async function createLockFile(lockPath: string, pid = process.pid): Promise<GatewayLock> {
  const temp = `${lockPath}.${pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  let ino: number;
  try {
    await handle.writeFile(String(pid));
    await handle.sync();
    ino = (await handle.stat()).ino;
  } catch (error: unknown) {
    await handle.close();
    await unlink(temp).catch(() => {});
    throw error;
  }
  await handle.close();
  try { await link(temp, lockPath); }
  finally { await unlink(temp).catch(() => {}); }
  return {
    path: lockPath, pid, ino,
    // Remove only the exact lock this process published; a replaced or foreign lock stays.
    async release(): Promise<void> {
      const owned = await Promise.all([lstat(lockPath), readFile(lockPath, 'utf8')])
        .then(([stat, text]) => stat.ino === ino && text.trim() === String(pid), () => false);
      if (owned) await unlink(lockPath).catch((error: unknown) => { if (!isCode(error, 'ENOENT')) throw error; });
    }
  };
}

/** Returns the inode of a lock whose recorded PID is gone, 'gone' if the lock vanished, or null otherwise. */
async function staleLockInode(lockPath: string): Promise<number | 'gone' | null> {
  let handle;
  try { handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: unknown) {
    if (isCode(error, 'ENOENT')) return 'gone';
    return null;
  }
  try {
    const stat = await handle.stat();
    const text = await handle.readFile({ encoding: 'utf8' });
    const pid = Number(text.trim());
    // An empty or malformed lock is not proof of a dead owner.
    if (!stat.isFile() || text.trim() === '' || !Number.isSafeInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return null; }
    catch (error: unknown) { return isCode(error, 'ESRCH') ? stat.ino : null; }
  } finally { await handle.close(); }
}

/**
 * Takes the exclusive gateway lock. A lock whose recorded PID no longer exists is a crash leftover
 * (for example a SIGKILL after a stop timeout) and is replaced once; a live, unreadable, empty, or
 * malformed lock still refuses so two gateways can never own one profile.
 */
export async function acquireGatewayLock(lockPath: string): Promise<GatewayLock> {
  for (let attempt = 0; ; attempt++) {
    try { return await createLockFile(lockPath); }
    catch (error: unknown) {
      if (!isCode(error, 'EEXIST')) throw error;
      const stale = attempt === 0 ? await staleLockInode(lockPath) : null;
      if (stale === null) throw new Error('Profile is already owned by a gateway; inspect state/gateway.lock');
      if (stale === 'gone') continue;
      // Unlink only the exact stale file inspected above, not a lock that replaced it.
      const current = await lstat(lockPath).then(stat => stat.ino, (cause: unknown) => {
        if (isCode(cause, 'ENOENT')) return null;
        throw cause;
      });
      if (current === stale) await unlink(lockPath).catch((cause: unknown) => { if (!isCode(cause, 'ENOENT')) throw cause; });
    }
  }
}
