import { describe, expect, it } from 'vitest';
import { assertJobOwnership, composeOwnershipChecks } from '../src/job-ownership.js';
import type { JobDefinition } from '../src/job-engine.js';

const now = new Date('2026-09-27T12:00:00.000Z');
const job: JobDefinition = {
  id: 'daily-news', owner: 'ardent', enabled: true, handler: 'news.collect',
  schedule: { cron: '0 5 * * *', timezone: 'UTC', missed_window: 'skip', catch_up_minutes: 0 },
  input: {}, delivery: { kind: 'none' }, policy: { max_attempts: 2, retry_backoff_seconds: 60 }
};

describe('job ownership', () => {
  it('admits only enabled jobs explicitly assigned to Ardent', async () => {
    await expect(assertJobOwnership(job)).resolves.toBeUndefined();
    await expect(assertJobOwnership({ ...job, enabled: false })).rejects.toThrow('not assigned to Ardent');
    await expect(assertJobOwnership({ ...job, owner: 'external' })).rejects.toThrow('not assigned to Ardent');
  });

  it('requires every extra plugin check to pass after the default policy', async () => {
    const seen: string[] = [];
    const allow = composeOwnershipChecks([async item => { seen.push(item.id); }]);
    await expect(allow(job, now)).resolves.toBeUndefined();
    expect(seen).toEqual(['daily-news']);
    const deny = composeOwnershipChecks([async () => { throw new Error('Migration fence is still closed'); }]);
    await expect(deny(job, now)).rejects.toThrow('Migration fence is still closed');
    // The default policy runs first, so an external job never reaches plugin checks.
    await expect(allow({ ...job, owner: 'external' }, now)).rejects.toThrow('not assigned to Ardent');
    expect(seen).toEqual(['daily-news']);
  });
});
