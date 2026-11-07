import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TaskState, type Task } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { SqliteA2ATaskStore } from '../src/a2a-store.js';
import { TaskStore } from '../src/store.js';

const dirs: string[] = [];
const stores: TaskStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it('filters, orders and pages A2A tasks in SQL with stable cursors and totals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-a2a-list-')); dirs.push(dir);
  const store = new TaskStore(join(dir, 'state', 'ardent.sqlite')); stores.push(store);
  const tasks = new SqliteA2ATaskStore(store.db);
  const caller = (name: string) => new ServerCallContext({ tenant: 'team', user: { isAuthenticated: true, userName: name } });
  const saved: Task[] = [];
  for (let index = 0; index < 7; index++) {
    const task: Task = { id: `task-${index}`, contextId: index % 2 ? 'odd' : 'even',
      status: { state: index % 3 ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_COMPLETED, message: undefined,
        // Two tasks share a timestamp so the id tie-break is exercised.
        timestamp: new Date(Date.UTC(2026, 9, 1, 0, Math.min(index, 5))).toISOString() }, artifacts: [], history: [], metadata: {} };
    await tasks.save(task, caller('coordinator'));
    saved.push(task);
  }
  await tasks.save({ ...saved[0]!, id: 'foreign' }, caller('other'));
  const expected = (filter: (task: Task) => boolean) => saved.filter(filter)
    .sort((a, b) => (b.status!.timestamp! > a.status!.timestamp! ? 1 : b.status!.timestamp! < a.status!.timestamp! ? -1 : b.id > a.id ? 1 : -1)).map(task => task.id);
  const pages = async (request: Parameters<SqliteA2ATaskStore['list']>[0]) => {
    const ids: string[] = []; let token = ''; let total = -1;
    do {
      const page = await tasks.list({ ...request, pageSize: 2, ...(token ? { pageToken: token } : {}) } as Parameters<SqliteA2ATaskStore['list']>[0], caller('coordinator'));
      ids.push(...page.tasks.map(task => task.id)); token = page.nextPageToken; total = page.totalSize;
      expect(page.tasks.length).toBeLessThanOrEqual(2);
    } while (token);
    return { ids, total };
  };
  const all = await pages({} as Parameters<SqliteA2ATaskStore['list']>[0]);
  expect(all).toEqual({ ids: expected(() => true), total: 7 });
  const odd = await pages({ contextId: 'odd' } as Parameters<SqliteA2ATaskStore['list']>[0]);
  expect(odd).toEqual({ ids: expected(task => task.contextId === 'odd'), total: 3 });
  const completed = await pages({ status: TaskState.TASK_STATE_COMPLETED } as Parameters<SqliteA2ATaskStore['list']>[0]);
  expect(completed).toEqual({ ids: expected(task => task.status?.state === TaskState.TASK_STATE_COMPLETED), total: 3 });
  const after = saved[2]!.status!.timestamp!;
  const recent = await pages({ statusTimestampAfter: after } as Parameters<SqliteA2ATaskStore['list']>[0]);
  expect(recent).toEqual({ ids: expected(task => task.status!.timestamp! > after), total: 4 });
  await expect(tasks.list({ pageSize: 2, pageToken: Buffer.from(JSON.stringify({ timestamp: 'x', id: 'missing' })).toString('base64url') } as Parameters<SqliteA2ATaskStore['list']>[0], caller('coordinator')))
    .rejects.toThrow('cursor was not found');
});
