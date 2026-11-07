import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServerCredentials } from '@grpc/grpc-js';
import { loadConfig } from '../../src/config.js';
import { initTestProfile } from '../helpers.js';
import { ArdentRuntime } from '../../src/runtime.js';
import { createA2ASurface } from '../../src/a2a-server.js';
import { ArdentA2AClient } from '../../src/a2a-client.js';
import { TeamChildService } from '../../src/team-child.js';

const exec = promisify(execFile);
const dirs: string[] = [];
const servers: Server[] = [];
async function availableA2APortPair(): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const http = createServer();
    const grpc = createServer();
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing A2A address');
    let adjacentAvailable = false;
    if (address.port < 65535) {
      adjacentAvailable = await new Promise<boolean>(resolve => {
        grpc.once('error', () => resolve(false));
        grpc.listen(address.port + 1, '127.0.0.1', () => resolve(true));
      });
    }
    if (grpc.listening) await new Promise<void>(resolve => grpc.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    if (adjacentAvailable) return address.port;
  }
  throw new Error('No free adjacent HTTP and gRPC ports for A2A fixture');
}
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('Assistant child claim against accepted Hermes root coordination', () => {
  it('claims the exact read-only budget and settles a retained native receipt without replay', async () => {
    const python = process.env.ARDENT_A2A_PYTHON;
    const hermes = process.env.ARDENT_HERMES_SOURCE;
    if (!python || !hermes) throw new Error('Pinned Hermes test dependencies are required; run ardent:interop');
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing Hermes root fixture port');
    const port = address.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const home = await mkdtemp(join(tmpdir(), 'ardent-hermes-root-'));
    const dir = await mkdtemp(join(tmpdir(), 'ardent-hermes-child-'));
    dirs.push(home, dir);
    const teamTests = join(import.meta.dirname, '../../../../services/control-api/hermes/plugins/hermes-team/tests');
    const fixture = spawn(python, [join(import.meta.dirname, '../fixtures/hermes-team-root-server.py'), String(port), home],
      { env: { ...process.env, PYTHONPATH: `${hermes}:${teamTests}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    fixture.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Hermes root did not start: ${stderr}`)), 10000);
        fixture.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (chunk.includes('READY')) { clearTimeout(timeout); resolve(); } });
        fixture.once('exit', code => { clearTimeout(timeout); reject(new Error(`Hermes root exited ${code}: ${stderr}`)); });
      });
      await initTestProfile(dir);
      await writeFile(join(dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: coordinator\n    url: http://127.0.0.1:${port}\n    token_env: COORDINATOR_TOKEN\n  - id: peerb\n    url: http://127.0.0.1:${port}\n    token_env: PEERB_TOKEN\n`);
      const config = (await loadConfig(dir)).config;
      const env = { COORDINATOR_TOKEN: 'coordinator-root-token-1234567890', PEERB_TOKEN: 'peerb-child-token-1234567890' };
      const runtime = new ArdentRuntime(dir, config, env);
      try {
        const grant = await (await fetch(`http://127.0.0.1:${port}/fixture/grant`)).json() as {
          version: '1.0'; root: string; child_id: string; sha256: string; envelope: Parameters<TeamChildService['claim']>[1]; context: string; depth: number;
        };
        const ref = { version: grant.version, root: grant.root, child_id: grant.child_id, sha256: grant.sha256 };
        const child = new TeamChildService(runtime, env);
        const native = randomUUID();
        expect(await child.claim(ref, grant.envelope, native, grant.context, 'peerb', 'same-request')).toEqual(ref);
        await expect(child.claim(ref, grant.envelope, native, grant.context, 'peerb', 'changed-request')).rejects.toThrow(/different work/);
        child.attach(ref, 'native-operation');
        await child.settle(ref, 'failed', 'Fixture producer returned no usable source');
        await child.flush();
        const status = await (await fetch(`http://127.0.0.1:${port}/fixture/status`)).json() as { state: string; native_id: string; status: string; result_registration: { budget_id: string; depth: number } };
        expect(status).toMatchObject({ state: 'settled', native_id: native, status: 'failed' });
        expect(status.result_registration.budget_id).toBeTruthy();
        expect(status.result_registration.depth).toBe(grant.depth);
        let modelCalls = 0;
        const model = createServer((_request, response) => {
          modelCalls++;
          response.setHeader('Content-Type', 'text/event-stream');
          response.end('data: {"choices":[{"delta":{"content":"No publisher source was available in this fixture."}}]}\n\ndata: [DONE]\n\n');
        });
        servers.push(model);
        await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
        const modelAddress = model.address();
        if (!modelAddress || typeof modelAddress === 'string') throw new Error('Missing child model fixture');
        const a2aPort = await availableA2APortPair();
        config.providers.llamacpp.base_url = `http://127.0.0.1:${modelAddress.port}/v1`;
        config.providers.llamacpp.model = 'fixture';
        config.a2a.public_url = `http://127.0.0.1:${a2aPort}`;
        config.a2a.listen_port = a2aPort;
        config.a2a.bindings = ['jsonrpc'];
        const surface = await createA2ASurface(runtime, config, env);
        const listener = surface.app.listen(a2aPort, '127.0.0.1');
        await new Promise<void>(resolve => listener.once('listening', resolve));
        try {
          const second = await (await fetch(`http://127.0.0.1:${port}/fixture/grant/second`)).json() as typeof grant;
          const secondRef = { version: second.version, root: second.root, child_id: second.child_id, sha256: second.sha256 };
          const response = await fetch(`http://127.0.0.1:${a2aPort}/a2a/jsonrpc`, { method: 'POST',
            headers: { Authorization: `Bearer ${env.PEERB_TOKEN}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'child-send', method: 'SendMessage', params: { message: {
              messageId: second.child_id, contextId: second.context, role: 'ROLE_USER', parts: [{ text: second.envelope.objective }],
              metadata: { hermesTeamTask: second.envelope, hermesTeamChild: secondRef, hermesTeamClarification: '1.0' }
            }, configuration: { blocking: true } } }) });
          expect(response.status).toBe(200);
          const sent = await response.json() as { result?: { task?: { status?: { state?: string } } }; error?: { message?: string } };
          expect(sent.error, JSON.stringify(sent)).toBeUndefined();
          expect(sent.result?.task?.status?.state, JSON.stringify(sent)).toBe('TASK_STATE_COMPLETED');
          const secondStatus = await (await fetch(`http://127.0.0.1:${port}/fixture/status?child=second`)).json() as { state: string; native_id: string; status: string };
          expect(secondStatus).toMatchObject({ state: 'settled', status: 'partial' });
          expect(secondStatus.native_id).toBeTruthy();
          const third = await (await fetch(`http://127.0.0.1:${port}/fixture/grant/third`)).json() as typeof grant;
          const beforeForgery = modelCalls;
          const forged = await fetch(`http://127.0.0.1:${a2aPort}/a2a/jsonrpc`, { method: 'POST',
            headers: { Authorization: `Bearer ${env.PEERB_TOKEN}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'forged-child', method: 'SendMessage', params: { message: {
              messageId: third.child_id, contextId: third.context, role: 'ROLE_USER', parts: [{ text: third.envelope.objective }],
              metadata: { hermesTeamTask: third.envelope,
                hermesTeamChild: { version: third.version, root: third.root, child_id: third.child_id, sha256: '0'.repeat(64) } }
            }, configuration: { blocking: true } } }) });
          const rejected = await forged.json() as { result?: { task?: { status?: { state?: string } } } };
          expect(rejected.result?.task?.status?.state).toBe('TASK_STATE_FAILED');
          expect(modelCalls).toBe(beforeForgery);
          const thirdStatus = await (await fetch(`http://127.0.0.1:${port}/fixture/status?child=third`)).json() as { state: string };
          expect(thirdStatus.state).toBe('reserved');
        } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
      } finally { runtime.close(); }
    } finally {
      fixture.kill('SIGTERM');
      await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else fixture.once('exit', () => resolve()); });
    }
  }, 30000);
});

describe('independent Python A2A 1.0 client against Ardent server', () => {
  it('sends, streams, subscribes, cancels, pages tasks, and retrieves extended cards over all v1 bindings', async () => {
    const python = process.env.ARDENT_A2A_PYTHON;
    const legacyPython = process.env.ARDENT_A2A_PYTHON_V03;
    const hermes = process.env.ARDENT_HERMES_SOURCE;
    if (!python) throw new Error('ARDENT_A2A_PYTHON is required; run npm run ardent:interop to install the pinned reference SDK');
    if (!legacyPython) throw new Error('ARDENT_A2A_PYTHON_V03 is required for the independent v0.3 compatibility probe');
    if (!hermes) throw new Error('ARDENT_HERMES_SOURCE is required for pinned Hermes client interoperability');
    const goldenUrl = 'https://93.184.216.34/golden-news';
    const goldenSource = createHash('sha256').update(goldenUrl).digest('hex').slice(0, 16);
    let goldenCalls = 0;
    let goldenSearches = 0;
    let goldenExtractions = 0;
    const model = createServer((request, response) => {
      if (request.url?.startsWith('/search')) {
        goldenSearches++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ results: [{ url: goldenUrl, title: 'Dated publisher update', content: 'The publisher reported a dated fixture update.', publishedDate: '2026-09-26T00:00:00Z', engines: ['fixture'] }], unresponsive_engines: [] }));
        return;
      }
      if (request.url === '/v1/scrape') {
        goldenExtractions++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ success: true, data: { markdown: '# Dated publisher update\nThe publisher reported a dated fixture update.', metadata: { title: 'Dated publisher update', sourceURL: goldenUrl, publishedTime: '2026-09-26T00:00:00Z' } } }));
        return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body = (body + chunk).slice(0, 65536); });
      request.on('end', () => {
        const complete = () => {
          if (response.destroyed) return;
          response.setHeader('Content-Type', 'text/event-stream');
          if (body.includes('Golden news brief') || body.includes('Use today as the time window')) {
            goldenCalls++;
            const tool = goldenCalls === 1 ? 'news_search' : 'news_collect';
            const delta = goldenCalls % 2 === 1
              ? { choices: [{ delta: { tool_calls: [{ index: 0, id: `golden-tool-${goldenCalls}`, type: 'function', function: { name: tool, arguments: JSON.stringify({ query: 'dated publisher update', ...(tool === 'news_collect' ? { max_articles: 1 } : {}) }) } }] } }] }
              : { choices: [{ delta: { content: JSON.stringify({ question: 'Golden news brief', scope: 'today', as_of: new Date().toISOString(), findings: ['The publisher reported a dated fixture update.'], claims: [{ text: 'The publisher reported the fixture update', source_ids: [goldenSource], qualification: 'one original source' }], contrary_evidence: [], coverage_gaps: ['No second independent original source'], artifact_ids: [], answer_markdown: `The publisher reports the update [${goldenSource}].`, team_result: { version: '1.0', mission_id: 'mission-golden', mission_revision: 1, task_id: 'team-golden', outcome: goldenCalls === 2 ? 'input_required' : 'completed', summary: goldenCalls === 2 ? 'Need the requested time window' : 'The dated publisher update is attributed', checks: [{ criterion: 'Cite a retrieved source', status: goldenCalls === 2 ? 'unknown' : 'pass', evidence: goldenCalls === 2 ? [] : [`source:${goldenSource}`] }], artifacts: [], uncertain_effects: [], ...(goldenCalls === 2 ? { clarification: { missing_fact: 'Which time window?', choices: [{ id: 'today', label: 'Today' }], blocked_task: 'team-golden', intended_respondent: 'coordinator' } } : {}) } }) } }] };
            response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
          } else response.end('data: {"choices":[{"delta":{"content":"REFERENCE_OK"}}]}\n\ndata: [DONE]\n\n');
        };
        if (body.includes('CANCEL_HOLD')) setTimeout(complete, 3000);
        else if (body.includes('PUSH_HOLD')) setTimeout(complete, 500);
        else complete();
      });
    });
    servers.push(model);
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    const modelAddress = model.address();
    if (!modelAddress || typeof modelAddress === 'string') throw new Error('Missing model address');
    const port = await availableA2APortPair();
    const dir = await mkdtemp(join(tmpdir(), 'ardent-reference-'));
    dirs.push(dir);
    await initTestProfile(dir);
    await writeFile(join(dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: python-reference\n    url: http://127.0.0.1:${port}\n    token_env: REFERENCE_TOKEN\n    transport_ports: [${port + 1}]\n    callback_ports: [${port}]\n    allow_private_callbacks: true\n  - id: coordinator\n    url: http://127.0.0.1:${port}\n    token_env: COORDINATOR_TOKEN\n`);
    const config = (await loadConfig(dir)).config;
    config.providers.llamacpp.base_url = `http://127.0.0.1:${modelAddress.port}/`;
    config.providers.llamacpp.model = 'fixture';
    config.research.searxng_url = `http://127.0.0.1:${modelAddress.port}/`;
    config.research.firecrawl_url = `http://127.0.0.1:${modelAddress.port}/`;
    config.a2a.public_url = `http://127.0.0.1:${port}`;
    const token = 'reference-token-1234567890';
    const coordinatorToken = 'coordinator-token-1234567890';
    const runtime = new ArdentRuntime(dir, config, { REFERENCE_TOKEN: token, COORDINATOR_TOKEN: coordinatorToken });
    const surface = await createA2ASurface(runtime, config, { REFERENCE_TOKEN: token, COORDINATOR_TOKEN: coordinatorToken });
    const callbackBodies: string[] = [];
    surface.app.post('/reference-callback', (request, response) => {
      if (request.header('X-A2A-Notification-Token') !== 'notify-fixture') { response.status(401).end(); return; }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { body = (body + chunk).slice(0, 2 * 1024 * 1024); });
      request.on('end', () => { callbackBodies.push(body); response.status(202).end(); });
    });
    try {
      const http = surface.app.listen(port, '127.0.0.1');
      servers.push(http);
      await new Promise<void>(resolve => http.once('listening', resolve));
      await new Promise<number>((resolve, reject) => surface.grpcServer.bindAsync(`127.0.0.1:${port + 1}`, ServerCredentials.createInsecure(), (error, bound) => error ? reject(error) : resolve(bound)));
      for (const binding of ['jsonrpc', 'http-json', 'grpc']) {
        const { stdout } = await exec(python, [join(import.meta.dirname, '../fixtures/a2a-python-client.py'), `http://127.0.0.1:${port}`, `127.0.0.1:${port + 1}`, binding, token], { timeout: 30000 });
        const result = JSON.parse(stdout) as { binding: string; task_id: string; state: number; extended_card: boolean; pagination: boolean; stream_states: number[]; reconnect_states: number[]; cancelled: boolean; subscription_states: number[]; multipart: boolean; unsupported_file_rejected: boolean; push_task_id: string; push_config_crud: boolean };
        expect(result.binding).toBe(binding);
        expect(result.task_id).toBeTruthy();
        expect(result.state).toBe(3);
        expect(result.extended_card).toBe(true);
        expect(result.pagination).toBe(true);
        expect(result.stream_states).toContain(3);
        expect(result.reconnect_states).toContain(3);
        expect(result.cancelled).toBe(true);
        expect(result.subscription_states).toContain(5);
        expect(result.multipart).toBe(true);
        expect(result.unsupported_file_rejected).toBe(true);
        expect(result.push_config_crud).toBe(true);
        await surface.pushSender.drain();
        expect(callbackBodies.some(body => body.includes(result.push_task_id))).toBe(true);
        if (binding === 'jsonrpc') {
          const alias = async (method: string, params: object) => {
            const response = await fetch(`http://127.0.0.1:${port}/a2a/jsonrpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'A2A-Version': '1.0', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
            expect(response.status).toBe(200);
            return await response.json() as { result?: { id?: string; deleted?: boolean; configs?: { id: string }[] }; error?: { message?: string } };
          };
          const created = await alias('tasks/pushNotificationConfig/set', { taskId: result.task_id, pushNotificationConfig: { url: `http://127.0.0.1:${port}/reference-callback`, token: 'notify-fixture' } });
          expect(created.error, JSON.stringify(created)).toBeUndefined();
          const configId = created.result?.id;
          expect(configId).toBeTruthy();
          const retrieved = await alias('tasks/pushNotificationConfig/get', { taskId: result.task_id, id: configId });
          expect(retrieved.result?.id).toBe(configId);
          const listed = await alias('tasks/pushNotificationConfig/list', { taskId: result.task_id });
          expect(listed.result?.configs?.some(item => item.id === configId)).toBe(true);
          const deleted = await alias('tasks/pushNotificationConfig/delete', { taskId: result.task_id, id: configId });
          expect(deleted.result?.deleted).toBe(true);
        }
        const preferred = binding === 'jsonrpc' ? 'JSONRPC' : binding === 'http-json' ? 'HTTP+JSON' : 'GRPC';
        const client = new ArdentA2AClient(dir, config, { REFERENCE_TOKEN: token, COORDINATOR_TOKEN: coordinatorToken }, undefined, [preferred]);
        expect((await client.getTask('python-reference', result.task_id)).id).toBe(result.task_id);
        expect((await client.listTasks('python-reference')).tasks.some(task => task.id === result.task_id)).toBe(true);
      }
      const legacy = await exec(legacyPython, [join(import.meta.dirname, '../fixtures/a2a-python-v03-client.py'), `http://127.0.0.1:${port}`, token], { timeout: 30000 });
      const legacyResult = JSON.parse(legacy.stdout) as { protocol: string; task_id: string; state: string };
      expect(legacyResult.protocol).toBe('0.3');
      expect(legacyResult.task_id).toBeTruthy();
      expect(legacyResult.state).toBe('completed');
      const hermesClient = await exec(python, [join(import.meta.dirname, '../fixtures/hermes-a2a-client.py'), `http://127.0.0.1:${port}`, token], { timeout: 30000, env: { ...process.env, PYTHONPATH: hermes, HERMES_HOME: join(dir, 'hermes-home') } });
      const hermesResult = JSON.parse(hermesClient.stdout) as { reply: string; context_id: string; state: string };
      expect(hermesResult.reply).toContain('REFERENCE_OK');
      expect(hermesResult.context_id).toBeTruthy();
      expect(hermesResult.state).toBe('TASK_STATE_COMPLETED');
      const teamContracts = join(import.meta.dirname, '../../../../services/control-api/hermes/plugins/hermes-team');
      const hermesTeam = await exec(python, [join(import.meta.dirname, '../fixtures/hermes-team-client.py'), `http://127.0.0.1:${port}`, coordinatorToken, teamContracts], { timeout: 30000, env: { ...process.env, PYTHONPATH: hermes, HERMES_HOME: join(dir, 'hermes-team-home') } });
      const teamResult = JSON.parse(hermesTeam.stdout) as { task_id: string; state: string; outcome: string };
      expect(teamResult.task_id).toBeTruthy();
      expect(teamResult.state).toBe('TASK_STATE_COMPLETED');
      expect(teamResult.outcome).toBe('partial');
      const lifecycleTeam = await exec(python, [join(import.meta.dirname, '../fixtures/hermes-team-client.py'), `http://127.0.0.1:${port}`, coordinatorToken, teamContracts, 'lifecycle'], { timeout: 30000, env: { ...process.env, PYTHONPATH: hermes, HERMES_HOME: join(dir, 'hermes-lifecycle-home') } });
      const lifecycle = JSON.parse(lifecycleTeam.stdout) as { lifecycle: boolean; active_cancel: boolean; outcome: string };
      expect(lifecycle).toMatchObject({ lifecycle: true, active_cancel: true, outcome: 'cancelled' });
      const goldenTeam = await exec(python, [join(import.meta.dirname, '../fixtures/hermes-team-client.py'), `http://127.0.0.1:${port}`, coordinatorToken, teamContracts, 'golden'], { timeout: 30000, env: { ...process.env, PYTHONPATH: hermes, HERMES_HOME: join(dir, 'hermes-golden-home') } });
      const golden = JSON.parse(goldenTeam.stdout) as { state: string; outcome: string; clarified: boolean; artifacts: number; attributed: boolean };
      expect(golden).toMatchObject({ state: 'TASK_STATE_COMPLETED', outcome: 'completed', clarified: true, attributed: true });
      expect(golden.artifacts).toBeGreaterThanOrEqual(2);
      expect(goldenCalls).toBe(4);
      expect(goldenSearches).toBeGreaterThanOrEqual(2);
      expect(goldenExtractions).toBeGreaterThanOrEqual(1);
    } finally {
      surface.grpcServer.forceShutdown();
      runtime.close();
    }
  }, 120000);
});

