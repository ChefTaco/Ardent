#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { parse } from 'dotenv';
import { z } from 'zod';
import { ardentHome, ConfigSchema, DEFAULT_PROFILE, initProfile, loadConfig, profilePath, redactedConfig, resolveReference, runtimeProblems } from './config.js';
import { ArdentRuntime } from './runtime.js';
import { TaskStore } from './store.js';
import { ardentOpenApi, createArdentApi } from './api.js';
import { serve } from '@hono/node-server';
import { listSkills, readSkill, setSkillEnabled } from './skills.js';
import { HiveMemClient } from './memory.js';
import { createA2ASurface, startA2AGrpc } from './a2a-server.js';
import { TelegramAdapter } from './telegram.js';
import { MattermostAdapter } from './mattermost.js';
import { ArdentA2AClient } from './a2a-client.js';
import { CodexAppServer, assertCodexProtocol, compactWithCodex } from './codex.js';
import { LlamaCppBackend } from './llamacpp.js';
import { toJsonSchema } from './json-schema.js';
import { hermesTeamCard } from './hermes-compat.js';
import Database from 'better-sqlite3';
import { JobEngine, validateJobDefinitions } from './job-engine.js';
import { composeOwnershipChecks } from './job-ownership.js';
import { BUILTIN_JOB_VALIDATION_REGISTRY, builtinJobHandlers } from './job-news-handlers.js';
import { acquireGatewayLock, createLockFile } from './gateway-lock.js';
import { ContextCheckpoints } from './context-checkpoints.js';
import { loadModelPolicy } from './model-policy.js';
import { loadPlugins, pluginContext, pluginJobHandlers, validationContext, type ArdentPlugin } from './plugins.js';

import { ARDENT_VERSION } from './version.js';
import { acceptRuntime, readProtectedFile } from './acceptance.js';

