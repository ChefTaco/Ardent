import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { A2APushInbox } from '../src/a2a-push-inbox.js';
import { loadPeers } from '../src/a2a-peers.js';
import { createArdentApi } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { inspectJournal } from '../src/journal.js';
import { MattermostAdapter } from '../src/mattermost.js';
import { renderMetrics } from '../src/metrics.js';
import { ArdentRuntime } from '../src/runtime.js';
import { TaskStore } from '../src/store.js';
import { initTestProfile } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function profile(edit?: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'ardent-idle-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await initTestProfile(dir);
  await edit?.(dir);
  const loaded = await loadConfig(dir);
  return { dir, loaded };
}
const journal = (dir: string) => join(dir, 'state', 'ardent.sqlite');
const table = async (dir: string, name: string) => (await inspectJournal(journal(dir))).tables.find(entry => entry.name === name);

describe('journal idle rules', () => {
  it('counts a bound outbound A2A call as finished and a pending one as active', async () => {
    const { dir, loaded } = await profile();
    const runtime = new ArdentRuntime(dir, loaded.config, {});
    const inbox = new A2APushInbox(runtime.store.db, [{ id: 'coordinator', url: 'https://coordinator.example.com', token_env: 'X', enabled: true, transport_ports: [], callback_ports: [], allow_private_callbacks: false }], 'https://agent.example.com:9900');
    const sent = inbox.register('coordinator', 'message-1');
    inbox.register('coordinator', 'message-2');
    inbox.bind(sent.id, 'remote-task-1');
    runtime.close();
    // A push-enabled profile whose calls were accepted is not left busy forever.
    expect(await table(dir, 'a2a_outbound_calls')).toMatchObject({ active: 1, unknown: 0, unsupported: 0 });
  });

  it('counts a ready recovery plan as active only while its task runs', async () => {
    const { dir, loaded } = await profile();
    const runtime = new ArdentRuntime(dir, loaded.config, {});
    const running = runtime.accept('Running', 'management');
    const settled = runtime.accept('Settled', 'management');
    runtime.store.db.prepare("UPDATE tasks SET state='running' WHERE id=?").run(running.id);
    runtime.store.setState(settled.id, 'failed', null, 'fixture');
    for (const id of [running.id, settled.id]) runtime.store.db.prepare("INSERT INTO task_recovery(task_id,status,reason_json,attempt,updated_ms) VALUES (?,'ready','{}',1,1)").run(id);
    runtime.close();
    expect(await table(dir, 'task_recovery')).toMatchObject({ active: 1, unknown: 0, unsupported: 0 });
  });

  it('seeds a Mattermost channel\'s history as unanswered, not admitted, and migrates rows seeded before', async () => {
    const posts = { old: { id: 'old', user_id: 'operator', channel_id: 'dm', message: 'Earlier', create_at: Date.now() - 60_000 } };
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/v4/users/me') response.end(JSON.stringify({ id: 'bot', username: 'coordinator', is_bot: true }));
      else if (request.url === '/api/v4/users/me/channels') response.end(JSON.stringify([{ id: 'dm', type: 'D' }]));
      else if (request.url?.startsWith('/api/v4/channels/dm/posts')) response.end(JSON.stringify({ order: ['old'], posts }));
      else response.writeHead(404).end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const { dir, loaded } = await profile();
    loaded.config.channels.mattermost.base_url = `http://127.0.0.1:${address.port}`;
    loaded.config.channels.mattermost.allowed_user_ids = ['operator'];
    const runtime = new ArdentRuntime(dir, loaded.config, { MATTERMOST_TOKEN: 'fixture-token' });
    const adapter = new MattermostAdapter(runtime, loaded.config.channels.mattermost, { MATTERMOST_TOKEN: 'fixture-token' });
    await adapter.initialize();
    // First sight: the history is claimed without an answer.
    expect(await adapter.reconcile(true)).toBe(0);
    expect(runtime.store.hasInbound('mattermost', 'bot', 'old')).toBe(true);
    // A row seeded by an earlier release (admitted, no type, no task, no delivery).
    runtime.store.db.prepare("INSERT INTO channel_inbound(platform,account,update_id,task_id,created_ms,channel_type,disposition) VALUES ('mattermost','bot','legacy',NULL,1,'unknown','admitted')").run();
    runtime.close();
    expect(await table(dir, 'channel_inbound')).toMatchObject({ active: 0, unsupported: 0 });
    const reopened = new TaskStore(journal(dir));
    try {
      expect(reopened.db.prepare("SELECT disposition FROM channel_inbound WHERE update_id='legacy'").get()).toEqual({ disposition: 'skipped_stale' });
      expect(reopened.closeAdmission('33333333-3333-4333-8333-333333333333').inbound_unbound).toBe(0);
    } finally { reopened.close(); }
  });

  it('clears a recorded job tick failure', async () => {
    const { dir, loaded } = await profile();
    const runtime = new ArdentRuntime(dir, loaded.config, {});
    cleanup.push(() => runtime.close());
    runtime.store.setCursor('jobs:last_error', 'Tick failed');
    expect(runtime.store.jobTickError()).toMatchObject({ message: 'Tick failed' });
    runtime.store.clearJobTickError();
    expect(runtime.store.jobTickError()).toBeNull();
  });
});

