import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { initProfile, loadConfig, parseConfig } from '../src/config.js';
import { ArdentRuntime } from '../src/runtime.js';
import { createArdentApi } from '../src/api.js';
import { BUILTIN_JOB_VALIDATION_REGISTRY } from '../src/job-news-handlers.js';
import { clearRegisteredPlugins, definePlugin, loadPlugins, pluginContext, pluginJobHandlers, registerPlugin } from '../src/plugins.js';

const dirs: string[] = [];
afterEach(async () => {
  clearRegisteredPlugins();
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
});