describe('Ardent client against independent Python A2A 1.0 server', () => {
  it('uses the selected JSON-RPC, HTTP+JSON, and gRPC bindings', async () => {
    const python = process.env.ARDENT_A2A_PYTHON;
    if (!python) throw new Error('ARDENT_A2A_PYTHON is required; run npm run ardent:interop');
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing reference address');
    const port = address.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const grpcPort = port + 1;
    const fixture = spawn(python, [join(import.meta.dirname, '../fixtures/a2a-python-server.py'), String(port), String(grpcPort)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    fixture.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Python A2A server did not start: ${stderr}`)), 10000);
        fixture.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (chunk.includes('READY')) { clearTimeout(timeout); resolve(); } });
        fixture.once('exit', code => { clearTimeout(timeout); reject(new Error(`Python A2A server exited ${code}: ${stderr}`)); });
      });
      const dir = await mkdtemp(join(tmpdir(), 'ardent-python-peer-'));
      dirs.push(dir);
      await initTestProfile(dir);
      await writeFile(join(dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: python-reference\n    url: http://127.0.0.1:${port}\n    token_env: REFERENCE_TOKEN\n    transport_ports: [${grpcPort}]\n`);
      const config = (await loadConfig(dir)).config;
      const env = { REFERENCE_TOKEN: 'reference-token-1234567890' };
      for (const binding of ['JSONRPC', 'HTTP+JSON', 'GRPC']) {
        const client = new ArdentA2AClient(dir, config, env, undefined, [binding]);
        const result = await client.send('python-reference', `Return answer using ${binding}`);
        expect('role' in result).toBe(true);
        if ('parts' in result) expect(result.parts[0]?.content).toEqual({ $case: 'text', value: 'PYTHON_REFERENCE_OK' });
      }
    } finally {
      fixture.kill('SIGTERM');
      await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else fixture.once('exit', () => resolve()); });
    }
  }, 120000);
});

