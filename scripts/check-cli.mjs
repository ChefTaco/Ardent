#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';

const exec = promisify(execFile);
const packageDir = resolve(import.meta.dirname, '..');
const cli = join(packageDir, 'dist/cli.js');
const scratch = await mkdtemp(join(tmpdir(), 'ardent-cli-acceptance-'));
const profile = join(scratch, 'profiles', 'assistant');
const url = 'https://93.184.216.34/official-update';
const sourceId = createHash('sha256').update(url).digest('hex').slice(0, 16);
let calls = 0;
let sawFollowupHistory = false;
const fixture = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url?.startsWith('/search')) {
    response.end(JSON.stringify({ results: [{ url, title: 'Official update', content: 'The dated original update reports the fixture finding.', publishedDate: '2026-09-26T00:00:00Z', engines: ['fixture'] }], unresponsive_engines: [] }));
    return;
  }
  if (request.url === '/v1/scrape') {
    response.end(JSON.stringify({ success: true, data: { markdown: '# Official update\nThe dated original update reports the fixture finding.', metadata: { title: 'Official update', sourceURL: url, publishedTime: '2026-09-26T00:00:00Z' } } }));
    return;
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end('{}'); return; }
  let body = '';
  for await (const chunk of request) body = (body + chunk.toString()).slice(0, 256_000);
  const parsed = JSON.parse(body);
  calls++;
  let delta;
  if (calls === 1) {
    delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-collect', type: 'function', function: { name: 'news_collect', arguments: '{"query":"official fixture update","max_articles":1}' } }] } }] };
  } else if (calls === 2) {
    delta = { choices: [{ delta: { content: JSON.stringify({ question: 'What did the official update report?', scope: 'fixture', as_of: new Date().toISOString(), findings: ['The dated original update reports the fixture finding.'], claims: [{ text: 'The fixture finding was reported', source_ids: [sourceId], qualification: 'one extracted source' }], contrary_evidence: [], coverage_gaps: ['No independent corroboration in this fixture'], artifact_ids: [], answer_markdown: `The original update reports the fixture finding [${sourceId}].` }) } }] };
  } else {
    sawFollowupHistory = Array.isArray(parsed.messages) && parsed.messages.some(item => item.role === 'assistant' && String(item.content).includes('fixture finding'));
    delta = { choices: [{ delta: { content: `The same original source was ${sourceId}.` } }] };
  }
  response.setHeader('Content-Type', 'text/event-stream');
  response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`);
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');

const cliEnv = { ...process.env, ARDENT_HOME: scratch, TZ: 'UTC' };
async function command(...args) {
  const result = await exec(process.execPath, [cli, ...args, '--profile-path', profile], { cwd: packageDir, env: cliEnv, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
try {
  const address = fixture.address();
  assert(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const initialized = JSON.parse(await command('init', '--profile', 'assistant', '--non-interactive'));
  assert.equal(initialized.initialized, true);
  const soul = await readFile(join(profile, 'SOUL.md'), 'utf8');
  const identity = await readFile(join(profile, 'IDENTITY.md'), 'utf8');
  assert(soul.includes('# Soul') && identity.includes('# Identity'));
  const original = await readFile(join(profile, 'config.yaml'), 'utf8');
  assert(original.includes('# Ardent profile, schema 1'));
  assert.equal((await stat(join(profile, '.env'))).mode & 0o077, 0);
  const doc = YAML.parseDocument(original);
  doc.setIn(['providers', 'llamacpp', 'base_url'], endpoint);
  doc.setIn(['providers', 'llamacpp', 'model'], 'fixture-model');
  doc.setIn(['research', 'searxng_url'], endpoint);
  doc.setIn(['research', 'firecrawl_url'], endpoint);
  doc.setIn(['research', 'enabled'], true);
  await writeFile(join(profile, 'config.yaml'), String(doc), { mode: 0o600 });
  const valid = JSON.parse(await command('config', 'validate'));
  assert.equal(valid.valid, true);
  const session = JSON.parse(await command('sessions', 'new'));
  assert.match(session.id, /^[a-f0-9-]{36}$/);
  const first = JSON.parse(await command('run', '--prompt', 'What did the official update report?', '--session-id', session.id, '--json'));
  assert.equal(first.task.state, 'completed');
  assert(first.answer.includes(sourceId) && first.answer.includes(url));
  assert(first.brief.source_register.some(item => item.source_id === sourceId && item.evidence_kind === 'extracted_article'));
  const detail = JSON.parse(await command('tasks', 'show', first.task.id));
  const artifacts = detail.events.find(item => item.kind === 'research_artifacts')?.detail;
  assert(artifacts?.report?.id && artifacts?.markdown?.id);
  const report = JSON.parse(await readFile(join(profile, 'artifacts', artifacts.report.id), 'utf8'));
  assert(report.source_register.some(item => item.source_id === sourceId && item.url === url));
  assert.equal(artifacts.report.id, createHash('sha256').update(await readFile(join(profile, 'artifacts', artifacts.report.id))).digest('hex'));
  const followup = JSON.parse(await command('run', '--prompt', 'What source did we use?', '--session-id', session.id, '--json'));
  assert.equal(followup.task.state, 'completed');
  assert(followup.answer.includes(sourceId));
  assert(sawFollowupHistory);
  const invalid = String(doc).replace('schema_version: 1', 'schema_version: 2');
  await writeFile(join(profile, 'config.yaml'), invalid, { mode: 0o600 });
  await assert.rejects(command('config', 'validate'));
  assert((await readFile(join(profile, 'config.yaml'), 'utf8')).includes('schema_version: 2'));
  process.stdout.write(JSON.stringify({ cliProcess: true, profileComments: true, privateToken: true, invalidConfigRejected: true, researchSearchAndExtraction: true, exactArtifact: true, followupHistory: true, modelCalls: calls }) + '\n');
} finally {
  fixture.closeAllConnections();
  await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  await rm(scratch, { recursive: true, force: true });
}
