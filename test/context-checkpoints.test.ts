import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextCheckpoints, type CompactionCall } from '../src/context-checkpoints.js';
import { parseModelPolicy, type LoadedModelPolicy } from '../src/model-policy.js';
import { TaskStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ardent-context-'));
  dirs.push(dir);
  const store = new TaskStore(join(dir, 'ardent.sqlite'));
  const session = store.session('alice', 'direct', 'chat');
  const add = (prompt: string, state: 'completed' | 'unknown' = 'completed') => {
    const task = store.accept({ caller: 'alice', context: 'direct', sessionId: session.id, prompt,
      backend: 'codex', deadlineMs: Date.now() + 60_000 });
    store.startQueued(task.id);
    if (state === 'completed') store.finishWithAssistant(task.id, 'completed', 'Answer: ' + prompt);
    else store.setState(task.id, 'unknown', null, 'Effect unresolved');
    return task;
  };
  const bytes = JSON.stringify({ schema_version: 1, revision: 1,
    primary: { codex: { model: 'gpt-6.1-sol', reasoning_effort: 'medium' }, llamacpp: { mode: 'profile' } },
    compaction: { enabled: true, routes: [{ backend: 'codex', model: 'gpt-6-luna', reasoning_effort: 'low' },
      { backend: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'low' }], prompt_budget_tokens: 32000,
      output_reserve_tokens: 8000, checkpoint_max_tokens: 4000, recent_max_tokens: 8000, trigger_ratio: 0.7 } });
  const policy: LoadedModelPolicy = { ...parseModelPolicy(bytes), path: join(dir, 'policy.json') };
  writeFileSync(policy.path, bytes, { mode: 0o600 });
  const preview = { id: 'preview:test', session_id: session.id, caller: 'alice', context: 'direct' as const, prompt: '' };
  const summarize: CompactionCall = async (_route, prompt) => {
    const input = JSON.parse(prompt) as { exchanges: Array<{ user: { id: number; text: string } }> };
    return JSON.stringify({ items: [{ kind: 'open_item', text: 'Historical work needs authoritative verification',
      source_message_ids: [input.exchanges[0]!.user.id], historical_status: 'historical_unverified' }] });
  };
  return { store, session, add, policy, preview, summarize };
}