describe('Ardent client against independent Python A2A 0.3 server', () => {
  it('selects the explicitly advertised v0.3 JSON-RPC codec', async () => {
    const python = process.env.ARDENT_A2A_PYTHON_V03;
    if (!python) throw new Error('ARDENT_A2A_PYTHON_V03 is required; run npm run ardent:interop');
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing v0.3 reference address');
    const port = address.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const fixture = spawn(python, [join(import.meta.dirname, '../fixtures/a2a-python-v03-server.py'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    fixture.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Python v0.3 server did not start: ${stderr}`)), 10000);
        fixture.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (chunk.includes('READY')) { clearTimeout(timeout); resolve(); } });
        fixture.once('exit', code => { clearTimeout(timeout); reject(new Error(`Python v0.3 server exited ${code}: ${stderr}`)); });
      });
      const dir = await mkdtemp(join(tmpdir(), 'ardent-python-v03-peer-'));
      dirs.push(dir);
      await initTestProfile(dir);
      await writeFile(join(dir, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: python-v03\n    url: http://127.0.0.1:${port}\n    token_env: REFERENCE_TOKEN\n`);
      const config = (await loadConfig(dir)).config;
      const client = new ArdentA2AClient(dir, config, { REFERENCE_TOKEN: 'reference-token-1234567890' });
      const { card } = await client.open('python-v03');
      expect(card.supportedInterfaces.some(iface => iface.protocolVersion.startsWith('0.3'))).toBe(true);
      const result = await client.send('python-v03', 'Use the legacy reference server');
      expect('role' in result).toBe(true);
      if ('parts' in result) expect(result.parts[0]?.content).toEqual({ $case: 'text', value: 'PYTHON_V03_OK' });
    } finally {
      fixture.kill('SIGTERM');
      await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else fixture.once('exit', () => resolve()); });
    }
  }, 120000);
});

