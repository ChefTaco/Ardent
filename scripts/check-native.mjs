#!/usr/bin/env node
// Regression: startup-only CA references must reach the actual gateway process.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as tlsServer } from 'node:https';
import { createServer as tcpServer } from 'node:net';
import YAML from 'yaml';
const execute = promisify(execFile), root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'ardent-native-startup-'));
const profile = join(scratch, 'profile'), cli = join(root, 'dist/cli.js'), native = join(root, 'dist/native-entry.js');
const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
const run = async (file, args) => (await execute(process.execPath, [file, ...args], { env, timeout: 15_000 })).stdout.trim();
let provider, gateway;
try {
  const listener = tcpServer().listen(0, '127.0.0.1');
  await new Promise(done => listener.once('listening', done));
  const port = listener.address().port;
  await new Promise(done => listener.close(done));
  await run(cli, ['--profile-path', profile, 'init', '--non-interactive', '--api-port', String(port)]);
  const retained = await readFile(join(profile, '.env'));
  const cert = join(scratch, 'fixture.pem'), key = join(scratch, 'fixture.key');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-days', '1']);
  await chmod(key, 0o600);
  provider = tlsServer({ cert: await readFile(cert), key: await readFile(key) }, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer synthetic-provider-key') res.end(JSON.stringify({ data: [{ id: 'synthetic-model' }] }));
    else res.writeHead(401).end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise(done => provider.once('listening', done));
  const document = YAML.parseDocument(await readFile(join(profile, 'config.yaml'), 'utf8'));
  document.setIn(['providers', 'llamacpp', 'base_url'], 'https://localhost:' + provider.address().port);
  document.setIn(['providers', 'llamacpp', 'model'], 'synthetic-model');
  await writeFile(join(profile, 'config.yaml'), String(document), { mode: 0o600 });
  const envFile = join(scratch, 'native.env');
  await writeFile(envFile, `NODE_EXTRA_CA_CERTS=${cert}\nARDENT_API_TOKEN=synthetic-management-token\nARDENT_LLAMA_API_KEY=synthetic-provider-key\n`, { mode: 0o600 });
  const args = ['--env-file', envFile, '--profile-path', profile];
  gateway = spawn(process.execPath, [native, ...args, 'gateway', 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Drain diagnostics without publishing private paths or credential material.
  gateway.stdout.resume(); gateway.stderr.resume();
  let accepted = false;
  for (let index = 0; index < 40; index++) {
    try { accepted = JSON.parse(await run(native, [...args, 'acceptance'])).ok === true; } catch {}
    if (accepted) break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert(accepted, 'The gateway must verify the private provider CA loaded before startup');
  const wrong = join(scratch, 'wrong.env');
  await writeFile(wrong, 'ARDENT_API_TOKEN=synthetic-wrong-token\n', { mode: 0o600 });
  await assert.rejects(run(native, ['--env-file', wrong, '--profile-path', profile, 'acceptance']));
  await chmod(envFile, 0o644);
  await assert.rejects(run(native, [...args, 'acceptance']));
  await chmod(envFile, 0o600);
  assert.deepEqual(await readFile(join(profile, '.env')), retained);
  const stopped = new Promise(done => gateway.once('close', done));
  gateway.kill('SIGTERM');
  await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(Error('Native gateway did not stop')), 10_000).unref())]);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(1000) }));
  console.log(JSON.stringify({ startupCaVerified: true, authenticatedAcceptance: true, privateFileRequired: true, profileCredentialRetained: true, gracefulChildShutdown: true }));
} finally {
  if (gateway && gateway.exitCode === null) gateway.kill('SIGTERM');
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)); }
  await rm(scratch, { recursive: true, force: true });
}
