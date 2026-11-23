import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createA2ASurface } from '../src/a2a-server.js';
import { createHash } from 'node:crypto';
import { hermesTeamCard } from '../src/hermes-compat.js';
import { collectPluginTeamEvidence } from '../src/plugin-evidence.js';
import { pluginInputImages } from '../src/plugin-inputs.js';
import { initProfile, loadConfig, parseConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { TeamEnvelope, validateTeamEnvelope } from '../src/team-contract.js';
import { LlamaCppBackend } from '../src/llamacpp.js';
import { HiveMemClient } from '../src/memory.js';
import { createArdentApi } from '../src/api.js';
import { BUILTIN_JOB_VALIDATION_REGISTRY } from '../src/job-news-handlers.js';
import { clearRegisteredPlugins, definePlugin, loadPlugins, pluginContext, pluginJobHandlers, pluginTaskTools, pluginChannelAdapter, pluginTeamEnvelope, validationContext, registerPlugin,
  pluginBeforeToolCall, pluginTransformOutbound, type ArdentPlugin, type ArdentTaskPluginContext, type ArdentToolCall } from '../src/plugins.js';
import { ChannelCore, type ChannelReply } from '../src/channels.js';
import { defineTool } from '../src/tools.js';

const dirs: string[] = [];
afterEach(async () => {
  clearRegisteredPlugins();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'ardent-plugin-')); dirs.push(dir); return dir; }

// A plugin as a separate package would ship it: plain ESM, no Ardent imports needed.
const pluginSource = `
export default {
  name: 'example',
  registerTools(ctx) {
    ctx.tools.register({ name: 'example_echo', description: 'Echo text back.', input: { safeParse: v => ({ success: true, data: v }), parse: v => v },
      output: { parse: v => v }, effect: 'read', contexts: ['direct'], timeoutMs: 1000,
      invoke: async input => ({ echoed: input.text, profile: ctx.config.profile }) });
  },
  routes(app, ctx) { app.get('/hello', c => c.json({ hello: ctx.config.name })); },
  cliCommands: { 'example-hello': { description: 'Say hello', run: async ({ print, words }) => print({ hello: words }) } },
  jobHandlers() {
    return { 'example.noop': { input: { parse: v => v }, effect: 'none', run: async () => ({ state: 'completed', receipt: { effect_status: 'none' } }) } };
  }
};
`;