describe('Ardent client against pinned Hermes A2A source', () => {
  it('discovers and calls the actual Hermes adapter with a deterministic reply handler', async () => {
    const python = process.env.ARDENT_A2A_PYTHON;
    const hermes = process.env.ARDENT_HERMES_SOURCE;
    if (!python || !hermes) throw new Error('Pinned Hermes fixture dependencies are required; run npm run ardent:interop');
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing Hermes fixture address');
    const port = address.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const dir = await mkdtemp(join(tmpdir(), 'ardent-hermes-peer-'));
    dirs.push(dir);
    const fixture = spawn(python, [join(import.meta.dirname, '../fixtures/hermes-a2a-server.py'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: hermes, HERMES_HOME: join(dir, 'hermes-home') } });
    let stderr = '';
    fixture.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Pinned Hermes adapter did not start: ${stderr}`)), 10000);
        fixture.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (chunk.includes('READY')) { clearTimeout(timeout); resolve(); } });
        fixture.once('exit', code => { clearTimeout(timeout); reject(new Error(`Pinned Hermes adapter exited ${code}: ${stderr}`)); });
      });
      const profile = join(dir, 'ardent-profile');
      await initTestProfile(profile);
      await writeFile(join(profile, 'peers.yaml'), `schema_version: 1\npeers:\n  - id: hermes\n    url: http://127.0.0.1:${port}\n    token_env: HERMES_FIXTURE_TOKEN\n`);
      const config = (await loadConfig(profile)).config;
      const client = new ArdentA2AClient(profile, config, { HERMES_FIXTURE_TOKEN: 'hermes-fixture-token-1234567890' });
      const { card } = await client.open('hermes');
      expect(card.supportedInterfaces.some(iface => iface.protocolBinding === 'JSONRPC')).toBe(true);
      const result = await client.send('hermes', 'Return a pinned Hermes fixture answer');
      expect('id' in result).toBe(true);
      if ('id' in result) expect(JSON.stringify(result)).toContain('HERMES_PINNED_OK');
    } finally {
      fixture.kill('SIGTERM');
      await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else fixture.once('exit', () => resolve()); });
    }
  }, 120000);
});