describe('credential reload and the service environment', () => {
  it('refuses to rotate a management token the service environment set, and leaves such peer tokens alone', async () => {
    const { dir, loaded } = await profile(async dir => {
      await writeFile(join(dir, 'peers.yaml'), 'schema_version: 1\npeers:\n  - id: coordinator\n    url: https://coordinator.example.com\n    inbound_token_env: COORDINATOR_IN\n    outbound_token_env: COORDINATOR_OUT\n');
    });
    const env: NodeJS.ProcessEnv = { ARDENT_API_TOKEN: 'fixture-service-token-0001', COORDINATOR_IN: 'fixture-inbound-service-1', COORDINATOR_OUT: 'fixture-outbound-file-1' };
    const runtime = new ArdentRuntime(dir, loaded.config, env);
    cleanup.push(() => runtime.close());
    const peers = await loadPeers(dir, loaded.config, env);
    const app = createArdentApi(runtime, loaded, env, undefined, { peerAuthenticator: () => peers.authenticator, serviceEnv: new Set(['ARDENT_API_TOKEN', 'COORDINATOR_IN']) });
    await writeFile(join(dir, '.env'), 'ARDENT_API_TOKEN=fixture-file-token-00002\nCOORDINATOR_IN=fixture-inbound-file-2\nCOORDINATOR_OUT=fixture-outbound-file-2\n', { mode: 0o600 });
    const post = (path: string) => app.request(path, { method: 'POST', headers: { Authorization: 'Bearer fixture-service-token-0001' } });
    expect((await post('/api/v1/credentials/management/reload')).status).toBe(409);
    expect(env.ARDENT_API_TOKEN).toBe('fixture-service-token-0001');
    const reloaded = await post('/api/v1/credentials/peers/reload');
    expect(await reloaded.json()).toMatchObject({ service_environment: ['COORDINATOR_IN'], changed: [] });
    expect(env.COORDINATOR_IN).toBe('fixture-inbound-service-1');
    expect(env.COORDINATOR_OUT).toBe('fixture-outbound-file-2');
  });

  it('labels Mattermost catch-up metrics with the bot account', async () => {
    const { dir, loaded } = await profile();
    const runtime = new ArdentRuntime(dir, loaded.config, {});
    cleanup.push(() => runtime.close());
    for (const account of ['bot-a', 'bot-b']) runtime.store.setCursor(`mattermost:${account}:town:last_ms`, String(Date.now() - 1000));
    const text = renderMetrics({ version: 'x', profile: 'p', backend: 'llamacpp', store: runtime.store, counters: runtime.counters, startedMs: 0 });
    expect(text).toContain('ardent_mattermost_catchup_gaps{account="bot-a",channel="town"} 0');
    expect(text).toContain('ardent_mattermost_catchup_gaps{account="bot-b",channel="town"} 0');
  });
});