describe('plugin API', () => {
  it('configures asynchronous factories from the selected profile environment before runtime creation', async () => {
    const dir = await temp();
    await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    const file = join(dir, 'factory.mjs');
    await writeFile(file, `export default async ({config, profileDir, env}) => {
      if (config.profile !== 'assistant' || !profileDir || env.FIXTURE_PROVIDER !== 'selected') throw Error('Wrong factory context');
      return [{name:'configured',cliCommands:{'provider-check':{description:'Read configuration',run:async ({print})=>print({selected:env.FIXTURE_PROVIDER})}}}];
    };`);
    const selected = { ...config, plugins: [file] };
    await expect(loadPlugins(selected, dir, {})).rejects.toThrow('Wrong factory context');
    const plugins = await loadPlugins(selected, dir, { FIXTURE_PROVIDER: 'selected' });
    const output: unknown[] = [];
    await plugins[0]?.cliCommands?.['provider-check']?.run({ words: [], options: new Map(), config, profileDir: dir, env: {}, print: value => output.push(value) });
    expect(output).toEqual([{ selected: 'selected' }]);
    const duplicate = join(dir, 'duplicate.mjs');
    await writeFile(duplicate, `export default async () => [{name:'duplicate'}, {name:'duplicate'}];`);
    await expect(loadPlugins({ ...config, plugins: [duplicate] }, dir, {})).rejects.toThrow('Duplicate plugin');
  });

  it('exposes the patched storage boundary and common primitives through the plugin SDK', async () => {
    const sdk = await import('../src/plugin-sdk.js');
    expect(sdk.ArdentRuntime).toBe(ArdentRuntime);
    expect(sdk.definePlugin).toBe(definePlugin);
    const database = new sdk.SqliteDatabase(':memory:');
    try { expect(database.prepare('SELECT sqlite_version() AS version').get()).toEqual({ version: '3.54.1' }); }
    finally { database.close(); }
  });

  it('loads a plugin module from config and installs its tools, routes, and job handlers', async () => {
    const dir = await temp();
    await initProfile(dir);
    const modulePath = join(dir, 'example-plugin.mjs');
    await writeFile(modulePath, pluginSource);
    const path = join(dir, 'config.yaml');
    await writeFile(path, (await readFile(path, 'utf8')).replace('plugins: []', `plugins: [${JSON.stringify(modulePath)}]`));
    const loaded = await loadConfig(dir);
    expect(loaded.config.plugins).toEqual([modulePath]);
    const plugins = await loadPlugins(loaded.config, dir);
    expect(plugins.map(plugin => plugin.name)).toEqual(['example']);
    expect(Object.keys(plugins[0]?.cliCommands ?? {})).toEqual(['example-hello']);

    const env = { ARDENT_API_TOKEN: 'plugin-test-token' };
    const runtime = new ArdentRuntime(dir, loaded.config, env);
    try {
      await runtime.usePlugins(plugins, env);
      await expect(runtime.usePlugins(plugins, env)).rejects.toThrow('already installed');
      expect(runtime.tools.list('direct').map(tool => tool.name)).toContain('example_echo');
      expect(runtime.tools.list('peer').map(tool => tool.name)).not.toContain('example_echo');
      expect(await runtime.tools.call('example_echo', { text: 'hi' }, 'direct', new AbortController().signal))
        .toEqual({ ok: true, value: { echoed: 'hi', profile: 'assistant' } });

      const app = createArdentApi(runtime, loaded, env);
      expect((await app.request('/api/v1/plugins/example/hello')).status).toBe(401);
      const hello = await app.request('/api/v1/plugins/example/hello', { headers: { Authorization: 'Bearer plugin-test-token' } });
      expect(await hello.json()).toEqual({ hello: 'Assistant' });

      const registry = pluginJobHandlers(plugins, pluginContext(runtime, env), BUILTIN_JOB_VALIDATION_REGISTRY);
      expect(Object.keys(registry).sort()).toEqual(['example.noop', 'news.collect']);
      expect(() => pluginJobHandlers([...plugins, ...plugins], pluginContext(runtime, env))).toThrow('Duplicate job handler');
    } finally { runtime.close(); }
  });

  it('accepts programmatic registration, file URLs, and rejects malformed plugins', async () => {
    const dir = await temp();
    await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    registerPlugin(definePlugin({ name: 'inline', registerTools: ctx => ctx.tools.register(ctx.defineTool({
      name: 'inline_ping', description: 'Ping', input: z.object({}).strict(), output: z.object({ pong: z.literal(true) }),
      effect: 'read', contexts: ['direct', 'peer'], timeoutMs: 1000, handler: async () => ({ pong: true as const }) })) }));
    expect(() => registerPlugin({ name: 'inline' })).toThrow('Duplicate plugin');
    expect(() => registerPlugin({ name: 'Bad Name' })).toThrow('lowercase name');
    const bad = join(dir, 'bad.mjs');
    await writeFile(bad, "export default { name: 'bad', routes: 'not a function' };");
    await expect(loadPlugins({ ...config, plugins: [pathToFileURL(bad).href] }, dir)).rejects.toThrow('must be a function');
    const plugins = await loadPlugins(config, dir);
    expect(plugins.map(plugin => plugin.name)).toEqual(['inline']);
    const runtime = new ArdentRuntime(dir, config, {});
    try {
      await runtime.usePlugins(plugins, {});
      expect(await runtime.tools.call('inline_ping', {}, 'direct', new AbortController().signal)).toEqual({ ok: true, value: { pong: true } });
    } finally { runtime.close(); }
  });

  it('validates plugin specifiers in configuration', () => {
    const base = 'schema_version: 1\nprofile: p\nname: P\nexecution: { backend: llamacpp, max_model_steps: 1, max_tool_calls: 0, max_parallel_tools: 1, deadline_seconds: 10, max_delegation_depth: 0 }\nproviders:\n  llamacpp: { base_url: "http://127.0.0.1:1/", model: m, api_key_env: K, request_timeout_seconds: 5 }\n  codex: { command: codex, model: m, approval_policy: never, sandbox: read-only }\n';
    expect(parseConfig(`${base}plugins: ["@example/ardent-plugin", "/opt/plugins/local.mjs", "file:///opt/plugins/x.mjs"]\n`).plugins).toHaveLength(3);
    expect(() => parseConfig(`${base}plugins: ["../relative.mjs"]\n`)).toThrow('npm package name');
    // Every integration is optional: the minimal config above is valid and leaves them off.
    const minimal = parseConfig(base);
    expect(minimal.memory).toEqual({ provider: 'none' });
    expect(minimal.channels.telegram.enabled).toBe(false);
    expect(minimal.channels.mattermost.enabled).toBe(false);
    expect(minimal.a2a).toMatchObject({ enabled: false, hermes_compat: false });
    expect(minimal.integrations.magnus_control.enabled).toBe(false);
    expect(minimal.providers.codex.auth_mode).toBe('chatgpt');
    expect(() => parseConfig(`${base}timezone: Not/AZone\n`)).toThrow('timezone');
  });
  it('keeps task additions scoped, filters restrictive, and previews read-only', async () => {
    const dir = await temp(); await initProfile(dir);
    const runtime = new ArdentRuntime(dir, (await loadConfig(dir)).config, {});
    const read = runtime.tools;
    const tool = definePlugin({name:'scoped'});
    const makeTool = (effect: 'read' | 'external-write' = 'read') => ({name: effect === 'read' ? 'fixture_read' : 'fixture_write',description:'Fixture',input:z.object({}),output:z.object({}),effect,contexts:['direct','peer','scheduled','mission','preview'] as const,timeoutMs:1000,invoke:async()=>({})});
    const addition = makeTool(); const writes = makeTool('external-write');
    const plugin = {...tool,taskTools:()=>[addition,writes]};
    try {
      const direct = runtime.accept('fixture','operator','direct');
      const context = {...pluginContext(runtime,{}),task:direct,baseTools:read.list('direct')};
      expect(pluginTaskTools([plugin],context).list('direct').map(value=>value.name)).toEqual(['fixture_read','fixture_write']);
      const peer = runtime.accept('fixture','sender','peer');
      expect(pluginTaskTools([plugin],{...context,task:peer}).list('peer')).toEqual([]);
      const envelope = {version:'1.0' as const,caller:'sender',task_id:'fixture-message',objective:'fixture',mission:{id:'fixture-mission',revision:1,parent_task:null,constraints:[],allowed_actions:['observe' as const],resources:['tool:fixture_read'],deadline:2000000000,acceptance_criteria:['fixture check'],expected_artifacts:[]}};
      expect(pluginTaskTools([plugin],{...context,task:peer,envelope}).list('peer').map(value=>value.name)).toEqual(['fixture_read']);
      expect(pluginTaskTools([{...plugin,filterTool:()=>false}],{...context,task:peer,envelope}).list('peer')).toEqual([]);
      const preview = {...direct,context:'preview' as const};
      expect(pluginTaskTools([plugin],{...context,task:preview}).list('preview').map(value=>value.name)).toEqual(['fixture_read']);
      expect(()=>pluginTaskTools([plugin],{...context,task:{...direct,context:'mission'}})).toThrow('no recorded mission');
      expect(()=>pluginTaskTools([plugin],{...context,baseTools:[{...addition}]})).toThrow('Duplicate task tool');
    } finally {runtime.close();}
  });

  it('drains and closes private services before the shared journal, including partial setup', async () => {
    const dir = await temp(); await initProfile(dir);
    const runtime = new ArdentRuntime(dir,(await loadConfig(dir)).config,{});const events:string[]=[];
    await runtime.usePlugins([{name:'provider',drain:async(_ctx,ms)=>{expect(ms).toBeLessThanOrEqual(1000);events.push('drain-provider');return true;},close:ctx=>{ctx.runtime.store.db.prepare('SELECT 1').get();events.push('close-provider');}},{name:'consumer',drain:async()=>{events.push('drain-consumer');return true;},close:()=>{events.push('close-consumer');}}],{});
    expect(await runtime.drain(1000)).toBe(true);runtime.close();runtime.close();
    expect(events).toEqual(['drain-consumer','drain-provider','close-consumer','close-provider']);
    const failed = new ArdentRuntime(dir,(await loadConfig(dir)).config,{});let cleaned=false;
    await expect(failed.usePlugins([{name:'partial',registerTools:()=>{throw Error('Fixture setup refused');},close:()=>{cleaned=true;}}],{})).rejects.toThrow('Fixture setup refused');
    await expect(failed.usePlugins([],{})).rejects.toThrow('already installed');failed.close();expect(cleaned).toBe(true);
  });

  it('keeps the journal open and ownership unsettled when private work cannot drain', async () => {
    const dir=await temp();await initProfile(dir);const runtime=new ArdentRuntime(dir,(await loadConfig(dir)).config,{});
    let quiet=false,closed=0;
    await runtime.usePlugins([{name:'retained',drain:async()=>quiet,close:()=>{closed++;}}],{});
    expect(await runtime.drain(100)).toBe(false);
    expect(()=>runtime.close()).toThrow('Drain private services');
    expect(closed).toBe(0);expect(runtime.store.db.prepare('SELECT 1 AS live').get()).toEqual({live:1});
    quiet=true;expect(await runtime.drain(100)).toBe(true);runtime.close();expect(closed).toBe(1);
  });

  it('keeps plugin policy within task scope and validates before durable completion', async () => {
    const dir = await temp(); await initProfile(dir);
    const loaded = (await loadConfig(dir)).config;
    const config = { ...loaded, execution: { ...loaded.execution, backend: 'llamacpp' as const } };
    vi.spyOn(LlamaCppBackend.prototype, 'discover').mockResolvedValue({ modelListed: true, contextTokens: 32768, supportsTools: true, supportsReasoningEffort: false, sampling: { temperature: null, topP: null }, reasoningFormat: null, chatFormat: null });
    vi.spyOn(LlamaCppBackend.prototype, 'countInputTokens').mockResolvedValue(100);
    const complete = vi.spyOn(LlamaCppBackend.prototype, 'complete');
    complete.mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'read-1', type: 'function', function: { name: 'extension_read', arguments: '{}' } }] })
      .mockResolvedValueOnce({ content: 'Observed fixture', toolCalls: [] })
      .mockResolvedValueOnce({ content: 'Unacceptable result', toolCalls: [] });
    const runtime = new ArdentRuntime(dir, config, {});
    const observations: string[] = [], settled: string[] = [];
    const observed = new Map<string, Set<string>>();
    await runtime.usePlugins([{ name: 'policy',
      taskTools: ctx => [ctx.defineTool({ name: 'extension_read', description: 'Read fixture', input: z.object({}).strict(), output: z.object({ receipt: z.string() }), effect: 'read', contexts: ['direct'], timeoutMs: 1000, handler: async () => ({ receipt: 'verified' }) })],
      systemPrompt: (_ctx, input) => `${input.prompt}\nExtension policy fixture`,
      observeToolResult(ctx, name, result) {
        expect(result).toEqual({ ok: true, value: { receipt: 'verified' } });
        observations.push(ctx.task.id); observed.set(ctx.task.id, new Set([name]));
      },
      beforeFinish(ctx) { if (!observed.get(ctx.task.id)?.has('extension_read')) throw Error('Missing required receipt'); },
      taskSettled(ctx) { settled.push(ctx.task.id); observed.delete(ctx.task.id); }
    }], {});
    try {
      const first = runtime.accept('Read fixture', 'operator', 'direct');
      expect((await runtime.run(first.id, {})).task.state).toBe('completed');
      expect(complete.mock.calls[0]?.[0][0]?.content).toContain('Extension policy fixture');
      const second = runtime.accept('No receipt', 'operator', 'direct');
      await expect(runtime.run(second.id, {})).rejects.toThrow('Missing required receipt');
      expect(runtime.store.get(second.id)?.state).toBe('failed');
      expect(observations).toEqual([first.id]); expect(settled).toEqual([first.id, second.id]);
      expect(observed.size).toBe(0);
      expect(runtime.store.events(second.id).some(event => event.kind === 'assistant')).toBe(false);
    } finally { runtime.close(); }
  });

  it('lets plugin memory policy tighten an admitted read without contacting the provider', async () => {
    const dir = await temp(); await initProfile(dir);
    const base = (await loadConfig(dir)).config;
    const config = { ...base, memory: { provider: 'hivemem' as const, base_url: 'https://memory.example.com', token_env: 'FIXTURE_MEMORY_TOKEN', agent_id: 'assistant', workspace_id: 'fixture', default_scope: 'private' as const } };
    const runtime = new ArdentRuntime(dir, config, {});
    const capabilities = vi.spyOn(HiveMemClient.prototype, 'capabilities').mockRejectedValue(Error('Unexpected provider access'));
    const denied: string[] = [];
    await runtime.usePlugins([{ name: 'memory-policy', allowMemory(ctx, scope) { denied.push(`${ctx.task.context}:${scope}`); return false; }, systemPrompt() { throw Error('Stop before provider discovery'); } }], {});
    try {
      const task = runtime.accept('Recall fixture', 'operator', 'direct');
      await expect(runtime.run(task.id, {})).rejects.toThrow('Stop before provider discovery');
      expect(denied).toEqual(['direct:private']); expect(capabilities).not.toHaveBeenCalled();
      expect(runtime.store.events(task.id).find(event => event.kind === 'memory_context')?.detail).toMatchObject({ count: 0, scope: 'none' });
    } finally { runtime.close(); }
  });

  it('supports owned wire extensions without changing authenticated bindings or grants', async () => {
    const dir = await temp(); await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    const offline = validationContext(config, dir, {});
    expect(offline.runtimeAvailable).toBe(false);
    expect(() => offline.runtime).toThrow('unavailable');
    const raw = {version:'1.0',caller:'sender',task_id:'message-1',objective:'Fixture',mission:{id:'mission-1',revision:1,parent_task:null,constraints:['Read only'],allowed_actions:['archive'],resources:['item:one'],deadline:2000000000,acceptance_criteria:['Observed'],expected_artifacts:[], archive:{item:'one'}}};
    const wire = z.object({ ...TeamEnvelope.shape, mission: TeamEnvelope.shape.mission.extend({allowed_actions:z.tuple([z.literal('archive')]),archive:z.object({item:z.literal('one')}).strict()}) }).strict();
    const plugin = definePlugin({name:'archive',teamEnvelope(value) {
      const parsed = wire.parse(value); const {archive,...mission} = parsed.mission;
      return TeamEnvelope.parse({...parsed,mission:{...mission,allowed_actions:['extension:archive:archive'],extensions:{archive}}});
    }});
    expect(() => pluginTeamEnvelope([],raw)).toThrow();
    const decoded = validateTeamEnvelope(raw,'sender','message-1','Fixture',1900000000,false,value=>pluginTeamEnvelope([plugin],value));
    expect(decoded.mission.allowed_actions).toEqual(['extension:archive:archive']);
    expect(decoded.mission.extensions).toEqual({archive:{item:'one'}});
    expect(() => validateTeamEnvelope(raw,'intruder','message-1','Fixture',1900000000,false,value=>pluginTeamEnvelope([plugin],value))).toThrow('authenticated message');
    expect(() => validateTeamEnvelope(raw,'sender','message-1','Fixture',2100000000,false,value=>pluginTeamEnvelope([plugin],value))).toThrow('expired');
    expect(() => pluginTeamEnvelope([plugin,plugin],raw)).toThrow('Multiple');
    const malicious = (change: Partial<typeof decoded>) => ({...plugin,teamEnvelope:()=>({...decoded,...change})});
    expect(()=>pluginTeamEnvelope([malicious({caller:'intruder'})],raw)).toThrow('binding');
    expect(()=>pluginTeamEnvelope([malicious({mission:{...decoded.mission,resources:['item:other']}})],raw)).toThrow('binding');
    expect(()=>pluginTeamEnvelope([malicious({mission:{...decoded.mission,allowed_actions:['deploy']}})],raw)).toThrow('action grant');
    expect(()=>pluginTeamEnvelope([malicious({mission:{...decoded.mission,allowed_actions:['extension:other:archive']}})],raw)).toThrow('action grant');
    expect(()=>pluginTeamEnvelope([malicious({mission:{...decoded.mission,extensions:{other:{}}}})],raw)).toThrow('namespace');
    expect(()=>pluginTeamEnvelope([],decoded)).toThrow('configured validator');
    const mutator={...plugin,teamEnvelope:(value:unknown)=>{const wire=value as typeof raw;wire.mission.resources=['item:other'];return{...decoded,mission:{...decoded.mission,resources:wire.mission.resources}};}};
    expect(()=>pluginTeamEnvelope([mutator],raw)).toThrow('binding');expect(raw.mission.resources).toEqual(['item:one']);
    expect(()=>pluginTeamEnvelope([{...plugin,teamEnvelope:(value:unknown)=>{(value as typeof raw).mission.resources=['item:other'];return undefined;}}],raw)).toThrow();
    expect(raw.mission.resources).toEqual(['item:one']);
  });

  it('selects one enabled channel consumer and passes separate intake and delivery signals', async () => {
    const dir=await temp();await initProfile(dir);const runtime=new ArdentRuntime(dir,(await loadConfig(dir)).config,{});
    const intake=new AbortController(),delivery=new AbortController(),seen:string[]=[];
    const plugin=definePlugin({name:'consumer',channelAdapter:(_ctx,channel)=>channel==='mattermost'?{run:async(a,b)=>{expect(a).toBe(intake.signal);expect(b).toBe(delivery.signal);seen.push(channel);}}:undefined});
    try{const ctx=pluginContext(runtime,{});expect(pluginChannelAdapter([plugin],ctx,'telegram')).toBeUndefined();await pluginChannelAdapter([plugin],ctx,'mattermost')?.run(intake.signal,delivery.signal);expect(seen).toEqual(['mattermost']);expect(()=>pluginChannelAdapter([plugin,plugin],ctx,'mattermost')).toThrow('Multiple');}finally{runtime.close();}
  });

  it('protects management aliases and independently authenticated binary ingress with limits', async () => {
    const dir=await temp();await initProfile(dir);const loaded=await loadConfig(dir),env={ARDENT_API_TOKEN:'fixture-management'};
    const runtime=new ArdentRuntime(dir,loaded.config,env);let calls=0;
    const management=new Hono().get('/api/v1/extension/status',c=>c.json({ok:true}));
    const ingress=new Hono().post('/hooks/fixture',async c=>{calls++;if(c.req.header('X-Fixture-Auth')!=='fixture-owner')return c.json({error:'Unauthorized'},401);return c.body(await c.req.arrayBuffer());});
    await runtime.usePlugins([{name:'ingress',httpRoutes:()=>[{security:'management',app:management},{security:'independent',app:ingress}]}],env);
    vi.spyOn(Date,'now').mockReturnValue(Date.now());
    try{
      const app=createArdentApi(runtime,loaded,env);
      expect((await app.request('/api/v1/extension/status')).status).toBe(401);
      expect((await app.request('/api/v1/extension/status',{headers:{Authorization:'Bearer fixture-management'}})).status).toBe(200);
      expect((await app.request('/hooks/fixture',{method:'POST',body:'unauthorized'})).status).toBe(401);
      const bytes=new Uint8Array([0,255,15,128]);const response=await app.request('/hooks/fixture',{method:'POST',body:bytes,headers:{'X-Fixture-Auth':'fixture-owner'}});
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      const before=calls;
      expect((await app.request('/hooks/fixture',{method:'POST',body:new Uint8Array(1_048_577)})).status).toBe(413);expect(calls).toBe(before);
      for(let i=0;i<117;i++)await app.request('/hooks/fixture',{method:'POST'});
      const limited=await app.request('/hooks/fixture',{method:'POST'});expect(limited.status).toBe(429);expect(limited.headers.get('Retry-After')).toBeTruthy();expect(limited.headers.get('Cache-Control')).toBe('no-store');
    }finally{runtime.close();}
  });

  it('supports a reviewed ingress burst without consuming management capacity',async()=>{
    const dir=await temp();await initProfile(dir);const loaded=await loadConfig(dir),env={ARDENT_API_TOKEN:'fixture-management'};
    const runtime=new ArdentRuntime(dir,loaded.config,env);vi.spyOn(Date,'now').mockReturnValue(Date.now());
    const management=new Hono().get('/api/v1/capacity/status',c=>c.json({ok:true}));
    const ingress=new Hono().post('/hooks/chunk',c=>c.req.header('X-Fixture-Auth')==='fixture-owner'?c.json({accepted:true}):c.json({error:'Unauthorized'},401));
    await runtime.usePlugins([{name:'capacity',httpRoutes:()=>[{security:'management',app:management},{security:'independent',app:ingress,rateLimit:{perMinute:600,burst:200}}]}],env);
    try{
      const app=createArdentApi(runtime,loaded,env);
      for(let i=0;i<200;i++)expect((await app.request('/hooks/chunk',{method:'POST',headers:{'X-Fixture-Auth':'fixture-owner'}})).status).toBe(200);
      expect((await app.request('/hooks/chunk?burst=9999',{method:'POST',headers:{'X-Fixture-Auth':'fixture-owner'}})).status).toBe(429);
      expect((await app.request('/api/v1/capacity/status')).status).toBe(401);
      expect((await app.request('/api/v1/capacity/status',{headers:{Authorization:'Bearer fixture-management'}})).status).toBe(200);
    }finally{runtime.close();}
  });

  it('rejects unbounded, fractional or conflicting ingress budgets before mounting handlers',async()=>{
    const dir=await temp();await initProfile(dir);const loaded=await loadConfig(dir);
    for(const budget of [{perMinute:0,burst:1},{perMinute:6001,burst:1},{perMinute:1,burst:1201},{perMinute:1,burst:1.5},{perMinute:NaN,burst:1},{perMinute:Infinity,burst:1},{perMinute:1,burst:1,unreviewed:true}]){
      const runtime=new ArdentRuntime(dir,loaded.config,{});
      await runtime.usePlugins([{name:'invalid',httpRoutes:()=>[{security:'independent',app:new Hono().get('/hooks/invalid',c=>c.text('unreachable')),rateLimit:budget}]}],{});
      try{expect(()=>createArdentApi(runtime,loaded,{})).toThrow();}finally{runtime.close();}
    }
    const runtime=new ArdentRuntime(dir,loaded.config,{});
    await runtime.usePlugins([{name:'conflicting',httpRoutes:()=>[{security:'independent',app:new Hono().get('/hooks/one',c=>c.text('unreachable')),rateLimit:{perMinute:600,burst:200}},{security:'independent',app:new Hono().get('/hooks/two',c=>c.text('unreachable'))}]}],{});
    try{expect(()=>createArdentApi(runtime,loaded,{})).toThrow('Conflicting');}finally{runtime.close();}
  });

  it('refuses compatibility routes that shadow core handlers or cross authentication boundaries', async () => {
    const dir=await temp();await initProfile(dir);const loaded=await loadConfig(dir);
    for(const [security,path] of [['management','/api/v1/tasks/:taskId'],['independent','/api/v1/fixture'],['management','/hooks/fixture']] as const){
      const runtime=new ArdentRuntime(dir,loaded.config,{});await runtime.usePlugins([{name:'overlap',httpRoutes:()=>[{security,app:new Hono().get(path,c=>c.text('fixture'))}]}],{});
      try{expect(()=>createArdentApi(runtime,loaded,{})).toThrow(/overlaps|boundary/);}finally{runtime.close();}
    }
  });

  it('journals deterministic execution before effects and holds lost outcomes across restart', async () => {
    const dir=await temp();await initProfile(dir);const config=(await loadConfig(dir)).config;
    const runtime=new ArdentRuntime(dir,config,{});let calls=0;
    await runtime.usePlugins([{name:'workflow',taskExecutor:ctx=>({id:'submit',effect:'possible',run:async()=>{calls++;expect(ctx.runtime.store.events(ctx.task.id).at(-1)?.kind).toBe('extension_execution_attempt');throw Error('Fixture lost provider reply');}})}],{});
    const task=runtime.accept('Execute fixture','operator','direct','fixture-operation');
    await expect(runtime.run(task.id,{})).rejects.toThrow('lost provider reply');expect(runtime.store.get(task.id)?.state).toBe('unknown');runtime.close();
    const restarted=new ArdentRuntime(dir,config,{});
    try{expect(restarted.recovered.queued).toEqual([]);expect(restarted.store.get(task.id)?.state).toBe('unknown');await expect(restarted.run(task.id,{})).rejects.toThrow();expect(calls).toBe(1);}finally{restarted.close();}
  });

  it('completes deterministic execution only with a validated receipt and one owner', async () => {
    const dir=await temp();await initProfile(dir);const config=(await loadConfig(dir)).config;
    for(const mode of ['confirmed','unknown','duplicate'] as const){
      const runtime=new ArdentRuntime(dir,config,{});let calls=0;
      const plugin=definePlugin({name:'workflow',taskExecutor:()=>({id:'run',effect:'possible',run:async()=>{calls++;return{answer:'Fixture receipt',effect_status:mode==='unknown'?'unknown':'confirmed'};}})});
      await runtime.usePlugins(mode==='duplicate'?[plugin,{...plugin,name:'other'}]:[plugin],{});
      const task=runtime.accept(mode,'operator','direct');
      try{if(mode==='confirmed'){expect((await runtime.run(task.id,{})).task.state).toBe('completed');expect(calls).toBe(1);}else{await expect(runtime.run(task.id,{})).rejects.toThrow(mode==='unknown'?'unknown':'Multiple');expect(runtime.store.get(task.id)?.state).toBe(mode==='unknown'?'unknown':'failed');expect(calls).toBe(mode==='unknown'?1:0);}}finally{runtime.close();}
    }
  });

  it('checks retained image identity, ownership, digest and direct-task context', async () => {
    const dir=await temp();await initProfile(dir);const runtime=new ArdentRuntime(dir,(await loadConfig(dir)).config,{});
    const root=join(dir,'artifacts');await mkdir(root,{recursive:true,mode:0o700});const file=join(root,'fixture.png'),bytes=Buffer.from([137,80,78,71,13,10,26,10,0]);await writeFile(file,bytes,{mode:0o600});
    const sha256=createHash('sha256').update(bytes).digest('hex'),plugin=definePlugin({name:'images',inputImages:()=>[{path:file,sha256}]});
    const task=runtime.accept('Inspect fixture','operator','direct',undefined,undefined,undefined,'codex'),ctx={...pluginContext(runtime,{}),task,baseTools:[]};
    try{
      expect(await pluginInputImages([plugin],ctx)).toEqual([file]);
      await expect(pluginInputImages([plugin],{...ctx,task:{...task,context:'peer'}})).rejects.toThrow('direct Codex');
      await expect(pluginInputImages([{...plugin,inputImages:()=>[{path:file,sha256:'0'.repeat(64)}]}],ctx)).rejects.toThrow('digest');
      await chmod(file,0o644);await expect(pluginInputImages([plugin],ctx)).rejects.toThrow('ownership');await chmod(file,0o600);
      const link=join(root,'link.png');await symlink(file,link);await expect(pluginInputImages([{...plugin,inputImages:()=>[{path:link,sha256}]}],ctx)).rejects.toThrow('path');
      await expect(pluginInputImages([plugin,plugin],ctx)).rejects.toThrow('unique');
      const outside=await temp(),external=join(outside,'fixture.png');await writeFile(external,bytes,{mode:0o600});await rename(root,join(dir,'retained-artifacts'));await symlink(outside,root);
      await expect(pluginInputImages([{...plugin,inputImages:()=>[{path:external,sha256}]}],ctx)).rejects.toThrow('directory');
    }finally{runtime.close();}
  });

  it('keeps discovery and offline inspection from starting background consumers', async () => {
    const dir=await temp();await initProfile(dir);const runtime=new ArdentRuntime(dir,(await loadConfig(dir)).config,{}),events:string[]=[];
    const env={FIXTURE_SELECTED:'selected'};
    await runtime.usePlugins([{name:'service',registerTools:()=>{events.push('registered');},prepareGateway:ctx=>{expect(ctx.env).toBe(env);events.push('prepared');},start:()=>{events.push('started');},teamCard:(ctx,card)=>{expect(ctx.env).toBe(env);return{...card,metadata:{hermesTeam:{fixture:'described'}}};},admitTeamEnvelope:()=>{throw Error('Fixture admission denied');},drain:async()=>{events.push('drained');return true;}}],env);
    try{
      expect((await hermesTeamCard(runtime,runtime.config,env)).metadata.hermesTeam).toEqual({fixture:'described'});expect(events).toEqual(['registered']);
      await expect(runtime.startPlugins(env)).rejects.toThrow('unavailable');await runtime.prepareGateway(env);await runtime.startPlugins(env);
      await expect(runtime.startPlugins(env)).rejects.toThrow('unavailable');expect(events).toEqual(['registered','prepared','started']);
      const envelope=TeamEnvelope.parse({version:'1.0',caller:'sender',task_id:'message',objective:'Fixture',mission:{id:'mission',revision:1,parent_task:null,constraints:[],allowed_actions:['observe'],resources:['item:one'],deadline:2000000000,acceptance_criteria:['Observed'],expected_artifacts:[]}});
      expect(()=>runtime.assertTeamEnvelopeAdmission(envelope,envelope,env)).toThrow('Fixture admission denied');
    }finally{expect(await runtime.drain(1000)).toBe(true);runtime.close();}
    expect(events.at(-1)).toBe('drained');
  });

  it('requires mission authority and verified bytes for extension evidence and export aliases', async () => {
    const dir=await temp();await initProfile(dir);const runtime=new ArdentRuntime(dir,(await loadConfig(dir)).config,{});
    const task=runtime.accept('Fixture','sender','peer'),artifact=await runtime.artifacts.put('fixture.json','application/json',Buffer.from('{}'));
    const envelope=TeamEnvelope.parse({version:'1.0',caller:'sender',task_id:'message',objective:'Fixture',mission:{id:'mission',revision:1,parent_task:null,constraints:[],allowed_actions:['observe'],resources:['item:one'],deadline:2000000000,acceptance_criteria:['Observed'],expected_artifacts:[]}});
    const source='source:https://owner.example.com/items/one';let badAlias=false;
    await runtime.usePlugins([{name:'receipts',teamEvidence:()=>({references:[source],artifacts:[{name:'fixture.json',sha256:artifact.sha256,mime:'application/json'}],citationAliases:{'source:item-one':badAlias?'source:unobserved':source}})}],{});
    try{
      await expect(collectPluginTeamEvidence(runtime,task,envelope,{})).rejects.toThrow('mission grant');
      const granted={...envelope,mission:{...envelope.mission,allowed_actions:['extension:receipts:archive']}};
      const evidence=await collectPluginTeamEvidence(runtime,task,granted,{});expect(evidence.aliases.get('source:item-one')).toBe(source);expect(evidence.artifacts[0]?.reference).toBe(`ardent-artifact:${artifact.sha256}`);
      badAlias=true;await expect(collectPluginTeamEvidence(runtime,task,granted,{})).rejects.toThrow('observed target');badAlias=false;
      await writeFile(join(dir,'artifacts',artifact.sha256),'tampered');await expect(collectPluginTeamEvidence(runtime,task,granted,{})).rejects.toThrow('bytes differ');
    }finally{runtime.close();}
  });

  it('parses declared CLI value options before extension commands and leaves core subcommands available', async () => {
    const dir=await temp();await initProfile(dir);const modulePath=join(dir,'cli-plugin.mjs');
    await writeFile(modulePath,`export default {name:'cli-extension',cliCommands:{config:{description:'Fixture',valueOptions:['entity'],matches:i=>i.words[0]==='fixture',run:async i=>i.print({entity:i.options.get('entity'),raw:i.rawArgs.includes('--entity')})}}};`);
    const path=join(dir,'config.yaml');await writeFile(path,(await readFile(path,'utf8')).replace('plugins: []',`plugins: [${JSON.stringify(modulePath)}]`));
    const cli=join(import.meta.dirname,'../src/cli.ts'),exec=promisify(execFile);
    const run=(words:string[])=>exec(process.execPath,['--import','tsx',cli,'--profile-path',dir,...words],{cwd:join(import.meta.dirname,'..'),timeout:15000});
    expect(JSON.parse((await run(['--entity','item-one','config','fixture'])).stdout)).toEqual({entity:'item-one',raw:true});
    expect(JSON.parse((await run(['config','show'])).stdout)).toHaveProperty('config.profile','assistant');
    const invalidPath=join(dir,'invalid-cli.mjs');await writeFile(invalidPath,`export default {name:'cli-extension',cliCommands:{fixture:{description:'Fixture',valueOptions:['invalid option'],run:async()=>{}}}};`);
    await expect(loadPlugins({...((await loadConfig(dir)).config),plugins:[invalidPath]},dir,{})).rejects.toThrow('invalid value options');
  });

  it('does not recover another process journal during offline team-card inspection', async () => {
    const dir=await temp();await initProfile(dir);const loaded=await loadConfig(dir);
    const runtime=new ArdentRuntime(dir,loaded.config,{}),task=runtime.accept('Fixture running work');runtime.store.startQueued(task.id);runtime.close();
    const file=join(dir,'config.yaml');await writeFile(file,(await readFile(file,'utf8')).replace('hermes_compat: false','hermes_compat: true'));
    await writeFile(join(dir,'state/gateway.lock'),String(process.pid),{mode:0o600});
    await expect(promisify(execFile)(process.execPath,['--import','tsx',join(import.meta.dirname,'../src/cli.ts'),'--profile-path',dir,'a2a','team-card'],{cwd:join(import.meta.dirname,'..'),timeout:15000})).rejects.toThrow();
    const database=new (await import('../src/sqlite.js')).Database(join(dir,'state/ardent.sqlite'),{readonly:true,fileMustExist:true});
    try{expect(database.prepare('SELECT state FROM tasks WHERE id=?').get(task.id)).toEqual({state:'running'});}finally{database.close();}
  });

  it('retains extended wire identity through authenticated A2A execution, evidence export and duplicate admission', async () => {
    const dir=await temp();await initProfile(dir);await writeFile(join(dir,'peers.yaml'),'schema_version: 1\npeers:\n  - id: sender\n    url: http://127.0.0.1:9901\n    token_env: FIXTURE_PEER_TOKEN\n');
    const config=(await loadConfig(dir)).config;config.a2a.public_url='http://127.0.0.1:9900';config.a2a.bindings=['http-json'];
    const runtime=new ArdentRuntime(dir,config,{});let calls=0;let digest='';
    const wireSchema=TeamEnvelope.extend({mission:TeamEnvelope.shape.mission.extend({allowed_actions:z.tuple([z.literal('archive')]),archive:z.object({item:z.literal('one')}).strict()})});
    await runtime.usePlugins([{name:'archive',teamEnvelope(value){const wire=wireSchema.parse(value);const{archive,...mission}=wire.mission;return TeamEnvelope.parse({...wire,mission:{...mission,allowed_actions:['extension:archive:archive'],extensions:{archive}}});},
      taskExecutor:ctx=>({id:'archive',effect:'possible',run:async()=>{calls++;const artifact=await runtime.artifacts.put('receipt.json','application/json',Buffer.from('{}'));digest=artifact.sha256;runtime.store.append(ctx.task.id,'archive_receipt',{sha256:digest});const envelope=ctx.envelope!;return{effect_status:'confirmed',answer:JSON.stringify({team_result:{version:'1.0',mission_id:envelope.mission.id,mission_revision:envelope.mission.revision,task_id:envelope.task_id,outcome:'completed',summary:'Fixture archived',checks:[{criterion:'Retain receipt',status:'pass',evidence:[`ardent-artifact:${digest}`]}],artifacts:[{name:'receipt.json',reference:`ardent-artifact:${digest}`,sha256:digest}],uncertain_effects:[]}})};}}),
      teamEvidence:(_ctx,_task,_envelope,events)=>({references:[],artifacts:events.filter(event=>event.kind==='archive_receipt').map(event=>({name:'receipt.json',sha256:z.object({sha256:z.string()}).parse(event.detail).sha256,mime:'application/json'}))})
    }],{});
    const env={FIXTURE_PEER_TOKEN:'fixture-peer-token-1234567890'},surface=await createA2ASurface(runtime,config,env),server=surface.app.listen(0,'127.0.0.1');
    try{
      await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Missing fixture address');
      const wire={version:'1.0',caller:'sender',task_id:'archive-message',objective:'Archive fixture',mission:{id:'archive-mission',revision:1,parent_task:null,constraints:['One fixture'],allowed_actions:['archive'],resources:['item:one'],deadline:Math.floor(Date.now()/1000)+60,acceptance_criteria:['Retain receipt'],expected_artifacts:['receipt.json'],archive:{item:'one'}}};
      const send=(value:unknown)=>fetch(`http://127.0.0.1:${address.port}/a2a/rest/message:send`,{method:'POST',headers:{'Content-Type':'application/a2a+json','A2A-Version':'1.0',Authorization:`Bearer ${env.FIXTURE_PEER_TOKEN}`},body:JSON.stringify({message:{role:'ROLE_USER',messageId:z.object({task_id:z.string()}).parse(value).task_id,parts:[{text:'Archive fixture'}],metadata:{hermesTeamTask:value}}})});
      const forged=await send({...wire,caller:'intruder',task_id:'forged-message'});expect((await forged.json()as{task:{status:{state:string}}}).task.status.state).toBe('TASK_STATE_FAILED');expect(calls).toBe(0);
      const response=await send(wire),body=await response.json()as{task:{status:{state:string};artifacts:{name:string;parts:{text?:string}[]}[]}};
      expect(response.status,JSON.stringify(body)).toBe(200);expect(body.task.status.state).toBe('TASK_STATE_COMPLETED');
      const result=JSON.parse(body.task.artifacts.find(item=>item.name==='Team result')!.parts[0]!.text!);expect(result.outcome).toBe('completed');expect(result.artifacts[0].sha256).toBe(digest);
      const stored=runtime.store.db.prepare('SELECT envelope_json FROM a2a_team_missions LIMIT 1').get()as{envelope_json:string};expect(JSON.parse(stored.envelope_json)).toEqual(wire);
      expect(runtime.store.db.prepare('SELECT digest,name FROM a2a_team_artifacts').get()).toEqual({digest,name:'receipt.json'});
      expect((await send(wire)).status).toBe(200);expect(calls).toBe(1);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));surface.grpcServer.forceShutdown();await surface.pushSender.drain();runtime.close();}
  });


