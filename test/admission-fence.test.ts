import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Team candidate admission fence', () => {
  it('persists the exact rollback release and serializes intake with task start across connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ardent-admission-'));
    dirs.push(dir);
    const path = join(dir, 'state', 'ardent.sqlite');
    const gateway = new TaskStore(path);
    const controller = new TaskStore(path);
    const task = gateway.accept({ caller: 'peer', context: 'peer', prompt: 'Retained work', backend: 'codex', deadlineMs: Date.now() + 60_000 });
    const release = randomUUID();
    const closed = controller.closeAdmission(release);
    expect(closed).toMatchObject({ release_id: release, queued: 1, running: 0, unknown: 0, deliveries_unsettled: 0 });
    expect(controller.closeAdmission(release)).toEqual(closed);
    expect(() => controller.closeAdmission(randomUUID())).toThrow('another release');
    expect(() => gateway.accept({ caller: 'peer', context: 'peer', prompt: 'New work', backend: 'codex', deadlineMs: Date.now() + 60_000 })).toThrow('admission is fenced');
    expect(() => gateway.startQueued(task.id)).toThrow('admission is fenced');
    expect(gateway.get(task.id)?.state).toBe('queued');
    expect(() => gateway.claimInbound('telegram', 'account', 'update')).toThrow('admission is fenced');
    gateway.close(); controller.close();
    const restarted = new TaskStore(path);
    expect(restarted.admissionFence()).toEqual({ release_id: release, closed_ms: closed.closed_ms });
    restarted.close();
  });

  it('retains already running and unknown work for explicit reconciliation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ardent-admission-'));
    dirs.push(dir);
    const store = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
    const running = store.accept({ caller: 'management', context: 'direct', prompt: 'Started', backend: 'codex', deadlineMs: Date.now() + 60_000 });
    store.startQueued(running.id);
    const unknown = store.accept({ caller: 'management', context: 'direct', prompt: 'Uncertain', backend: 'codex', deadlineMs: Date.now() + 60_000 });
    store.setState(unknown.id, 'unknown', null, 'Lost delivery receipt');
    store.claimInbound('telegram', 'bot', 'update-without-task');
    const state = store.closeAdmission(randomUUID());
    expect(state).toMatchObject({ queued: 0, running: 1, unknown: 1, inbound_unbound: 1 });
    expect(store.get(running.id)?.state).toBe('running');
    expect(store.get(unknown.id)?.state).toBe('unknown');
    store.close();
  });
});
