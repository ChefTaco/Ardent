import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, chmod, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptRuntime, readProtectedFile } from '../src/acceptance.js';
import { parseConfig } from '../src/config.js';
import { readFile } from 'node:fs/promises';
import { ARDENT_VERSION } from '../src/version.js';

const template = await readFile(new URL('../profiles/assistant/config.yaml', import.meta.url), 'utf8');
const config = parseConfig(template);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }))); });
async function fixture(options: { version?: string; profile?: string; ready?: boolean; redirect?: boolean } = {}) {
  const observed: Array<{ path: string; authorization?: string }> = [];
  const server = createServer((request, response) => {
    observed.push({ path: request.url ?? '', ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
    response.setHeader('Content-Type', 'application/json');
    if (options.redirect) { response.writeHead(302, { Location: '/never-follow' }).end(); return; }
    if (request.url === '/api/v1/status') {
      if (request.headers.authorization !== 'Bearer synthetic-management-token') { response.writeHead(401).end('{}'); return; }
      response.end(JSON.stringify({ version: options.version ?? ARDENT_VERSION, profile: options.profile ?? config.profile, backend: config.execution.backend }));
    } else if (request.url === '/health/ready') response.end(JSON.stringify(options.ready === false ? { status: 'degraded', problems: ['synthetic private upstream diagnostic'] } : { status: 'ready', problems: [] }));
    else response.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener did not start');
  return { endpoint: `http://127.0.0.1:${address.port}`, observed };
}
describe('native runtime acceptance', () => {
  it('requires authenticated status, the selected version/profile and dependency readiness', async () => {
    const { endpoint, observed } = await fixture();
    const env = { ARDENT_API_TOKEN: 'synthetic-management-token', ARDENT_ACCEPTANCE_URL: endpoint };
    expect(await acceptRuntime(config, env)).toEqual({ ok: true, version: ARDENT_VERSION, profile: config.profile, backend: config.execution.backend });
    expect(observed).toEqual([{ path: '/api/v1/status', authorization: 'Bearer synthetic-management-token' }, { path: '/health/ready' }]);
    expect((await acceptRuntime(config, { ...env, ARDENT_API_TOKEN: 'wrong-fixture-token' })).ok).toBe(false);
  });
  it.each([{ version: '0.0.0' }, { profile: 'another-profile' }, { ready: false }, { redirect: true }])('fails closed without exposing responses: %j', async options => {
    const { endpoint, observed } = await fixture(options);
    const result = await acceptRuntime(config, { ARDENT_API_TOKEN: 'synthetic-management-token', ARDENT_ACCEPTANCE_URL: endpoint });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-management-token|private upstream diagnostic/);
    expect(observed.some(item => item.path === '/never-follow')).toBe(false);
  });
  it('refuses nonlocal cleartext and credential-bearing origins before sending a token', async () => {
    for (const endpoint of ['http://agent.example.com', 'https://user:fake@agent.example.com', 'https://agent.example.com/path', 'https://agent.example.com/?token=fake'])
      expect((await acceptRuntime(config, { ARDENT_API_TOKEN: 'synthetic-management-token', ARDENT_ACCEPTANCE_URL: endpoint })).ok).toBe(false);
  });
  it('reads only owned private regular credential/CA files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ardent-protected-file-'));
    try {
      const file = join(directory, 'protected-file');
      await writeFile(file, 'synthetic-reference=value\n', { mode: 0o600 });
      expect((await readProtectedFile(file)).toString()).toBe('synthetic-reference=value\n');
      await symlink(file, join(directory, 'link'));
      await expect(readProtectedFile(join(directory, 'link'))).rejects.toThrow(/owned private/);
      await chmod(file, 0o644);
      await expect(readProtectedFile(file)).rejects.toThrow(/owned private/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