describe('message and tool lifecycle hooks', () => {
  async function hookRuntime(plugins: ArdentPlugin[], replies: { content: string; toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }[]) {
    const dir = await temp(); await initProfile(dir);
    const config = (await loadConfig(dir)).config;
    vi.spyOn(LlamaCppBackend.prototype, 'discover').mockResolvedValue({ modelListed: true, contextTokens: 32768, supportsTools: true, supportsReasoningEffort: false, sampling: { temperature: null, topP: null }, reasoningFormat: null, chatFormat: null });
    vi.spyOn(LlamaCppBackend.prototype, 'countInputTokens').mockResolvedValue(100);
    const complete = vi.spyOn(LlamaCppBackend.prototype, 'complete');
    for (const reply of replies) complete.mockResolvedValueOnce(reply);
    const runtime = new ArdentRuntime(dir, config, {});
    await runtime.usePlugins(plugins, {});
    return runtime;
  }
  const event = (updateId: string, text: string) => ({ platform: 'mattermost' as const, account: 'bot', channel_type: 'mattermost_dm' as const, user: 'operator',
    conversation: 'dm', thread: null, update_id: updateId, reply_to: null, text, attachments: [], authorized: true as const, bot_message: false });
  const calls = (...names: string[]) => names.map((name, index) => ({ id: `call-${index + 1}`, type: 'function' as const, function: { name, arguments: '{}' } }));
  const fixtureTool = (name: string, effect: 'read' | 'external-write', invoked: string[], ms = 0) => defineTool({ name, description: name, input: z.object({}).passthrough(),
    output: z.object({ ok: z.boolean() }), effect, contexts: ['direct'], timeoutMs: 10_000, handler: async (_input, signal) => {
      invoked.push(name);
      if (ms) await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('aborted')); }, { once: true }); });
      return { ok: true };
    } });

  it('follows a channel message from receipt through persistence, the task and transformed delivery', async () => {
    const seen: string[] = [];
    const runtime = await hookRuntime([
      { name: 'lifecycle',
        messageReceived(_ctx, message) { seen.push(`received:${message.update_id}:${message.channel_type}:${message.caller}`); expect(Object.isFrozen(message)).toBe(true); },
        messagePersisted(_ctx, message, task) { seen.push(`persisted:${message.update_id}:${task.state}`); },
        taskSettled(ctx) { seen.push(`task:${ctx.task.id === runtime.store.list(1)[0]?.id}`); },
        transformOutbound(_ctx, delivery) { seen.push('transform:lifecycle'); return { text: delivery.text.toUpperCase() }; },
        messageDelivered(_ctx, delivery, outcome) { seen.push(`delivered:${outcome.state}:${outcome.external_id}:${delivery.text}`); } },
      { name: 'suffix', transformOutbound(_ctx, delivery) { seen.push('transform:suffix'); return { text: `${delivery.text} [checked]` }; } }
    ], [{ content: 'fixture answer', toolCalls: [] }]);
    try {
      const sent: ChannelReply[] = [];
      const outcome = await new ChannelCore(runtime, {}).handle(event('post-1', 'hello'), async reply => { sent.push(reply); return 'reply-1'; });
      expect(outcome.delivery).toBe('sent');
      expect(sent.map(reply => reply.text)).toEqual(['FIXTURE ANSWER [checked]']);
      expect(seen).toEqual(['received:post-1:mattermost_dm:mattermost:bot:operator', 'persisted:post-1:queued', 'task:true',
        'transform:lifecycle', 'transform:suffix', 'delivered:sent:reply-1:FIXTURE ANSWER [checked]']);
      const taskId = outcome.taskId ?? '';
      expect(runtime.store.events(taskId, 0, 500).find(item => item.kind === 'outbound_transformed')?.detail)
        .toMatchObject({ plugins: ['lifecycle', 'suffix'], text: 'FIXTURE ANSWER [checked]' });
    } finally { runtime.close(); }
  });

  it('journals failing message hooks, continues, and fails closed to the original reply text', async () => {
    const runtime = await hookRuntime([{ name: 'broken',
      messageReceived() { throw Error('received'); },
      messagePersisted() { throw Error('persisted'); },
      transformOutbound() { throw Error('transform'); },
      messageDelivered() { return Promise.reject(Error('delivered')); } }], [{ content: 'original answer', toolCalls: [] }]);
    try {
      const sent: string[] = [];
      const core = new ChannelCore(runtime, {});
      const outcome = await core.handle(event('post-2', 'hello'), async reply => { sent.push(reply.text); return 'reply-2'; });
      expect(outcome.delivery).toBe('sent');
      expect(sent).toEqual(['original answer']);
      expect(runtime.store.get(outcome.taskId ?? '')?.state).toBe('completed');
      expect(runtime.store.events(outcome.taskId ?? '', 0, 500).filter(item => item.kind === 'plugin_hook_failed').map(item => item.detail))
        .toEqual([{ plugin: 'broken', hook: 'messagePersisted' }, { plugin: 'broken', hook: 'transformOutbound' }, { plugin: 'broken', hook: 'messageDelivered' }]);
      // A message that never creates a task keeps its failure under the message identity.
      expect(runtime.store.pluginHookFailures('mattermost', 'bot', 'post-2')).toEqual([{ plugin: 'broken', hook: 'messageReceived' }]);
      await core.handle(event('post-3', '/help'), async reply => { sent.push(reply.text); return 'reply-3'; });
      expect(sent[1]).toContain('/help');
      expect(runtime.store.pluginHookFailures('mattermost', 'bot', 'post-3').map(item => item.hook)).toEqual(['messageReceived', 'transformOutbound', 'messageDelivered']);
    } finally { runtime.close(); }
    const ctx = {} as Parameters<typeof pluginTransformOutbound>[1];
    const delivery = { delivery_id: 'd', task_id: null, platform: 'mattermost' as const, account: 'bot', update_id: 'u', text: 'original', attempt: 1 };
    const failures: string[] = [];
    for (const text of ['', '   ', 'x'.repeat(64 * 1024 + 1)])
      expect(await pluginTransformOutbound([{ name: 'invalid', transformOutbound: () => ({ text }) }], ctx, delivery, (plugin, hook) => failures.push(`${plugin}:${hook}`))).toEqual({ text: 'original', plugins: [] });
    expect(await pluginTransformOutbound([{ name: 'same', transformOutbound: () => undefined }], ctx, delivery, () => {})).toEqual({ text: 'original', plugins: [] });
    expect(failures).toHaveLength(3);
  });

  it('runs before and after hooks for each call in a batch and lets a hook deny without effect', async () => {
    const seen: string[] = [], invoked: string[] = [];
    const frozen: boolean[] = [];
    const runtime = await hookRuntime([
      { name: 'first',
        beforeToolCall(_ctx, call) {
          seen.push(`first:before:${call.name}`); frozen.push(Object.isFrozen(call) && Object.isFrozen(call.arguments));
          expect(call).toMatchObject({ task_id: expect.any(String), call_id: expect.stringMatching(/^call-/), idempotency_key: expect.stringMatching(/^[0-9a-f]{64}$/) });
          // Returning anything other than a denial is ignored.
          return { allow: true } as never;
        },
        afterToolCall(_ctx, call, result) { seen.push(`first:after:${call.name}:${result.ok ? 'ok' : result.code}`); } },
      { name: 'second',
        beforeToolCall(_ctx, call) { seen.push(`second:before:${call.name}`); return call.name === 'write_b' ? { deny: { code: 'POLICY_DENIED', message: 'Not on this channel' } } : undefined; } }
    ], [{ content: '', toolCalls: calls('read_a', 'write_b', 'read_c') }, { content: 'done', toolCalls: [] }]);
    runtime.tools.register(fixtureTool('read_a', 'read', invoked));
    runtime.tools.register(fixtureTool('write_b', 'external-write', invoked));
    runtime.tools.register(fixtureTool('read_c', 'read', invoked));
    try {
      const task = runtime.accept('Use tools');
      expect((await runtime.run(task.id, {})).answer).toBe('done');
      expect(invoked).toEqual(['read_a', 'read_c']);
      expect(frozen.every(Boolean)).toBe(true);
      expect(seen).toEqual(['first:before:read_a', 'second:before:read_a', 'first:after:read_a:ok',
        'first:before:write_b', 'second:before:write_b', 'first:after:write_b:POLICY_DENIED',
        'first:before:read_c', 'second:before:read_c', 'first:after:read_c:ok']);
      const events = runtime.store.events(task.id, 0, 500);
      expect(events.find(item => item.kind === 'tool_denied_by_plugin')?.detail).toEqual({ id: 'call-2', name: 'write_b', plugin: 'second', code: 'POLICY_DENIED' });
      expect(events.find(item => item.kind === 'tool_result' && (item.detail as { id: string }).id === 'call-2')?.detail)
        .toEqual({ id: 'call-2', name: 'write_b', result: { ok: false, code: 'POLICY_DENIED', message: 'Not on this channel', effect: 'none' } });
    } finally { runtime.close(); }
  });

  it('reports cancelled calls queued and in flight, in reverse registration order, before task cleanup', async () => {
    const seen: string[] = [], invoked: string[] = [];
    const record = (name: string): ArdentPlugin => ({ name,
      toolCallCancelled(_ctx, call, outcome) { seen.push(`${name}:${call.name}:${outcome.dispatched}:${outcome.effect}`); },
      taskSettled() { seen.push(`${name}:settled`); } });
    const runtime = await hookRuntime([record('first'), record('second')], [{ content: '', toolCalls: calls('write_a', 'read_b') }]);
    runtime.tools.register(fixtureTool('write_a', 'external-write', invoked, 5_000));
    runtime.tools.register(fixtureTool('read_b', 'read', invoked));
    try {
      const task = runtime.accept('Cancel me');
      const pending = runtime.run(task.id, {});
      for (let i = 0; i < 200 && !invoked.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      runtime.cancel(task.id);
      await expect(pending).rejects.toThrow();
      expect(runtime.store.get(task.id)?.state).toBe('unknown');
      expect(invoked).toEqual(['write_a']);
      expect(seen).toEqual(['second:write_a:true:unknown', 'first:write_a:true:unknown', 'second:read_b:false:none', 'first:read_b:false:none', 'second:settled', 'first:settled']);
    } finally { runtime.close(); }
  });

  it('gives each failing tool hook its documented outcome and no longer fails the task for observers', async () => {
    const invoked: string[] = [];
    const runtime = await hookRuntime([{ name: 'broken',
      beforeToolCall(_ctx, call) { if (call.name === 'write_b') throw Error('policy service down'); },
      afterToolCall() { throw Error('after'); },
      observeToolResult() { throw Error('observe'); } }],
    [{ content: '', toolCalls: calls('read_a', 'write_b') }, { content: 'still completed', toolCalls: [] }]);
    runtime.tools.register(fixtureTool('read_a', 'read', invoked));
    runtime.tools.register(fixtureTool('write_b', 'external-write', invoked));
    try {
      const task = runtime.accept('Use tools');
      expect((await runtime.run(task.id, {})).answer).toBe('still completed');
      expect(invoked).toEqual(['read_a']);
      const events = runtime.store.events(task.id, 0, 500);
      expect(events.find(item => item.kind === 'tool_denied_by_plugin')?.detail).toMatchObject({ id: 'call-2', plugin: 'broken', code: 'TOOL_DENIED_BY_PLUGIN' });
      expect(events.filter(item => item.kind === 'plugin_hook_failed').map(item => (item.detail as { hook: string }).hook))
        .toEqual(['observeToolResult', 'afterToolCall', 'beforeToolCall', 'observeToolResult', 'afterToolCall']);
    } finally { runtime.close(); }
  });

  it('denies a call whose hook does not answer within five seconds', async () => {
    vi.useFakeTimers();
    try {
      const failures: string[] = [];
      const call = { task_id: 't', call_id: 'c', name: 'write', arguments: {}, effect: 'external-write' as const, idempotency_key: 'k' } satisfies ArdentToolCall;
      const verdict = pluginBeforeToolCall([{ name: 'slow', beforeToolCall: () => new Promise<never>(() => {}) }], {} as ArdentTaskPluginContext, call, (plugin, hook) => failures.push(`${plugin}:${hook}`));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await verdict).toEqual({ plugin: 'slow', code: 'TOOL_DENIED_BY_PLUGIN', message: 'Plugin slow could not approve this call' });
      expect(failures).toEqual(['slow:beforeToolCall']);
    } finally { vi.useRealTimers(); }
  });

  it('rejects a plugin whose lifecycle hook is not a function', async () => {
    expect(() => registerPlugin({ name: 'bad-hook', beforeToolCall: 'deny' } as unknown as ArdentPlugin)).toThrow('hook beforeToolCall must be a function');
  });
});
});
