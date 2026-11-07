#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseModelPolicy } from '../dist/model-policy.js';
import { loadConfig } from '../dist/config.js';
import { CodexAppServer, assertCodexProtocol } from '../dist/codex.js';

const args = process.argv.slice(2);
const action = args.shift();
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!key?.startsWith('--') || !value || value.startsWith('--') || flags.has(key)) throw new Error('Invalid or duplicate option');
  flags.set(key, value);
}
const need = key => { const value = flags.get(key); if (!value) throw new Error(`Missing ${key}`); return value; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const profileDir = resolve(need('--profile-path'));
const home = dirname(dirname(profileDir));
const root = join(home, 'model-policy');
const active = join(root, 'active.json');
const releaseId = flags.get('--release-id');
if (!['status', 'dry-run', 'deploy', 'rollback'].includes(action)) throw new Error('Use status, dry-run, deploy, or rollback');
if (action !== 'status' && (!releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(releaseId))) throw new Error('Safe --release-id required');
const uid = process.getuid?.();
if (uid === undefined) throw new Error('A local Unix profile owner is required');
const profileStat = await lstat(profileDir);
if (!profileStat.isDirectory() || profileStat.isSymbolicLink() || profileStat.uid !== uid || (profileStat.mode & 0o077))
  throw new Error('Profile path must be owner-only');
const { config } = await loadConfig(profileDir);
const currentBytes = await readFile(active, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (currentBytes) {
  const activeStat = await lstat(active);
  if (!activeStat.isFile() || activeStat.isSymbolicLink() || activeStat.uid !== uid || (activeStat.mode & 0o077))
    throw new Error('Current model policy must be owner-only');
}
const current = currentBytes ? parseModelPolicy(currentBytes) : null;
const currentSha = current?.sha256 ?? 'none';
const state = { profile: config.profile, path: active, current_revision: current?.policy.revision ?? null, current_sha256: currentSha };
if (action === 'status') { console.log(JSON.stringify(state)); process.exit(0); }
if (action === 'rollback') {
  const recordPath = join(root, 'releases', `${releaseId}.json`);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (record.release_id !== releaseId || !['deployed', 'prepared', 'recovery_required'].includes(record.state) ||
      ![record.before_sha256, record.after_sha256].includes(currentSha))
    throw new Error('Rollback receipt or current policy differs');
  const before = record.before_sha256 === 'none' ? null : await readFile(join(root, 'releases', `${releaseId}.before.json`), 'utf8');
  if ((before ? sha(before) : 'none') !== record.before_sha256) throw new Error('Rollback backup digest differs');
  if (currentSha !== record.before_sha256) {
    if (before) { const tmp = `${active}.${randomUUID()}.tmp`; await writeFile(tmp, before, { mode: 0o600 }); await rename(tmp, active); }
    else await unlink(active);
  }
  await writeFile(recordPath, JSON.stringify({ ...record, state: 'rolled_back', rolled_back_at: new Date().toISOString() }), { mode: 0o600 });
  console.log(JSON.stringify({ ...state, state: 'rolled_back', restored_sha256: record.before_sha256 }));
  process.exit(0);
}
const expectedCurrent = need('--expected-current-sha256');
if (expectedCurrent !== currentSha) throw new Error('Current policy digest differs from compare-and-swap pin');
const source = need('--source');
if (!isAbsolute(source)) throw new Error('Candidate source must be absolute');
const stat = await lstat(source);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('Candidate must be a bounded regular file');
const candidateBytes = await readFile(source, 'utf8');
const candidate = parseModelPolicy(candidateBytes);
if (candidate.sha256 !== need('--expected-source-sha256')) throw new Error('Candidate digest differs from pin');
if (candidate.policy.revision <= (current?.policy.revision ?? 0)) throw new Error('Model policy revision must increase');
const primaryChanged = JSON.stringify(candidate.policy.primary) !== JSON.stringify(current?.policy.primary ?? null);
const compactionChanged = JSON.stringify(candidate.policy.compaction) !== JSON.stringify(current?.policy.compaction ?? null);
// Availability is checked using the installed Codex protocol and this profile owner's login.
await assertCodexProtocol(config.providers.codex.command);
const server = new CodexAppServer(config.providers.codex.command, profileDir);
try {
  await server.initialize();
  if (await server.accountStatus() !== config.providers.codex.auth_mode) throw new Error('Codex login is unavailable');
  const listed = await server.listedModelEfforts();
  const routes = [candidate.policy.primary.codex, ...candidate.policy.compaction.routes];
  for (const route of routes) if (!listed.get(route.model)?.has(route.reasoning_effort))
    throw new Error(`Codex model ${route.model} at ${route.reasoning_effort} effort is unavailable`);
} finally { server.close(); }
const result = { ...state, release_id: releaseId, candidate_revision: candidate.policy.revision,
  candidate_sha256: candidate.sha256, primary_changed: primaryChanged, compaction_changed: compactionChanged,
  routes: candidate.policy.compaction.routes.map(route => ({ model: route.model, reasoning_effort: route.reasoning_effort })),
  model_list_checked: true };
if (action === 'dry-run') { console.log(JSON.stringify({ ...result, state: 'validated' })); process.exit(0); }
await mkdir(join(root, 'revisions'), { recursive: true, mode: 0o700 });
await mkdir(join(root, 'releases'), { recursive: true, mode: 0o700 });
const recordPath = join(root, 'releases', `${releaseId}.json`);
const recordHandle = await open(recordPath, 'wx', 0o600);
const backup = join(root, 'releases', `${releaseId}.before.json`);
const revisionFile = join(root, 'revisions', `${candidate.policy.revision}-${candidate.sha256}.json`);
try {
  if (currentBytes) await writeFile(backup, currentBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(revisionFile, candidateBytes, { flag: 'wx', mode: 0o600 });
  await recordHandle.writeFile(JSON.stringify({ release_id: releaseId, state: 'prepared', before_sha256: currentSha,
    after_sha256: candidate.sha256, revision: candidate.policy.revision, prepared_at: new Date().toISOString() }));
  await recordHandle.sync();
} finally { await recordHandle.close(); }
const tmp = `${active}.${randomUUID()}.tmp`;
await writeFile(tmp, candidateBytes, { mode: 0o600 });
const tempHandle = await open(tmp, 'r');
try { await tempHandle.sync(); } finally { await tempHandle.close(); }
try {
  const fresh = await readFile(active, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if ((fresh ? sha(fresh) : 'none') !== currentSha) throw new Error('Current policy changed before publication');
  await rename(tmp, active);
  const directoryHandle = await open(root, 'r');
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  if (sha(await readFile(active)) !== candidate.sha256) throw new Error('Published policy digest differs');
  await writeFile(recordPath, JSON.stringify({ release_id: releaseId, state: 'deployed', before_sha256: currentSha,
    after_sha256: candidate.sha256, revision: candidate.policy.revision, deployed_at: new Date().toISOString() }), { mode: 0o600 });
  console.log(JSON.stringify({ ...result, state: 'deployed', rollback: `model-policy-release.mjs rollback --profile-path ${profileDir} --release-id ${releaseId}` }));
} catch (error) {
  await unlink(tmp).catch(() => undefined);
  let recovery = 'recovery_required';
  try {
    const installed = await readFile(active, 'utf8').catch(inner => { if (inner.code === 'ENOENT') return null; throw inner; });
    const installedSha = installed ? sha(installed) : 'none';
    if (installedSha === candidate.sha256) {
      if (currentBytes) { const restore = `${active}.${randomUUID()}.restore`; await writeFile(restore, currentBytes, { mode: 0o600 }); await rename(restore, active); }
      else await unlink(active);
    }
    const restored = await readFile(active, 'utf8').catch(inner => { if (inner.code === 'ENOENT') return null; throw inner; });
    if ((restored ? sha(restored) : 'none') === currentSha) recovery = 'auto_restored';
  } catch { /* Preserve the prepared receipt and exact backup for manual recovery. */ }
  await writeFile(recordPath, JSON.stringify({ release_id: releaseId, state: recovery, before_sha256: currentSha,
    after_sha256: candidate.sha256, revision: candidate.policy.revision, failure: String(error).slice(0, 500) }), { mode: 0o600 });
  throw error;
}