describe('durable context checkpoints', () => {
  it('rejects publication when the host policy changes during summarization', async () => {
    const fixtureData = fixture();
    fixtureData.add('first'); fixtureData.add('second'); fixtureData.add('third');
    const manager = new ContextCheckpoints(fixtureData.store, async (...args) => {
      const summary = await fixtureData.summarize(...args);
      writeFileSync(fixtureData.policy.path, JSON.stringify({ ...fixtureData.policy.policy, revision: 2 }), { mode: 0o600 });
      return summary;
    });
    await expect(manager.prepare(fixtureData.preview, 'Current policy', [], fixtureData.policy, AbortSignal.timeout(5000), { force: true, apply: true }))
      .rejects.toThrow('Model policy changed during compaction');
    expect(fixtureData.store.db.prepare('SELECT count(*) AS total FROM context_checkpoints').get()).toEqual({ total: 0 });
    expect(fixtureData.store.db.prepare('SELECT count(*) AS total FROM emberfold_checkpoint_metadata').get()).toEqual({ total: 0 });
    expect(manager.status(fixtureData.session.id, 'alice', 'direct')).toMatchObject({ active_checkpoint_id: null });
    fixtureData.store.close();
  });
  it('publishes a digest-bound head while keeping complete recent exchanges and the full journal', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const manager = new ContextCheckpoints(f.store, f.summarize);
    const result = await manager.prepare(f.preview, 'Current policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    expect(result.compacted).toBe(true);
    expect(result.messages[0]?.content).toContain('Current policy');
    expect(result.messages.map(item => item.content).join(' ')).toContain('second');
    expect(result.messages.map(item => item.content).join(' ')).not.toContain('Answer: first');
    expect(manager.status(f.session.id, 'alice', 'direct')).toMatchObject({ valid: true, model: 'gpt-6-luna', policy_revision: 1 });
    expect(f.store.db.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual({ n: 6 });
    expect(f.store.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 9 });
    expect(() => manager.status(f.session.id, 'bob', 'direct')).toThrow('mismatch');
    f.store.close();
  });

  it('allows a concurrent appended message but fences a competing head and excludes unknown work', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const unknown = f.add('uncertain external effect', 'unknown');
    let queued = '';
    const manager = new ContextCheckpoints(f.store, async (route, prompt, signal) => {
      queued = f.store.accept({ caller: 'alice', context: 'direct', sessionId: f.session.id,
        prompt: 'arrived during compaction', backend: 'codex', deadlineMs: Date.now() + 60_000 }).id;
      return f.summarize(route, prompt, signal);
    });
    const result = await manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true, expectedHead: null });
    expect(result.compacted).toBe(true);
    expect(result.messages.map(item => item.content).join(' ')).not.toContain('arrived during compaction');
    expect(f.store.get(queued)?.state).toBe('queued');
    expect(f.store.get(unknown.id)?.state).toBe('unknown');
    await expect(manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000),
      { force: true, apply: true, expectedHead: null })).rejects.toThrow('head changed');
    f.store.close();
  });

  it('rejects corrupt checkpoint data on restart and can recover from the retained transcript', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const manager = new ContextCheckpoints(f.store, f.summarize);
    await manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    const id = manager.status(f.session.id, 'alice', 'direct').active_checkpoint_id;
    f.store.db.prepare('UPDATE context_checkpoints SET summary_sha256=? WHERE id=?').run('0'.repeat(64), id);
    expect(manager.status(f.session.id, 'alice', 'direct')).toMatchObject({ valid: false, validation_error: 'Checkpoint summary digest mismatch' });
    const recovered = new ContextCheckpoints(f.store, f.summarize);
    const result = await recovered.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    expect(result.compacted).toBe(true);
    expect(recovered.status(f.session.id, 'alice', 'direct')).toMatchObject({ valid: true });
    f.store.close();
  });

  it('records the fallback model and fails safely if both routes are unavailable above budget', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const fallback = new ContextCheckpoints(f.store, async (route, prompt, signal) => {
      if (route.model === 'gpt-6-luna') throw new Error('unavailable');
      return f.summarize(route, prompt, signal);
    });
    await fallback.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    expect(fallback.status(f.session.id, 'alice', 'direct')).toMatchObject({ model: 'gpt-6.1-sol' });
    f.add('fourth'); f.add('fifth'); f.add('sixth');
    const unavailable = new ContextCheckpoints(f.store, async () => { throw new Error('offline'); });
    await expect(unavailable.prepare(f.preview, 'x'.repeat(90000), [], f.policy, AbortSignal.timeout(5000),
      { force: true, apply: true })).rejects.toThrow('CONTEXT_COMPACTION_UNAVAILABLE');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual({ n: 12 });
    f.store.close();
  });

  it('isolates a reset session and refuses a cancelled or duplicate publication', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const cancelled = new AbortController();
    const stopped = new ContextCheckpoints(f.store, async (route, prompt, signal) => {
      cancelled.abort();
      return f.summarize(route, prompt, signal);
    });
    await expect(stopped.prepare(f.preview, 'Policy', [], f.policy, cancelled.signal,
      { force: true, apply: true })).rejects.toThrow('cancelled');
    expect(stopped.status(f.session.id, 'alice', 'direct').active_checkpoint_id).toBeNull();
    const manager = new ContextCheckpoints(f.store, f.summarize);
    await manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    const oldHead = manager.status(f.session.id, 'alice', 'direct').active_checkpoint_id;
    const reset = f.store.resetSession('alice', 'direct', 'chat');
    expect(reset.id).not.toBe(f.session.id);
    expect(manager.status(reset.id, 'alice', 'direct').active_checkpoint_id).toBeNull();
    expect(manager.status(f.session.id, 'alice', 'direct').active_checkpoint_id).toBe(oldHead);
    f.store.close();
  });

  it('uses a transaction to admit only one concurrent checkpoint writer', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = new ContextCheckpoints(f.store, async (route, prompt, signal) => {
      started++;
      if (started === 2) release();
      await gate;
      return f.summarize(route, prompt, signal);
    });
    const calls = [0, 1].map(() => manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000),
      { force: true, apply: true, expectedHead: null }));
    const results = await Promise.allSettled(calls);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM context_checkpoints').get()).toEqual({ n: 1 });
    f.store.close();
  });

  it('keeps source rows immutable while summarization runs and recovers on restart', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const manager = new ContextCheckpoints(f.store, async (route, prompt, signal) => {
      const source = f.store.db.prepare("SELECT sequence FROM session_messages WHERE session_id=? AND role='user' ORDER BY sequence LIMIT 1")
        .get(f.session.id) as { sequence: number };
      f.store.db.prepare('UPDATE session_messages SET content=? WHERE sequence=?').run('corrected source', source.sequence);
      return f.summarize(route, prompt, signal);
    });
    const attempt = await manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000),
      { force: true, apply: true });
    expect(attempt.compacted).toBe(false);
    expect(manager.status(f.session.id, 'alice', 'direct')).toMatchObject({
      valid: true, active_checkpoint_id: null, last_attempt: { outcome: 'failed', reason: 'Session messages are immutable' } });
    const restarted = new ContextCheckpoints(f.store, f.summarize);
    expect(restarted.plainHistory(f.preview)[0]?.content).toBe('first');
    await restarted.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000),
      { force: true, apply: true });
    expect(restarted.status(f.session.id, 'alice', 'direct')).toMatchObject({ valid: true });
    f.store.close();
  });

  it('rejects unverified effect promotion and invalid policy pins without changing task state', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const unknown = f.add('provider outcome unknown', 'unknown');
    const manager = new ContextCheckpoints(f.store, async (route, prompt) => {
      const parsed = JSON.parse(await f.summarize(route, prompt, AbortSignal.timeout(5000))) as { items: Array<Record<string, unknown>> };
      parsed.items[0]!.historical_status = 'completed';
      return JSON.stringify(parsed);
    });
    await expect(manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000),
      { force: true, apply: true, expectedPolicyRevision: 2 })).rejects.toThrow('revision changed');
    const result = await manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    expect(result.compacted).toBe(false);
    expect(manager.status(f.session.id, 'alice', 'direct').active_checkpoint_id).toBeNull();
    expect(f.store.get(unknown.id)?.state).toBe('unknown');
    f.store.close();
  });

  it('includes a prior completed exchange even when its assistant row follows the queued user row', () => {
    const f = fixture();
    const first = f.store.accept({ caller: 'alice', context: 'direct', sessionId: f.session.id,
      prompt: 'earlier request', backend: 'codex', deadlineMs: Date.now() + 60_000 });
    f.store.startQueued(first.id);
    const second = f.store.accept({ caller: 'alice', context: 'direct', sessionId: f.session.id,
      prompt: 'later request', backend: 'codex', deadlineMs: Date.now() + 60_000 });
    f.store.finishWithAssistant(first.id, 'completed', 'earlier answer');
    const manager = new ContextCheckpoints(f.store, f.summarize);
    expect(manager.plainHistory(second).map(message => message.content)).toEqual([
      'earlier request', 'earlier answer', 'later request'
    ]);
    f.store.close();
  });

  it('keeps callers and contexts isolated and omits queued or unfinished exchanges', () => {
    const f = fixture();
    f.add('alice completed');
    const bob = f.store.session('bob', 'direct', 'chat');
    const peer = f.store.session('alice', 'peer', 'chat');
    for (const [caller, context, sessionId, prompt] of [
      ['bob', 'direct', bob.id, 'bob private'],
      ['alice', 'peer', peer.id, 'peer private']
    ] as const) {
      const task = f.store.accept({ caller, context, sessionId, prompt,
        backend: 'codex', deadlineMs: Date.now() + 60_000 });
      f.store.startQueued(task.id);
      f.store.finishWithAssistant(task.id, 'completed', `${prompt} answer`);
    }
    f.store.accept({ caller: 'alice', context: 'direct', sessionId: f.session.id,
      prompt: 'queued private', backend: 'codex', deadlineMs: Date.now() + 60_000 });
    const history = new ContextCheckpoints(f.store, f.summarize).plainHistory(f.preview);
    expect(history.map(item => item.content)).toEqual(['alice completed', 'Answer: alice completed']);
    expect(() => new ContextCheckpoints(f.store, f.summarize).status(bob.id, 'alice', 'direct')).toThrow('mismatch');
    expect(() => new ContextCheckpoints(f.store, f.summarize).status(peer.id, 'alice', 'direct')).toThrow('mismatch');
    f.store.close();
  });

  it('records an independent High model policy after a Low checkpoint without rewriting history', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const manager = new ContextCheckpoints(f.store, f.summarize);
    await manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    const oldHead = manager.status(f.session.id, 'alice', 'direct').active_checkpoint_id;
    const high: LoadedModelPolicy = { ...parseModelPolicy(JSON.stringify({ ...f.policy.policy, revision: 2,
      compaction: { ...f.policy.policy.compaction, routes: f.policy.policy.compaction.routes.map(route =>
        ({ ...route, reasoning_effort: 'high' })) } })), path: join(dirs.at(-1)!, 'policy-high.json') };
    const highBytes = JSON.stringify(high.policy);
    writeFileSync(high.path, highBytes, { mode: 0o600 });
    high.sha256 = parseModelPolicy(highBytes).sha256;
    f.add('fourth'); f.add('fifth'); f.add('sixth');
    const used: string[] = [];
    const upgraded = new ContextCheckpoints(f.store, async (route, prompt, signal) => {
      used.push(`${route.model}:${route.reasoning_effort}`);
      return f.summarize(route, prompt, signal);
    });
    await upgraded.prepare(f.preview, 'Current policy', [], high, AbortSignal.timeout(5000),
      { force: true, apply: true, expectedHead: oldHead as string, expectedPolicyRevision: 2 });
    expect(used).toEqual(['gpt-6-luna:high']);
    expect(upgraded.status(f.session.id, 'alice', 'direct')).toMatchObject({
      valid: true, model: 'gpt-6-luna', reasoning_effort: 'high', policy_revision: 2 });
    expect(f.store.db.prepare('SELECT reasoning_effort,policy_revision FROM context_checkpoints WHERE id=?').get(oldHead))
      .toEqual({ reasoning_effort: 'low', policy_revision: 1 });
    expect(f.store.db.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual({ n: 12 });
    f.store.close();
  });

  it('rejects invalid summary schema, source digest, and oversized recent exchanges without losing messages', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const manager = new ContextCheckpoints(f.store, f.summarize);
    await manager.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    const id = manager.status(f.session.id, 'alice', 'direct').active_checkpoint_id;
    const original = f.store.db.prepare('SELECT summary_json,summary_sha256 FROM context_checkpoints WHERE id=?')
      .get(id) as { summary_json: string; summary_sha256: string };
    const invalid = JSON.stringify({ items: [{ kind: 'status', text: 'unsupported', source_message_ids: [1],
      historical_status: 'completed' }] });
    f.store.db.prepare('UPDATE context_checkpoints SET summary_json=?,summary_sha256=? WHERE id=?')
      .run(invalid, createHash('sha256').update(invalid).digest('hex'), id);
    expect(manager.status(f.session.id, 'alice', 'direct')).toMatchObject({ valid: false });
    f.store.db.prepare('UPDATE context_checkpoints SET summary_json=?,summary_sha256=? WHERE id=?')
      .run(original.summary_json, original.summary_sha256, id);
    f.store.db.prepare('UPDATE context_checkpoints SET source_sha256=? WHERE id=?').run('0'.repeat(64), id);
    expect(manager.status(f.session.id, 'alice', 'direct')).toMatchObject({
      valid: false, validation_error: 'Checkpoint source digest mismatch' });
    const recovered = new ContextCheckpoints(f.store, f.summarize);
    await recovered.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    expect(recovered.status(f.session.id, 'alice', 'direct')).toMatchObject({ valid: true });
    f.add('large recent one ' + 'x'.repeat(13000));
    f.add('large recent two ' + 'x'.repeat(13000));
    await expect(recovered.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000),
      { force: true, apply: true })).rejects.toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual({ n: 10 });
    f.store.close();
  });

  it('recovers deterministically across interrupted publication stages and a policy rollback', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const before = f.store.db.prepare('SELECT count(*) AS n FROM session_messages').get();
    const events = f.store.db.prepare('SELECT count(*) AS n FROM events').get();
    const cancelled = new AbortController();
    const interrupted = new ContextCheckpoints(f.store, async (route, prompt, signal) => {
      const output = await f.summarize(route, prompt, signal);
      cancelled.abort(); // Model returned, but publication has not begun.
      return output;
    });
    await expect(interrupted.prepare(f.preview, 'Policy', [], f.policy, cancelled.signal,
      { force: true, apply: true })).rejects.toThrow('cancelled');
    expect(new ContextCheckpoints(f.store, f.summarize).status(f.session.id, 'alice', 'direct').active_checkpoint_id).toBeNull();

    const published = new ContextCheckpoints(f.store, f.summarize);
    await published.prepare(f.preview, 'Policy', [], f.policy, AbortSignal.timeout(5000), { force: true, apply: true });
    const head = published.status(f.session.id, 'alice', 'direct').active_checkpoint_id;
    // A crash after the atomic head transaction but before its attempt receipt
    // leaves a valid head. An unfinished attempt row cannot supersede it.
    f.store.db.prepare(`INSERT INTO context_compaction_attempts
      (id,session_id,source_watermark,parent_id,policy_revision,model,outcome,reason,created_ms)
      VALUES (?,?,?,?,?,?,?,?,?)`).run('interrupted-attempt', f.session.id, null, head, 2,
        'gpt-6-luna', 'started', null, Date.now() + 1000);
    const restarted = new ContextCheckpoints(f.store, f.summarize);
    expect(restarted.status(f.session.id, 'alice', 'direct')).toMatchObject({
      valid: true, active_checkpoint_id: head, last_attempt: { outcome: 'started' } });
    const rolledBack = await restarted.prepare(f.preview, 'Restored policy', [], f.policy,
      AbortSignal.timeout(5000));
    expect(rolledBack.messages[0]?.content).toContain('Restored policy');
    expect(restarted.status(f.session.id, 'alice', 'direct').active_checkpoint_id).toBe(head);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual(before);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual(events);
    f.store.close();
  });

  it('fails closed for oversized current policy and tool schemas while preserving history', async () => {
    const f = fixture();
    f.add('first'); f.add('second'); f.add('third');
    const manager = new ContextCheckpoints(f.store, f.summarize);
    const before = f.store.db.prepare('SELECT count(*) AS n FROM session_messages').get();
    await expect(manager.prepare(f.preview, 'p'.repeat(90000), [], f.policy,
      AbortSignal.timeout(5000), { apply: true })).rejects.toThrow('CONTEXT_BUDGET_EXCEEDED');
    await expect(manager.prepare(f.preview, 'Policy', [{ description: 't'.repeat(90000) }], f.policy,
      AbortSignal.timeout(5000), { apply: true })).rejects.toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM session_messages').get()).toEqual(before);
    expect(manager.status(f.session.id, 'alice', 'direct')).toMatchObject({ valid: true });
    f.store.close();
  });
});
