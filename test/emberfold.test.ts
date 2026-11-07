import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextCheckpoints } from '../src/context-checkpoints.js';
import { ContextCheckpoints as PreviousContextCheckpoints } from './fixtures/context-checkpoints-pre-emberfold.js';
import { parseModelPolicy } from '../src/model-policy.js';
import { TaskStore } from '../src/store.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe('Emberfold additive checkpoint integration', () => {
  it('supports previous-reader rollback and restart without rewriting original messages', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ardent-emberfold-'));
    directories.push(directory);
    const database = join(directory, 'state.sqlite');
    const store = new TaskStore(database);
    const session = store.session('alice', 'direct', 'chat');
    for (const prompt of ['first', 'second', 'third']) {
      const task = store.accept({ caller: 'alice', context: 'direct', sessionId: session.id, prompt, backend: 'codex', deadlineMs: Date.now() + 60000 });
      store.startQueued(task.id);
      store.finishWithAssistant(task.id, 'completed', 'Answer: ' + prompt);
    }
    const policy = { ...parseModelPolicy(JSON.stringify({ schema_version: 1, revision: 1,
      primary: { codex: { model: 'fixture', reasoning_effort: 'low' }, llamacpp: { mode: 'profile' } },
      compaction: { enabled: true, routes: [{ backend: 'codex', model: 'fixture', reasoning_effort: 'low' }], prompt_budget_tokens: 32000,
        output_reserve_tokens: 8000, checkpoint_max_tokens: 4000, recent_max_tokens: 8000, trigger_ratio: 0.7 } })), path: join(directory, 'policy.json') };
    const policyBytes = JSON.stringify(policy.policy);
    writeFileSync(policy.path, policyBytes, { mode: 0o600 });
    policy.sha256 = parseModelPolicy(policyBytes).sha256;
    const summarize = async () => JSON.stringify({ items: [{ kind: 'open_item', text: 'Work remains unverified', source_message_ids: [1], historical_status: 'historical_unverified' }] });
    const preview = { id: 'preview:fixture', session_id: session.id, caller: 'alice', context: 'direct' as const, prompt: '' };
    const originals = JSON.stringify(store.db.prepare('SELECT * FROM session_messages ORDER BY sequence').all());
    const manager = new ContextCheckpoints(store, summarize);
    await manager.prepare(preview, 'Current policy', [], policy, AbortSignal.timeout(5000), { force: true, apply: true });
    expect(store.db.prepare('SELECT count(*) AS total FROM emberfold_checkpoint_metadata').get()).toEqual({ total: 1 });
    const expectedHead = manager.status(session.id, 'alice', 'direct').active_checkpoint_id;
    store.close();
    const reopened = new TaskStore(database);
    const rollback = new PreviousContextCheckpoints(reopened, summarize);
    expect(rollback.status(session.id, 'alice', 'direct')).toMatchObject({ valid: true, active_checkpoint_id: expectedHead });
    const continued = await rollback.prepare(preview, 'Current policy', [], policy, AbortSignal.timeout(5000));
    expect(continued.messages.at(-1)?.content).toBe('Answer: third');
    expect(JSON.stringify(reopened.db.prepare('SELECT * FROM session_messages ORDER BY sequence').all())).toBe(originals);
    reopened.db.prepare('UPDATE emberfold_checkpoint_metadata SET metadata_json=? WHERE checkpoint_id=?').run('{}', expectedHead);
    expect(new ContextCheckpoints(reopened, summarize).status(session.id, 'alice', 'direct').valid).toBe(false);
    expect(rollback.status(session.id, 'alice', 'direct').valid).toBe(true);
    reopened.close();
  });
});
