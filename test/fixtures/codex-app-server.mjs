#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write(`codex-cli ${process.env.ARDENT_FIXTURE_CODEX_VERSION || '0.157.1'}\n`);
  process.exit(0);
}

const rl = createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let dynamicTools = [];
let turnCount = 0;
let loginPending = false;
let selectedModel; let selectedEffort;
const selectedTool = process.env.ARDENT_FIXTURE_TOOL || 'fixture_search';
rl.on('line', line => {
  const message = JSON.parse(line);
  if (process.env.ARDENT_FIXTURE_RPC_FILE && message.method) appendFileSync(process.env.ARDENT_FIXTURE_RPC_FILE, message.method+'\n');
  if (process.env.ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE && message.method === 'thread/start') writeFileSync(process.env.ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE + '.thread', JSON.stringify(message.params));
  if (process.env.ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE && message.method === 'turn/start') writeFileSync(process.env.ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE + '.turn', JSON.stringify(message.params));
  if (message.method === 'initialize') {
    if (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_API_KEY) send({ id: message.id, error: { code: -1, message: 'API-key fallback leaked' } });
    else send({ id: message.id, result: { userAgent: 'fixture' } });
  }
  else if (message.method === 'account/read') {
    const mode = process.env.ARDENT_FIXTURE_AUTH_MODE || 'chatgpt';
    const account = mode === 'wrong' ? { type: 'apiKey' } : mode === 'none' && !(loginPending && process.env.ARDENT_FIXTURE_LOGIN_RESULT === 'complete') ? null : { type: 'chatgpt' };
    send({ id: message.id, result: { account, requiresOpenaiAuth: true } });
  }
  else if (message.method === 'account/login/start') {
    if (message.params.type !== 'chatgptDeviceCode') send({ id: message.id, error: { code: -32602, message: 'Unsupported login type' } });
    else { loginPending = true; send({ id: message.id, result: { type: 'chatgptDeviceCode', loginId: 'fixture-login-1', verificationUrl: 'https://example.test/device', userCode: 'TEST-CODE' } }); }
  }
  else if (message.method === 'account/login/cancel') {
    loginPending = false;
    send({ id: message.id, result: { cancelled: true } });
  }
  else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  else if (message.method === 'config/read') send({ id: message.id, result: { config: { mcp_servers: {}, features: Object.fromEntries(['apps','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','image_generation','in_app_browser','multi_agent','multi_agent_v2','view_image'].map(key => [key,false])) } } });
  else if (message.method === 'model/list') send({ id: message.id, result: { data: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: null } });
  else if (message.method === 'thread/read' && process.env.ARDENT_FIXTURE_THREAD_READ_FILE) send({ id: message.id, result: JSON.parse(readFileSync(process.env.ARDENT_FIXTURE_THREAD_READ_FILE,'utf8')) });
  else if (message.method === 'thread/read') send({ id: message.id, result: { thread: { model: process.env.ARDENT_FIXTURE_OBSERVED_MODEL || selectedModel, reasoningEffort: selectedEffort } } });
  else if (message.method === 'thread/start') {
    selectedModel = message.params.model; selectedEffort = message.params.config?.model_reasoning_effort;
    dynamicTools = message.params.dynamicTools;
    if (!process.env.ARDENT_FIXTURE_FORCE_TOOL_CALL && !dynamicTools?.some(tool => tool.name === selectedTool)) send({ id: message.id, error: { code: -32602, message: 'Missing dynamic tool' } });
    else send({ id: message.id, result: { thread: { id: 'thread-1' } } });
  } else if (message.method === 'turn/start') {
    turnCount++;
    const turnId = `turn-${turnCount}`;
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (process.env.ARDENT_FIXTURE_TURN_FILE) writeFileSync(process.env.ARDENT_FIXTURE_TURN_FILE, turnId);
    if (process.env.ARDENT_FIXTURE_HANG_TURN) return;
    if (process.env.ARDENT_FIXTURE_AGENT_MESSAGES || process.env.ARDENT_FIXTURE_GENERATED_AGENT_CHARS) {
      if (process.env.ARDENT_FIXTURE_OTHER_THREAD_DELTA) send({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId, itemId: 'unrelated', delta: 'x'.repeat(1000) } });
      const messages = process.env.ARDENT_FIXTURE_GENERATED_AGENT_CHARS ? [{ id: 'generated', text: 'x'.repeat(Number(process.env.ARDENT_FIXTURE_GENERATED_AGENT_CHARS)) }] : JSON.parse(process.env.ARDENT_FIXTURE_AGENT_MESSAGES);
      for (const item of messages) {
        for (const delta of item.deltas ?? []) send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, itemId: item.id, delta } });
        if (item.completed !== false) send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: item.id, text: item.text, phase: item.phase ?? 'final_answer' } } });
      }
      if (process.env.ARDENT_FIXTURE_OTHER_TURN_DELTA) send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'other-turn', itemId: 'unrelated', delta: 'x'.repeat(1000) } });
      if (process.env.ARDENT_FIXTURE_TOKEN_USAGE) send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId, tokenUsage: JSON.parse(process.env.ARDENT_FIXTURE_TOKEN_USAGE) } });
      if (!process.env.ARDENT_FIXTURE_WAIT_INTERRUPT) send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', error: null } } });
    } else if (process.env.ARDENT_FIXTURE_IMAGE_PROTOCOL_FILE) {
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: 'image-1', text: 'Exact image reviewed', phase: 'final_answer' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', error: null } } });
    } else if (turnCount === 1) send({ method: 'item/tool/call', id: 900, params: { threadId: 'thread-1', turnId, callId: 'call-1', namespace: null, tool: selectedTool, arguments: process.env.ARDENT_FIXTURE_TOOL_ARGS ? JSON.parse(process.env.ARDENT_FIXTURE_TOOL_ARGS) : selectedTool === 'fixture_search' ? { query: 'test' } : {} } });
    else {
      const answer = message.params.input[0].text.includes('"ok":true') ? 'Sourced fixture answer' : 'Tool failed';
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id: 'item-2', text: answer, phase: 'final_answer' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', error: null } } });
    }
  } else if (message.method === 'turn/interrupt') {
    if (process.env.ARDENT_FIXTURE_INTERRUPT_FILE) writeFileSync(process.env.ARDENT_FIXTURE_INTERRUPT_FILE, message.params.turnId);
    if (process.env.ARDENT_FIXTURE_WITNESS_OBSERVATION_FILE) writeFileSync(process.env.ARDENT_FIXTURE_WITNESS_OBSERVATION_FILE, JSON.stringify({ witnessPresent: existsSync(process.env.ARDENT_FIXTURE_WITNESS_FILE ?? '') }));
    if (process.env.ARDENT_FIXTURE_LOSE_INTERRUPT_REPLY) return;
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted', error: null } } });
  } else if (message.id === 900) {
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'item-1', text: 'No visible tool output', phase: 'final_answer' } } });
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
  }
});
