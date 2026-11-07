#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';

const exec = promisify(execFile);
const packageDir = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'ardent-schedule-'));
const profile = join(scratch, 'assistant');
const cli = join(packageDir, 'dist/cli.js');
const sourceUrl = 'https://93.184.216.34/scheduled-update';
const sourceId = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16);
let modelCalls = 0;
const server = createServer(async (request, response) => {
  if (request.url?.startsWith('/search')) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ results: [{ url: sourceUrl, title: 'Scheduled source', content: 'Dated scheduled observation', engines: ['fixture'] }], unresponsive_engines: [] }));
    return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end('{}'); return; }
  for await (const _chunk of request) { /* Consume the request. */ }
  modelCalls++;
  const delta = modelCalls % 2 === 1
    ? { choices: [{ delta: { tool_calls: [{ index: 0, id: `search-${modelCalls}`, type: 'function', function: { name: 'news_search', arguments: '{"query":"scheduled update"}' } }] } }] }
    : { choices: [{ delta: { content: JSON.stringify({ question: 'Scheduled update', scope: 'assistant-watch', as_of: new Date().toISOString(), findings: ['A dated source was found'], claims: [{ text: 'A scheduled observation was reported', source_ids: [sourceId], qualification: 'one snippet' }], contrary_evidence: [], coverage_gaps: ['Original article not extracted'], artifact_ids: [], answer_markdown: `Scheduled report cites ${sourceId}.` }) } }] };
  response.setHeader('Content-Type', 'text/event-stream');
  response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
async function run(...args) {
  const result = await exec(process.execPath, [cli, ...args, '--profile-path', profile], { cwd: packageDir, timeout: 30_000, env: { ...process.env, ARDENT_HOME: scratch, TZ: 'UTC' } });
  return JSON.parse(result.stdout);
}
try {
  await run('init', '--profile', 'assistant', '--non-interactive');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const doc = YAML.parseDocument(await readFile(join(profile, 'config.yaml'), 'utf8'));
  doc.setIn(['providers', 'llamacpp', 'base_url'], endpoint);
  doc.setIn(['providers', 'llamacpp', 'model'], 'fixture');
  doc.setIn(['research', 'searxng_url'], endpoint);
  await writeFile(join(profile, 'config.yaml'), String(doc), { mode: 0o600 });
  const fakeClock = { now: Date.parse('2026-09-26T06:00:00Z') };
  const invoke = () => run('report', '--schedule-id', 'assistant-watch', '--window-key', new Date(fakeClock.now).toISOString().slice(0, 10), '--prompt', 'Prepare the scheduled Assistant update', '--non-interactive', '--json');
  const first = await invoke();
  const retry = await invoke();
  assert.equal(first.task.id, retry.task.id);
  assert.equal(first.task.context, 'scheduled');
  assert.equal(first.task.state, 'completed');
  assert(first.answer.includes(sourceId));
  assert.equal(modelCalls, 2, 'Retry repeated the scheduled research workflow');
  fakeClock.now += 86_400_000;
  const nextWindow = await invoke();
  assert.notEqual(first.task.id, nextWindow.task.id);
  assert.equal(modelCalls, 4);
  assert.equal(await readdir(join(profile, 'cron')).then(() => true).catch(() => false), false, 'Ardent created a duplicate scheduler');
  process.stdout.write(JSON.stringify({ oneShotReport: true, sameWindowDeduplicated: true, nextWindowDistinct: true, modelCalls }) + '\n');
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(scratch, { recursive: true, force: true });
}
