#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'dist/cli.js');
const home = await mkdtemp(join(tmpdir(), 'ardent-chat-'));
const profile = join(home, 'profiles/assistant');
let modelCalls = 0;
const model = createServer((request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end('{}'); return; }
  modelCalls++;
  response.setHeader('Content-Type', 'text/event-stream');
  if (modelCalls === 1) {
    response.write('data: {"choices":[{"delta":{"content":"CHAT_"}}]}\n\n');
    setTimeout(() => {
      if (!response.destroyed) response.end('data: {"choices":[{"delta":{"content":"STREAM_OK"}}]}\n\ndata: [DONE]\n\n');
    }, 500);
  }
  else setTimeout(() => { if (!response.destroyed) response.end('data: {"choices":[{"delta":{"content":"TOO_LATE"}}]}\n\ndata: [DONE]\n\n'); }, 3000);
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const env = { ...process.env, ARDENT_HOME: home };
const command = async (...args) => (await exec(process.execPath, [cli, ...args, '--profile-path', profile], { cwd: root, env, timeout: 15_000 })).stdout;
let chat;
try {
  await command('init', '--profile', 'assistant', '--non-interactive');
  const path = join(profile, 'config.yaml');
  const doc = YAML.parseDocument(await readFile(path, 'utf8'));
  const address = model.address();
  assert(address && typeof address !== 'string');
  doc.setIn(['providers', 'llamacpp', 'base_url'], `http://127.0.0.1:${address.port}/v1`);
  doc.setIn(['providers', 'llamacpp', 'model'], 'fixture');
  doc.setIn(['a2a', 'enabled'], false);
  await writeFile(path, String(doc));
  chat = spawn(process.execPath, [cli, 'chat', '--profile-path', profile], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  chat.stdout.on('data', chunk => { out += String(chunk); });
  chat.stderr.on('data', chunk => { err += String(chunk); });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (chat.exitCode !== null) throw new Error(`Chat exited while waiting for ${label}: ${err}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Chat did not produce ${label}: ${out}\n${err}`);
  };
  await until(() => out.includes('assistant> '), 'first prompt');
  await assert.rejects(command('tasks', 'list'), error => /Profile is owned/.test(String(error?.stderr ?? error)), 'A second owner opened the active profile');
  chat.stdin.write('Say the chat marker\n');
  await until(() => out.includes('CHAT_') && !out.includes('CHAT_STREAM_OK'), 'early streamed model token');
  await until(() => out.includes('CHAT_STREAM_OK') && out.split('assistant> ').length >= 3, 'reply and second prompt');
  assert.equal(out.split('CHAT_STREAM_OK').length - 1, 1, 'Final answer was repeated after streaming');
  chat.stdin.write('CANCEL_HOLD\n');
  await until(() => modelCalls >= 2 && out.includes('Thinking...'), 'active model progress');
  chat.kill('SIGINT');
  await until(() => out.includes('Cancelling task') && out.split('assistant> ').length >= 4, 'cancellation and next prompt');
  assert(!out.includes('TOO_LATE'), 'Canceled model text reached the conversation');
  chat.stdin.write('/exit\n');
  await Promise.race([once(chat, 'exit'), new Promise((_, reject) => setTimeout(() => reject(new Error('Chat did not exit')), 5000))]);
  assert.equal(chat.exitCode, 0, err);
  assert.equal(modelCalls, 2);
  assert.deepEqual(JSON.parse(await command('tasks', 'list')).length, 2, 'Profile lock was not released after chat exit');
  process.stdout.write(JSON.stringify({ persistentChat: true, answerStreamed: true, progressStreamed: true, ctrlCCancelled: true, noLateReply: true, singleOwner: true }) + '\n');
} finally {
  if (chat?.exitCode === null) chat.kill('SIGKILL');
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  await rm(home, { recursive: true, force: true });
}
