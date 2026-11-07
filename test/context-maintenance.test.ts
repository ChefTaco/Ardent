import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../src/store.js';
import { assertContextIdle, contextMaintenance, exerciseContext, snapshotContext, verifyContextSnapshot } from '../src/context-maintenance.js';
import { parseModelPolicy } from '../src/model-policy.js';

const directories: string[] = [];
const stores: TaskStore[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'context-maintenance-'));
  directories.push(directory);
  const store = new TaskStore(join(directory, 'state/ardent.sqlite'));
  stores.push(store);
  const bytes = JSON.stringify({ schema_version: 1, revision: 1,
    primary: { codex: { model: 'fixture', reasoning_effort: 'low' }, llamacpp: { mode: 'profile' } },
    compaction: { enabled: true, routes: [{ backend: 'codex', model: 'fixture', reasoning_effort: 'low' }], prompt_budget_tokens: 32000,
      output_reserve_tokens: 8000, checkpoint_max_tokens: 4000, recent_max_tokens: 8000, trigger_ratio: 0.7 } });
  const policy = { ...parseModelPolicy(bytes), path: join(directory, 'policy.json') };
  await writeFile(policy.path, bytes, { mode: 0o600 });
  return { directory, store, policy };
}

describe('context-only maintenance preservation', () => {
  it('accepts legacy SQLite permissions only inside an owner-private directory without changing permissions', async () => {
    const { directory, policy } = await fixture();
    vi.stubEnv('ARDENT_HOME', directory);
    await mkdir(join(directory, 'model-policy'));
    await writeFile(join(directory, 'model-policy/active.json'), await readFile(policy.path), { mode: 0o600 });
    await writeFile(join(directory, 'config.yaml'), 'synthetic fixture');
    const path = join(directory, 'state/ardent.sqlite');
    await chmod(path, 0o644);
    const request = { operation: 'inspect', profile_dir: directory, work_dir: directory, previous_module: '/unused',
      expected_policy_sha256: policy.sha256, expected_config_sha256: createHash('sha256').update('synthetic fixture').digest('hex') };
    expect(await contextMaintenance(request)).toMatchObject({ idle: true });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await chmod(join(directory, 'state'), 0o755);
    await expect(contextMaintenance(request)).rejects.toThrow('owner-private');
    await chmod(join(directory, 'state'), 0o700);
    await chmod(path, 0o660);
    await expect(contextMaintenance(request)).rejects.toThrow('owner-private');
  });
  it('allows append-only journal growth and rejects rewriting original rows', async () => {
    const { store } = await fixture();
    const task = store.accept({ caller: 'fixture', context: 'direct', prompt: 'Original work', backend: 'codex', deadlineMs: Date.now() + 60000 });
    store.startQueued(task.id); store.finishWithAssistant(task.id, 'completed', 'Original answer');
    const snapshot = snapshotContext(store.db);
    store.append(task.id, 'fixture', { appended: true });
    expect(() => verifyContextSnapshot(store.db, snapshot)).not.toThrow();
    store.db.prepare('UPDATE events SET detail_json=? WHERE sequence=(SELECT min(sequence) FROM events)').run('{}');
    expect(() => verifyContextSnapshot(store.db, snapshot)).toThrow('changed');
  });
  it('retains unknown work and rejects promoting it to completion', async () => {
    const { store } = await fixture();
    const task = store.accept({ caller: 'fixture', context: 'direct', prompt: 'Uncertain delivery', backend: 'codex', deadlineMs: Date.now() + 60000 });
    store.startQueued(task.id); store.setState(task.id, 'unknown', null, 'Uncertain external effect');
    expect(() => assertContextIdle(store.db)).not.toThrow();
    const snapshot = snapshotContext(store.db);
    store.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(task.id);
    expect(() => verifyContextSnapshot(store.db, snapshot)).toThrow('uncertain effects changed');
  });
  it('refuses unfinished tasks and preserves the existing one-way fence', async () => {
    const { store } = await fixture();
    const task = store.accept({ caller: 'fixture', context: 'direct', prompt: 'Pending', backend: 'codex', deadlineMs: Date.now() + 60000 });
    expect(() => assertContextIdle(store.db)).toThrow('unfinished tasks');
    store.setState(task.id, 'cancelled', null, 'No external effect started');
    const release = '11111111-1111-4111-8111-111111111111';
    store.closeAdmission(release);
    expect(() => assertContextIdle(store.db)).toThrow('one-way');
    expect(store.admissionFence()?.release_id).toBe(release);
  });
  it('exercises compaction, attributed continuation, exact recovery, previous-reader rollback and rebuild in an isolated database', async () => {
    const { store, policy } = await fixture();
    let calls = 0;
    const summarize = async (_route: unknown, prompt: string) => {
      calls++;
      const input = JSON.parse(prompt) as { exchanges: Array<{ user: { id: number } }> };
      return JSON.stringify({ items: [{ kind: 'correction', text: 'Ω-42 is monthly. Source verification is pending; delivery remains unknown.',
        source_message_ids: [input.exchanges[0]!.user.id], historical_status: 'historical_unverified' }] });
    };
    const result = await exerciseContext(store, summarize, policy, resolve(import.meta.dirname, 'fixtures/context-checkpoints-pre-emberfold.ts'), async messages => {
      expect(JSON.stringify(messages)).toContain('monthly');
      return JSON.stringify({ reference: 'Ω-42', schedule: 'monthly', verification: 'pending', delivery: 'unknown' });
    });
    expect(result).toMatchObject({ compacted: true, continued: true, rebuilt: true, previous_reader: true, original_messages_unchanged: true });
    expect(calls).toBe(2);
    expect(store.db.prepare('SELECT count(*) AS total FROM session_messages').get()).toEqual({ total: 8 });
    expect(store.db.prepare("SELECT count(*) AS total FROM events WHERE kind LIKE '%tool%'").get()).toEqual({ total: 0 });
  });
  it('does not call the continuation provider when checkpoint preparation fails', async () => {
    const { store, policy } = await fixture();
    let continued = false;
    await expect(exerciseContext(store, async () => { throw new Error('Provider unavailable'); }, policy,
      resolve(import.meta.dirname, 'fixtures/context-checkpoints-pre-emberfold.ts'), async () => { continued = true; return '{}'; }))
      .rejects.toThrow('real checkpoint');
    expect(continued).toBe(false);
    expect(store.db.prepare('SELECT count(*) AS total FROM session_messages').get()).toEqual({ total: 8 });
  });
  it('requires a current policy pin before any backup or model operation', async () => {
    const { directory, policy } = await fixture();
    await chmod(join(directory, 'state/ardent.sqlite'), 0o600);
    vi.stubEnv('ARDENT_HOME', directory);
    await mkdir(join(directory, 'model-policy'));
    await writeFile(join(directory, 'model-policy/active.json'), await readFile(policy.path), { mode: 0o600 });
    await writeFile(join(directory, 'config.yaml'), 'synthetic fixture');
    await expect(contextMaintenance({ operation: 'backup', profile_dir: directory, work_dir: directory,
      previous_module: '/unused', expected_policy_sha256: '0'.repeat(64), expected_config_sha256: createHash('sha256').update('synthetic fixture').digest('hex') })).rejects.toThrow('adoption pin');
    await expect(stat(join(directory, 'original.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