type Parsed = { words: string[]; options: Map<string, string | true> };
function args(argv: string[]): Parsed {
  const words: string[] = [];
  const options = new Map<string, string | true>();
  const valued = new Set(['env-file', 'profile', 'profile-path', 'api-port', 'template', 'prompt', 'prompt-file', 'idempotency-key', 'session-id', 'login-id', 'source', 'schedule-id', 'window-key', 'release-id', 'caller', 'context', 'expected-head', 'expected-policy-revision']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals > 2) { options.set(arg.slice(2, equals), arg.slice(equals + 1)); continue; }
      const name = arg.slice(2);
      if (valued.has(name)) {
        const value = argv[++i];
        if (!value) throw new Error(`Missing value for --${name}`);
        options.set(name, value);
      } else options.set(name, true);
    } else words.push(arg);
  }
  return { words, options };
}
function value(options: Parsed['options'], name: string): string | undefined {
  const found = options.get(name);
  return typeof found === 'string' ? found : undefined;
}
async function environment(dir: string, explicitFile?: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const data = parse(explicitFile ? await readProtectedFile(explicitFile) : await readFile(join(dir, '.env')));
    for (const [name, val] of Object.entries(data)) if (env[name] === undefined) env[name] = val;
  } catch (error: unknown) {
    if (explicitFile || !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return env;
}
function print(value: unknown): void { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
async function assertNoGateway(dir: string): Promise<void> {
  const lock = await readFile(join(dir, 'state', 'gateway.lock'), 'utf8').catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (lock === undefined) return;
  const pid = Number(lock.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Profile gateway lock is malformed; inspect state/gateway.lock');
  try { process.kill(pid, 0); throw new Error(`Profile is owned by gateway PID ${pid}; use its management API`); }
  catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') throw new Error('Profile gateway lock is stale; inspect state/gateway.lock before clearing it');
    throw error;
  }
}
const USAGE = `Usage: ardent [--env-file FILE] [--profile NAME | --profile-path DIR] <command>

Commands:
  --version                                Print the independent product version
  acceptance                               Verify the authenticated running gateway
  init --non-interactive [--api-port N]   Create a profile from the bundled template
  profile list | profile show              List profiles / show the selected profile
  config validate | show | schema          Inspect configuration
  doctor                                   Report unresolved runtime configuration
  providers list | providers test          Inspect or probe the model backend
  auth codex status | login | cancel       Manage the Codex account sign-in
  skills list | show | enable | disable    Manage profile skills
  memory search <query>                    Search HiveMem (memory.provider: hivemem)
  jobs definitions validate --source FILE  Validate scheduled job definitions
  jobs definitions status                  Show installed job definitions
  context status | compact                 Inspect or compact a session context
  admission status | close --release-id ID Inspect or close the admission fence
  a2a discover <peer> | call <peer>        Talk to a configured A2A peer
  a2a team-card                            Print the Hermes team card (a2a.hermes_compat)
  openapi export                           Print the management OpenAPI document
  run --prompt TEXT | chat | report        Run a task, chat, or run a scheduled report
  sessions list | new | reset | show       Manage local CLI sessions
  tasks list | show | cancel | resume      Inspect local tasks
  gateway run                              Serve the management API, A2A, channels and jobs`;

async function main(): Promise<void> {
  const parsed = args(process.argv.slice(2));
  const [command, subcommand, id] = parsed.words;
  if (parsed.options.has('version')) { stdout.write(`${ARDENT_VERSION}\n`); return; }
  if (!command || command === 'help' || parsed.options.has('help')) { stdout.write(`${USAGE}\n`); return; }
  const profile = value(parsed.options, 'profile') ?? DEFAULT_PROFILE;
  const dir = profilePath(profile, value(parsed.options, 'profile-path'));
  if (command === 'init') {
    if (!parsed.options.has('non-interactive')) throw new Error('Use --non-interactive for reproducible profile initialization');
    const apiPort = value(parsed.options, 'api-port');
    const template = value(parsed.options, 'template');
    await initProfile(dir, { profile, ...(apiPort ? { apiPort: Number(apiPort) } : {}), ...(template ? { template } : {}) });
    print({ profile, path: dir, initialized: true });
    return;
  }
  if (command === 'profile' && subcommand === 'list') {
    const entries = await readdir(join(ardentHome(), 'profiles'), { withFileTypes: true }).catch(() => []);
    print(entries.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name })));
    return;
  }
  const loaded = await loadConfig(dir);
  const env = await environment(dir, value(parsed.options, 'env-file'));
  if (command === 'acceptance') {
    const result = await acceptRuntime(loaded.config, env);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const plugins = await loadPlugins(loaded.config, dir);
  for (const plugin of plugins) {
    const pluginCommand = command ? plugin.cliCommands?.[command] : undefined;
    if (pluginCommand) {
      await pluginCommand.run({ words: parsed.words.slice(1), options: parsed.options, profileDir: dir, config: loaded.config, env, print });
      return;
    }
  }
  if (command === 'context') {
    const sessionId = value(parsed.options, 'session-id');
    const caller = value(parsed.options, 'caller');
    const context = value(parsed.options, 'context');
    if (!sessionId || !z.string().guid().safeParse(sessionId).success || !caller || caller.length > 128 ||
        !['direct', 'peer', 'scheduled'].includes(context ?? ''))
      throw new Error('Use context status|compact --session-id UUID --caller NAME --context direct|peer|scheduled');
    const parsedContext = z.enum(['direct', 'peer', 'scheduled']).parse(context);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('Context controls require the local profile owner');
    for (const [path, kind] of [[dir, 'directory'], [join(dir, 'state'), 'directory'],
      [join(dir, 'state', 'ardent.sqlite'), 'file']] as const) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0 ||
          (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()))
        throw new Error('Context controls require owner-only local profile state');
    }
    const store = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
    try {
      const manager = new ContextCheckpoints(store, (route, prompt, signal) =>
        compactWithCodex(loaded.config.providers.codex.command, dir, route.model, route.reasoning_effort, prompt, signal, env, loaded.config.providers.codex.auth_mode));
      if (subcommand === 'status') { print(manager.status(sessionId, caller, parsedContext)); return; }
      if (subcommand !== 'compact' || parsed.options.has('dry-run') === parsed.options.has('apply'))
        throw new Error('Use context compact --dry-run or --apply');
      const policy = await loadModelPolicy(dir, env);
      if (!policy || !policy.policy.compaction.enabled) throw new Error('An enabled shared model policy is required');
      const expectedHead = value(parsed.options, 'expected-head');
      const expectedRevision = value(parsed.options, 'expected-policy-revision');
      if (parsed.options.has('apply') && (!expectedHead || !expectedRevision || !/^\d+$/.test(expectedRevision)))
        throw new Error('Apply requires --expected-head UUID|none and --expected-policy-revision NUMBER');
      const pseudo = { id: `preview:${randomUUID()}`, session_id: sessionId, caller,
        context: parsedContext, prompt: '' };
      const result = await manager.prepare(pseudo, `Manual context budget reservation. ${'x'.repeat(8000)}`, [], policy,
        AbortSignal.timeout(120_000), { apply: parsed.options.has('apply'), force: true,
          ...(expectedHead ? { expectedHead: expectedHead === 'none' ? null : expectedHead } : {}),
          ...(expectedRevision ? { expectedPolicyRevision: Number(expectedRevision) } : {}) });
      print({ status: result.status, proposal: result.proposal, published: result.compacted,
        estimated_prompt_tokens: result.messages.length ? Math.ceil(Buffer.byteLength(JSON.stringify(result.messages)) / 3) : 0 });
      return;
    } finally { store.close(); }
  }
  if (command === 'jobs' && subcommand === 'definitions') {
    const action = id;
    const registry = pluginJobHandlers(plugins, validationContext(loaded.config, dir, env), BUILTIN_JOB_VALIDATION_REGISTRY);
    const source = action === 'validate' ? value(parsed.options, 'source') : join(dir, 'jobs', 'active.json');
    if (!source || (source !== '/dev/stdin' && !isAbsolute(source)))
      throw new Error('Use jobs definitions validate --source <absolute file or /dev/stdin>');
    if (source !== '/dev/stdin') {
      const stat = await lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024)
        throw new Error('Job definition source must be a bounded regular file');
    }
    let contents: string;
    if (source === '/dev/stdin') {
      // Opening /dev/stdin as a path fails with ENXIO for a piped Node child
      // on some hosts. Consume the inherited pipe directly and keep its bound.
      let input = '';
      for await (const chunk of stdin) {
        input += String(chunk);
        if (Buffer.byteLength(input) > 512 * 1024) throw new Error('Job definition source exceeds 512 KiB');
      }
      contents = input;
    } else contents = await readFile(source, 'utf8');
    if (Buffer.byteLength(contents) > 512 * 1024) throw new Error('Job definition source exceeds 512 KiB');
    const validated = validateJobDefinitions(JSON.parse(contents) as unknown, registry, loaded.config.profile);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (action === 'validate') {
      print({ profile, revision: validated.definitions.revision, sha256, job_count: validated.job_count });
      return;
    }
    if (action === 'status') {
      let activeJobs = 0;
      let unknownJobs = 0;
      const dbPath = join(dir, 'state', 'ardent.sqlite');
      const dbStat = await lstat(dbPath);
      if (!dbStat.isFile() || dbStat.isSymbolicLink()) throw new Error('Profile job database is unavailable');
      const database = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_windows'").get();
        if (table) {
          const count = z.object({ n: z.number().int().nonnegative() });
          activeJobs = count.parse(database.prepare("SELECT count(*) AS n FROM job_windows WHERE state IN ('queued','running','retry')").get()).n;
          unknownJobs = count.parse(database.prepare("SELECT count(*) AS n FROM job_windows WHERE state='unknown'").get()).n;
        }
      } finally { database.close(); }
      print({ profile, revision: validated.definitions.revision, sha256, job_count: validated.job_count,
        active_jobs: activeJobs, unknown_jobs: unknownJobs, last_validation_error: null });
      return;
    }
    throw new Error('Use jobs definitions validate or jobs definitions status');
  }
  if (command === 'admission') {
    const store = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
    try {
      if (subcommand === 'status') { print({ profile, fence: store.admissionFence() }); return; }
      if (subcommand === 'close') {
        const releaseId = value(parsed.options, 'release-id');
        if (!releaseId) throw new Error('Use admission close --release-id <UUID>');
        print({ profile, fence: store.closeAdmission(releaseId) });
        return;
      }
      throw new Error('Use admission status or admission close --release-id <UUID>');
    } finally { store.close(); }
  }
  if (command === 'profile' && subcommand === 'show') { print({ profile: loaded.config.profile, path: dir, name: loaded.config.name }); return; }
  if (command === 'config' && subcommand === 'validate') { print({ valid: true, revision: loaded.revision, runtime_problems: runtimeProblems(loaded.config, env) }); return; }
  if (command === 'config' && subcommand === 'show') { print({ revision: loaded.revision, config: redactedConfig(loaded.config) }); return; }
  if (command === 'config' && subcommand === 'schema') { print(toJsonSchema(ConfigSchema)); return; }
  if (command === 'doctor') { print({ profile: loaded.config.profile, config_valid: true, runtime_problems: runtimeProblems(loaded.config, env), checked_at: new Date().toISOString() }); return; }
  if (command === 'a2a' && subcommand === 'team-card') {
    if (!loaded.config.a2a.hermes_compat) throw new Error('Hermes team card requires a2a.hermes_compat: true');
    const runtime = new ArdentRuntime(dir, loaded.config, env);
    try { await runtime.usePlugins(plugins, env); print(await hermesTeamCard(runtime, loaded.config)); }
    finally { runtime.close(); }
    return;
  }
  if (command === 'providers' && subcommand === 'list') { print([{ name: 'llamacpp', selected: loaded.config.execution.backend === 'llamacpp' }, { name: 'codex', selected: loaded.config.execution.backend === 'codex' }]); return; }
  if (command === 'skills') {
    if (subcommand === 'list') { print(await listSkills(dir, loaded.config)); return; }
    if (!id) throw new Error('Skill name required');
    if (subcommand === 'show') { stdout.write(await readSkill(dir, loaded.config, id)); return; }
    if (subcommand === 'enable' || subcommand === 'disable') { print({ revision: await setSkillEnabled(dir, id, subcommand === 'enable', loaded.revision) }); return; }
    throw new Error('Unknown skills command');
  }
  if (command === 'memory' && subcommand === 'search') {
    const query = parsed.words.slice(2).join(' ');
    if (!query) throw new Error('Memory search query required');
    if (loaded.config.memory.provider !== 'hivemem') throw new Error('Memory search requires memory.provider: hivemem');
    print(await new HiveMemClient(loaded.config.memory, env).search(query, 'private'));
    return;
  }
  if (command === 'openapi' && subcommand === 'export') { print(ardentOpenApi()); return; }
  if (command === 'auth' && subcommand === 'codex') {
    const action = parsed.words[2];
    await assertCodexProtocol(loaded.config.providers.codex.command, env);
    const server = new CodexAppServer(loaded.config.providers.codex.command, dir, env);
    try {
      await server.initialize();
      if (action === 'status') print({ provider: 'codex', auth_mode: await server.accountStatus() });
      else if (action === 'login') {
        const authMode = loaded.config.providers.codex.auth_mode;
        if (await server.accountStatus() === authMode) { print({ provider: 'codex', auth_mode: authMode, already_authenticated: true }); return; }
        if (authMode !== 'chatgpt') throw new Error('Device login is for auth_mode chatgpt; sign Codex in with an API key using the Codex CLI');
        const flow = await server.startDeviceLogin();
        print({ provider: 'codex', device_login: flow, status: 'pending' });
        let interrupted = false;
        const interrupt = () => { interrupted = true; };
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', interrupt);
        try {
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (interrupted) {
              await server.cancelLogin(flow.loginId).catch(() => {});
              print({ provider: 'codex', login_id: flow.loginId, status: 'cancelled' });
              return;
            }
            if (await server.accountStatus() === 'chatgpt') {
              print({ provider: 'codex', login_id: flow.loginId, status: 'completed', auth_mode: 'chatgpt' });
              return;
            }
          }
          await server.cancelLogin(flow.loginId).catch(() => {});
          throw new Error('Codex device login expired after 15 minutes');
        } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
      }
      else if (action === 'cancel') {
        const loginId = value(parsed.options, 'login-id');
        if (!loginId) throw new Error('Use --login-id to cancel a Codex device login');
        await server.cancelLogin(loginId);
        print({ provider: 'codex', login_id: loginId, cancelled: true });
      } else throw new Error('Use auth codex status, login, or cancel --login-id <id>');
    } finally { server.close(); }
    return;
  }
  if (command === 'a2a') {
    const peer = id;
    if (!peer) throw new Error('A2A peer ID required');
    const client = new ArdentA2AClient(dir, loaded.config, env);
    if (subcommand === 'discover') { const { card } = await client.open(peer); print(card); return; }
    if (subcommand === 'call') {
      const prompt = value(parsed.options, 'prompt') ?? parsed.words.slice(3).join(' ');
      if (!prompt) throw new Error('Use --prompt for an A2A call');
      print(await client.send(peer, prompt));
      return;
    }
    throw new Error('Use a2a discover <peer> or a2a call <peer> --prompt <text>');
  }
  if (command === 'providers' && subcommand === 'test') {
    if (loaded.config.execution.backend === 'codex') {
      await assertCodexProtocol(loaded.config.providers.codex.command, env);
      const server = new CodexAppServer(loaded.config.providers.codex.command, dir, env);
      try { await server.initialize(); print({ provider: 'codex', auth_mode: await server.accountStatus(), protocol: 'backward-compatibility-assumed' }); }
      finally { server.close(); }
    } else {
      const result = await new LlamaCppBackend(loaded.config.providers.llamacpp, env).complete([{ role: 'user', content: 'Reply with READY.' }], [], AbortSignal.timeout(20000), false);
      print({ provider: 'llamacpp', model: resolveReference(loaded.config.providers.llamacpp.model, env), answer: result.content, usage: result.usage ?? null, checked_at: new Date().toISOString() });
    }
    return;
  }
  if (!['run', 'report', 'chat', 'tasks', 'sessions', 'gateway'].includes(command ?? '')) throw new Error(`Unknown command.\n${USAGE}`);
  if (command === 'gateway' && subcommand === 'run') {
      if (!['127.0.0.1', '::1', 'localhost'].includes(loaded.config.api.host)) throw new Error('Non-local API listener requires verified TLS proxy configuration');
      {
        const gate = new TaskStore(join(dir, 'state', 'ardent.sqlite'));
        try { if (gate.admissionFence()) throw new Error('Profile admission is fenced; reconcile the exact rollback release before starting consumers'); }
        finally { gate.close(); }
      }
      const lockPath = join(dir, 'state', 'gateway.lock');
      const lock = await acquireGatewayLock(lockPath);
      let runtime: ArdentRuntime | undefined;
      let shutdownUnsettled = false;
      try {
        runtime = new ArdentRuntime(dir, loaded.config, env);
        await runtime.usePlugins(plugins, env);
        // Legacy scheduled tasks are not replayed by a new gateway generation.
        // The job engine owns its own window recovery and never replays uncertain effects.
        for (const task of runtime.recovered.queued) if (task.caller === 'management') void runtime.run(task.id, env).catch(() => {});
        const jobPath = join(dir, 'jobs', 'active.json');
        const hasJobs = await lstat(jobPath).then(stat => {
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Active job definitions are not a regular file');
          return true;
        }).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
          throw error;
        });
        const ctx = pluginContext(runtime, env);
        const jobRegistry = pluginJobHandlers(plugins, ctx, builtinJobHandlers(runtime, env));
        const ownership = composeOwnershipChecks(plugins.flatMap((plugin: ArdentPlugin) => plugin.jobOwnership ? [plugin.jobOwnership(ctx)] : []));
        const jobEngine = hasJobs ? new JobEngine(runtime.store.db, dir, loaded.config.profile, jobRegistry, ownership) : undefined;
        if (jobEngine) await jobEngine.load();
        if (jobEngine) await jobEngine.recoverAfterRestart();
        const api = createArdentApi(runtime, loaded, env, jobEngine);
        const server = serve({ fetch: api.fetch, hostname: loaded.config.api.host, port: loaded.config.api.port });
        await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
        let a2aHttp: HttpServer | undefined;
        let a2aGrpc: Awaited<ReturnType<typeof createA2ASurface>>['grpcServer'] | undefined;
        let a2aSurface: Awaited<ReturnType<typeof createA2ASurface>> | undefined;
        // Shutdown first stops intake (polling, listening, new job windows and
        // outbox claims), then drains, and only then aborts in-flight delivery.
        const channelAbort = new AbortController();
        const deliveryAbort = new AbortController();
        let telegramRun: Promise<void> | undefined;
        let mattermostRun: Promise<void> | undefined;
        let jobTimer: NodeJS.Timeout | undefined;
        const noticeRuns = new Set<Promise<unknown>>();
        try {
          if (jobEngine) {
            const tickJobs = () => {
              const operation = jobEngine.tick(new Date(), deliveryAbort.signal, channelAbort.signal)
                .catch(error => runtime?.store.setCursor('jobs:last_error', error instanceof Error ? error.message.slice(0, 500) : 'unknown'));
              noticeRuns.add(operation);
              void operation.finally(() => noticeRuns.delete(operation));
            };
            jobTimer = setInterval(tickJobs, 60_000);
            tickJobs();
          }
          if (loaded.config.a2a.enabled) {
            const surface = await createA2ASurface(runtime, loaded.config, env);
            a2aSurface = surface;
            const publicAddress = resolveReference(loaded.config.a2a.public_url, env);
            if (!publicAddress) throw new Error('A2A public URL is unconfigured');
            const a2aPort = loaded.config.a2a.listen_port ?? Number(new URL(publicAddress).port);
            if (!a2aPort || a2aPort === loaded.config.api.port) throw new Error('A2A public URL must have a port distinct from the management API');
            a2aHttp = await new Promise<HttpServer>((resolve, reject) => {
              const started = surface.app.listen(a2aPort, loaded.config.a2a.listen_host);
              started.once('listening', () => resolve(started));
              started.once('error', reject);
            });
            if (loaded.config.a2a.bindings.includes('grpc')) { await startA2AGrpc(surface, loaded.config.a2a.listen_host); a2aGrpc = surface.grpcServer; }
          }
          if (loaded.config.channels.telegram.enabled) {
            const fixtureBase = env.ARDENT_TELEGRAM_API_FIXTURE_URL;
            if (fixtureBase && (env.NODE_ENV !== 'test' || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(fixtureBase))) throw new Error('Telegram API fixture URL is permitted only for loopback tests');
            const telegram = new TelegramAdapter(runtime, loaded.config.channels.telegram, env, fixtureBase ?? 'https://api.telegram.org', jobEngine);
            telegramRun = telegram.run(channelAbort.signal, deliveryAbort.signal);
          }
          if (loaded.config.channels.mattermost.enabled) {
            const mattermost = new MattermostAdapter(runtime, loaded.config.channels.mattermost, env, jobEngine);
            mattermostRun = mattermost.run(channelAbort.signal);
          }
          print({ profile, host: loaded.config.api.host, port: loaded.config.api.port, a2a: a2aHttp ? 'listening' : 'disabled', status: 'listening' });
          await new Promise<void>((resolve, reject) => {
            const stop = () => resolve();
            server.once('error', reject);
            a2aHttp?.once('error', reject);
            void telegramRun?.catch(reject);
            void mattermostRun?.catch(reject);
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
          });
        } finally {
          if (jobTimer) clearInterval(jobTimer);
          channelAbort.abort();
          shutdownUnsettled = !(await runtime.drain(30_000));
          // Replies and notices admitted before shutdown may still be sending.
          // Give them a bounded window; an aborted send stays unknown, never retried.
          let deliveryTimer: NodeJS.Timeout | undefined;
          await Promise.race([
            Promise.allSettled([...noticeRuns, ...(telegramRun ? [telegramRun] : []), ...(mattermostRun ? [mattermostRun] : [])]),
            new Promise<void>(resolve => { deliveryTimer = setTimeout(resolve, 20_000); })
          ]);
          if (deliveryTimer) clearTimeout(deliveryTimer);
          deliveryAbort.abort();
          await Promise.allSettled([...noticeRuns]);
          await telegramRun?.catch(() => {});
          await mattermostRun?.catch(() => {});
          await new Promise<void>(resolve => server.close(() => resolve()));
          const httpServer = a2aHttp;
          const grpcServer = a2aGrpc;
          if (httpServer) await new Promise<void>(resolve => httpServer.close(() => resolve()));
          if (grpcServer) await new Promise<void>(resolve => grpcServer.tryShutdown(() => resolve()));
          if (a2aSurface) {
            try { await a2aSurface.pushSender.drain(); }
            catch { shutdownUnsettled = true; }
          }
        }
      } finally {
        if (runtime) {
          const settled = await runtime.drain(shutdownUnsettled ? 0 : 30_000);
          shutdownUnsettled ||= !settled;
          if (settled) runtime.close();
        }
        await lock.release();
      }
      if (shutdownUnsettled) {
        stderr.write('Gateway shutdown left unresolved work; interrupted tasks will be marked unknown on restart.\n');
        process.exit(1);
      }
      return;
  }
  const ownerLockPath = join(dir, 'state', 'gateway.lock');
  const ownerLock = await createLockFile(ownerLockPath).catch(async (error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      await assertNoGateway(dir);
      throw new Error('Profile is already owned by another Ardent process');
    }
    throw error;
  });
  let runtime: ArdentRuntime;
  try { runtime = new ArdentRuntime(dir, loaded.config, env); await runtime.usePlugins(plugins, env); }
  catch (error) { await ownerLock.release(); throw error; }
  try {
    if (command === 'tasks') {
      if (subcommand === 'list') { print(runtime.store.list()); return; }
      if (!id) throw new Error('Task ID required');
      if (subcommand === 'show') { print({ task: runtime.store.get(id), events: runtime.store.events(id) }); return; }
      if (subcommand === 'cancel') { print(runtime.cancel(id)); return; }
      if (subcommand === 'resume') {
        const task = runtime.store.get(id);
        if (!task) throw new Error('Task not found');
        if (task.state !== 'queued') throw new Error(`Task is ${task.state}; only unstarted queued work can be resumed without replaying an uncertain effect`);
        print(await runtime.run(task.id, env));
        return;
      }
      throw new Error('Unknown tasks command');
    }
    if (command === 'sessions') {
      if (subcommand === 'list') { print(runtime.store.listSessions('local', 'direct')); return; }
      if (subcommand === 'new' || subcommand === 'reset') { print(runtime.store.resetSession('local', 'direct', id ?? 'cli')); return; }
      if (subcommand === 'show' && id) { print({ messages: runtime.store.sessionMessages(id, 'local') }); return; }
      throw new Error('Use sessions list, new [key], reset [key], or show <id>');
    }
    if (command === 'run' || command === 'report') {
      let prompt = value(parsed.options, 'prompt');
      const promptFile = value(parsed.options, 'prompt-file');
      if (promptFile) prompt = await readFile(promptFile, 'utf8');
      if (parsed.options.has('stdin')) prompt = await new Promise<string>((resolve, reject) => {
        let input = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (chunk: string) => { input += chunk; if (input.length > 16000) reject(new Error('Prompt exceeds 16000 characters')); });
        stdin.on('end', () => resolve(input));
        stdin.on('error', reject);
      });
      if (!prompt?.trim()) throw new Error('Use --prompt, --prompt-file, or --stdin');
      let caller = 'local';
      let context: 'direct' | 'scheduled' = 'direct';
      let idempotencyKey = value(parsed.options, 'idempotency-key');
      if (command === 'report') {
        if (!parsed.options.has('non-interactive')) throw new Error('Scheduled report requires --non-interactive');
        const scheduleId = value(parsed.options, 'schedule-id');
        const windowKey = value(parsed.options, 'window-key');
        if (!scheduleId || !/^[A-Za-z0-9._-]{1,100}$/.test(scheduleId) || !windowKey || !/^[A-Za-z0-9._:-]{1,100}$/.test(windowKey)) throw new Error('Scheduled report requires a safe --schedule-id and --window-key');
        caller = `schedule:${scheduleId}`;
        context = 'scheduled';
        idempotencyKey = `report:${windowKey}`;
      }
      const task = runtime.accept(prompt, caller, context, idempotencyKey, command === 'run' ? value(parsed.options, 'session-id') : undefined);
      const result = await runtime.run(task.id, env);
      if (parsed.options.has('json')) print(result);
      else stdout.write(`${result.answer}\n`);
      return;
    }
    if (command === 'chat') {
      const rl = createInterface({ input: stdin, output: stdout });
      let session = runtime.store.session('local', 'direct', 'cli');
      let activeTask: string | undefined;
      let stopping = false;
      let lastInterrupt = 0;
      const interrupt = () => {
        if (Date.now() - lastInterrupt < 100) return;
        lastInterrupt = Date.now();
        if (activeTask) {
          stdout.write(`\nCancelling task ${activeTask}...\n`);
          try { runtime.cancel(activeTask); } catch { /* Terminal task already settled. */ }
        } else { stopping = true; rl.close(); }
      };
      process.on('SIGINT', interrupt);
      rl.on('SIGINT', interrupt);
      try {
        while (!stopping) {
          let prompt: string;
          try { prompt = await rl.question(`${loaded.config.profile}> `); }
          catch (error: unknown) { if (stopping) break; throw error; }
          if (['/exit', '/quit'].includes(prompt.trim())) break;
          if (!prompt.trim()) continue;
          if (['/new', '/reset'].includes(prompt.trim())) { session = runtime.store.resetSession('local', 'direct', 'cli'); stdout.write(`New session ${session.id}\n`); continue; }
          if (prompt.trim() === '/status') { print({ session_id: session.id, profile, backend: loaded.config.execution.backend }); continue; }
          if (prompt.trim() === '/tasks') { print(runtime.store.list()); continue; }
          const task = runtime.accept(prompt, 'local', 'direct', undefined, session.id);
          activeTask = task.id;
          let cursor = 0;
          let answerStarted = false;
          const showProgress = () => {
            if (answerStarted) return;
            for (const event of runtime.store.events(task.id, cursor, 100)) {
              cursor = event.sequence;
              if (event.kind === 'model_started') stdout.write('  Thinking...\n');
              else if (event.kind === 'tool_attempt') {
                const name = z.object({ name: z.string() }).safeParse(event.detail);
                if (name.success) stdout.write(`  Calling ${name.data.name}...\n`);
              } else if (event.kind === 'tool_result') {
                const value = z.object({ name: z.string(), result: z.object({ ok: z.boolean() }).passthrough() }).safeParse(event.detail);
                if (value.success) stdout.write(`  ${value.data.name}: ${value.data.result.ok ? 'done' : 'unavailable'}\n`);
              } else if (event.kind === 'research_artifacts') stdout.write('  Research artifacts saved.\n');
            }
          };
          const progress = setInterval(showProgress, 150);
          const streamState: { text: string; step: number; mode: 'pending' | 'plain' | 'structured' } = { text: '', step: -1, mode: 'pending' };
          const writeModelText = (chunk: string, step: number) => {
            if (step !== streamState.step) { streamState.step = step; streamState.text = ''; streamState.mode = 'pending'; }
            if (streamState.mode === 'structured') return;
            if (streamState.mode === 'pending') {
              const first = chunk.trimStart()[0];
              if (!first) { streamState.text += chunk; return; }
              streamState.mode = first === '{' || first === '[' ? 'structured' : 'plain';
              if (streamState.mode === 'structured') { streamState.text = ''; return; }
              showProgress();
              answerStarted = true;
              if (streamState.text) stdout.write(streamState.text);
            }
            streamState.text += chunk;
            stdout.write(chunk);
          };
          try {
            const result = await runtime.run(task.id, env, writeModelText);
            showProgress();
            if (streamState.mode !== 'plain' || streamState.text.trim() !== result.answer.trim()) stdout.write(`${result.answer}\n`);
            else if (!streamState.text.endsWith('\n')) stdout.write('\n');
          }
          catch (error: unknown) { showProgress(); stderr.write(`${error instanceof Error ? error.message : 'Task failed'}\n`); }
          finally { clearInterval(progress); activeTask = undefined; }
        }
      } finally { process.off('SIGINT', interrupt); rl.off('SIGINT', interrupt); rl.close(); }
    }
  } finally { try { runtime.close(); } finally { await ownerLock.release(); } }
}
main().catch((error: unknown) => {
  stderr.write(`ardent: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
});
