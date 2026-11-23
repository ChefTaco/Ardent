import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Hono } from 'hono';
import type { ArdentConfig } from './config.js';
import type { JobEngine, JobRegistry, OwnershipCheck } from './job-engine.js';
import type { ArdentRuntime, TaskEvidence } from './runtime.js';
import type { ResearchBrief } from './research.js';
import type { SkillInfo } from './skills.js';
import type { Task, TaskEvent } from './store.js';
import { defineTool, ToolRegistry, type ExecutionContext, type Tool, type ToolEffect, type ToolResult } from './tools.js';
import { TeamEnvelope, TeamMissionShape } from './team-contract.js';
import type { HermesTeamCard } from './hermes-compat.js';

/** Everything a plugin may use. Plugins receive no authority beyond the profile's own runtime. */
export type ArdentPluginContext = {
  /** False for offline validation; runtime and tools are unavailable there. */
  runtimeAvailable: boolean;
  runtime: ArdentRuntime;
  config: ArdentConfig;
  profileDir: string;
  env: NodeJS.ProcessEnv;
  /** The profile's shared tool registry. A tool's `contexts` decides which tasks may call it. */
  tools: ToolRegistry;
  defineTool: typeof defineTool;
};

/** Arguments passed to a plugin CLI command (`ardent <command> [words...] [--options]`). */
export type ArdentCliInvocation = {
  /** Positional words after the command name. */
  words: string[];
  /** Original CLI arguments for a plugin with its own bounded option grammar. */
  rawArgs?: readonly string[];
  options: ReadonlyMap<string, string | true>;
  profileDir: string;
  config: ArdentConfig;
  env: NodeJS.ProcessEnv;
  /** Print a JSON value to stdout. */
  print(value: unknown): void;
};
export type ArdentCliCommand = {
  description: string;
  /** Named options that consume one value, including when placed before the command. */
  valueOptions?: readonly string[];
  /** Select an extension subcommand without taking over other core subcommands. */
  matches?(invocation: ArdentCliInvocation): boolean;
  run(invocation: ArdentCliInvocation): Promise<void>;
};

/** Factory-time configuration is available before a runtime or its consumers exist. */
export type ArdentPluginFactoryContext = {
  config: ArdentConfig;
  profileDir: string;
  env: NodeJS.ProcessEnv;
};
export type ArdentPluginFactory = (context: ArdentPluginFactoryContext) =>
  ArdentPlugin | readonly ArdentPlugin[] | Promise<ArdentPlugin | readonly ArdentPlugin[]>;

/** An exact persisted task and its already scoped built-in tools. */
export type ArdentTaskPluginContext = ArdentPluginContext & {
  task: Task;
  envelope?: TeamEnvelope;
  baseTools: readonly Tool[];
  /** Attribution for the causal tree this task belongs to, when one was supplied. Never grants access. */
  execution?: ExecutionContext;
};

/** An authenticated, claimed channel message (a frozen copy). The text is not included. */
export type ArdentChannelMessage = {
  platform: 'telegram' | 'mattermost';
  account: string;
  update_id: string;
  channel_type: string;
  /** `<platform>:<account>:<user>`, the task caller for this message. */
  caller: string;
  /** `<platform>:<account>:<conversation>:<thread>`. */
  session_key: string;
  received_ms: number;
  execution?: ExecutionContext;
};
/** A channel reply recorded for delivery (a frozen copy). */
export type ArdentChannelDelivery = {
  delivery_id: string;
  task_id: string | null;
  platform: 'telegram' | 'mattermost';
  account: string;
  update_id: string;
  text: string;
  /** 1: Ardent records a delivery once and never resends it automatically. */
  attempt: number;
};
export type ArdentDeliveryOutcome = { state: 'sent' | 'failed' | 'unknown'; external_id: string | null };
/** One model tool call after context scoping and argument validation (a frozen copy). */
export type ArdentToolCall = {
  task_id: string;
  call_id: string;
  name: string;
  /** Validated arguments. */
  arguments: unknown;
  effect: ToolEffect;
  /** `sha256("<task_id>:<call_id>")`, the key the tool receives. */
  idempotency_key: string;
  execution?: ExecutionContext;
};
/** The only result `beforeToolCall` may return. Anything else is ignored. */
export type ArdentToolDenial = { deny: { code: string; message: string } };
export type ArdentToolCancellation = { dispatched: boolean; effect: 'none' | 'unknown' };

export type ArdentPromptInput = {
  prompt: string;
  memory: string;
  skills: readonly SkillInfo[];
  tools: ToolRegistry;
};
export type ArdentCompletionInput = {
  answer: string;
  brief?: ResearchBrief;
  partial: boolean;
  evidence: TaskEvidence;
};
export type ArdentChannelAdapter = { run(intake: AbortSignal, delivery: AbortSignal): Promise<void> };
export type ArdentTaskExecutor = {
  id: string;
  /** Any provider call or possible external write requires `possible`. */
  effect: 'none' | 'possible';
  run(signal: AbortSignal): Promise<{ answer: string; effect_status: 'none' | 'confirmed' | 'unknown' }>;
};
export type ArdentInputImage = { path: string; sha256: string };
export type ArdentTeamEvidence = {
  references: readonly string[];
  artifacts: readonly { name: string; sha256: string; mime: string; source?: string }[];
  /** Format-only aliases to observed references, used for one read-only check. */
  citationAliases?: Readonly<Record<string, string>>;
};
export type ArdentHttpRoutes = {
  /** Management aliases keep bearer auth. Independent ingress must authenticate inside every handler. */
  security: 'management' | 'independent';
  app: Hono;
  /** Bounded capacity for this plugin's authentication boundary; all mounts in it must agree. */
  rateLimit?: { perMinute: number; burst: number };
};

/**
 * An Ardent extension. Every hook is optional.
 *
 * - `registerTools` runs once per runtime before the gateway accepts work.
 * - `routes` mounts management routes under `/api/v1/plugins/<name>/`, behind
 *   the same bearer-token check as the rest of the management API.
 * - `cliCommands` adds `ardent <command>` subcommands for a loaded profile.
 * - `jobHandlers` contributes scheduled job handlers by handler ID.
 * - `jobOwnership` adds an extra admission check that every job window must pass.
 * - `peerTool` lets a peer (A2A) task call one of this plugin's tools. By
 *   default a peer may call a plugin tool only when its validated team mission
 *   lists the resource `tool:<tool name>`.
 */
export interface ArdentPlugin {
  name: string;
  registerTools?(ctx: ArdentPluginContext): void | Promise<void>;
  /** Management routes mounted under the plugin namespace, behind bearer authentication. */
  routes?(app: Hono, ctx: ArdentPluginContext): void;
  cliCommands?: Record<string, ArdentCliCommand>;
  /** Also called with a runtime-less validation context by `ardent jobs definitions validate`; touch `ctx.runtime` only inside `run`. */
  jobHandlers?(ctx: ArdentPluginContext): JobRegistry;
  jobOwnership?(ctx: ArdentPluginContext): OwnershipCheck;
  peerTool?(tool: Tool, task: Task, envelope: TeamEnvelope | undefined): boolean;
  /** Add tools bound to this task. Peer and mission grants are still checked. */
  taskTools?(ctx: ArdentTaskPluginContext): readonly Tool[];
  /** Restrict the final tool set. This hook can remove authority, never add it. */
  filterTool?(ctx: ArdentTaskPluginContext, tool: Tool): boolean;
  /** Validate a legacy wire envelope and translate only owned extension fields/actions. */
  teamEnvelope?(value: unknown): TeamEnvelope | undefined;
  /** Additional admission restrictions, after authenticated message/deadline validation. */
  admitTeamEnvelope?(ctx: ArdentPluginContext, envelope: TeamEnvelope, wire: unknown): void;
  /** Replace one enabled built-in consumer, retaining its original receipt identity. */
  channelAdapter?(ctx: ArdentPluginContext, channel: 'telegram' | 'mattermost', jobs?: JobEngine): ArdentChannelAdapter | undefined;
  /** Explicit compatibility routes. Core paths and overlapping registrations are refused. */
  httpRoutes?(ctx: ArdentPluginContext, jobs?: JobEngine): readonly ArdentHttpRoutes[];
  /** Trusted policy text, still subject to the complete model input budget. */
  systemPrompt?(ctx: ArdentTaskPluginContext, input: ArdentPromptInput): Promise<string> | string;
  /** Restrict an already admitted memory read; this cannot grant another scope. */
  allowMemory?(ctx: ArdentTaskPluginContext, scope: 'private' | 'shared', projectId?: string): boolean;
  /** Observe an actual tool result, retaining evidence within this task only. A throw is journaled and ignored. */
  observeToolResult?(ctx: ArdentTaskPluginContext, name: string, result: ToolResult, evidence: TaskEvidence): void;
  /** Observe a claimed channel message before any command or task handling. */
  messageReceived?(ctx: ArdentPluginContext, message: ArdentChannelMessage): void | Promise<void>;
  /** Observe a channel message once its task is accepted and bound to it. */
  messagePersisted?(ctx: ArdentPluginContext, message: ArdentChannelMessage, task: Task): void | Promise<void>;
  /** Rewrite a reply's text before it is recorded and sent (1 byte to 64 KiB). Any failure sends the original text. */
  transformOutbound?(ctx: ArdentPluginContext, delivery: ArdentChannelDelivery): { text: string } | void | Promise<{ text: string } | void>;
  /** Observe the recorded outcome of a channel delivery. */
  messageDelivered?(ctx: ArdentPluginContext, delivery: ArdentChannelDelivery, outcome: ArdentDeliveryOutcome): void | Promise<void>;
  /** Deny a validated tool call before it is invoked. A throw or a 5 s timeout denies it. */
  beforeToolCall?(ctx: ArdentTaskPluginContext, call: ArdentToolCall): void | ArdentToolDenial | Promise<void | ArdentToolDenial>;
  /** Observe a journaled tool result, successful or not. */
  afterToolCall?(ctx: ArdentTaskPluginContext, call: ArdentToolCall, result: ToolResult): void | Promise<void>;
  /** Clean up after a call stopped by cancellation, queued (`dispatched: false`) or in flight. */
  toolCallCancelled?(ctx: ArdentTaskPluginContext, call: ArdentToolCall, outcome: ArdentToolCancellation): void | Promise<void>;
  /** Additional validation before terminal success; throwing prevents completion. */
  beforeFinish?(ctx: ArdentTaskPluginContext, input: ArdentCompletionInput): Promise<void> | void;
  /** Release per-task resources after execution, including failed/cancelled tasks. */
  taskSettled?(ctx: ArdentTaskPluginContext): void;
  /** Deterministic owned workflow; attempts are journaled before invocation and never replayed. */
  taskExecutor?(ctx: ArdentTaskPluginContext): ArdentTaskExecutor | undefined;
  /** Owner-authenticated retained images, confined to this profile's artifact directory. */
  inputImages?(ctx: ArdentTaskPluginContext): Promise<readonly ArdentInputImage[]> | readonly ArdentInputImage[];
  /** Build evidence from retained receipts, never from the model's completion claim. */
  teamEvidence?(ctx: ArdentPluginContext, task: Task, envelope: TeamEnvelope, events: readonly TaskEvent[]): ArdentTeamEvidence;
  /** Describe private role capabilities; discovery remains information, never authorization. */
  teamCard?(ctx: ArdentPluginContext, card: HermesTeamCard): Promise<HermesTeamCard> | HermesTeamCard;
  /** Verify external consumer ownership before any gateway intake resumes. */
  prepareGateway?(ctx: ArdentPluginContext): Promise<void> | void;
  /** Start owned background consumers only in gateway mode. */
  start?(ctx: ArdentPluginContext): Promise<void> | void;
  /** Stop private intake and await owned work; false retains unsettled ownership. */
  drain?(ctx: ArdentPluginContext, timeoutMs: number): Promise<boolean>;
  /** Synchronous cleanup after drain, before the shared journal closes. */
  close?(ctx: ArdentPluginContext): void;
}

const pluginName = /^[a-z][a-z0-9-]{0,63}$/;
const registered: ArdentPlugin[] = [];

/** Identity helper that type-checks a plugin definition. */
export function definePlugin(plugin: ArdentPlugin): ArdentPlugin {
  return plugin;
}

function isPluginFactory(value: unknown): value is ArdentPluginFactory { return typeof value === 'function'; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlugin(plugin: unknown, source: string): asserts plugin is ArdentPlugin {
  if (!isRecord(plugin) || typeof plugin.name !== 'string' || !pluginName.test(plugin.name))
    throw new Error(`Plugin ${source} must export an object with a lowercase name`);
  for (const hook of ['registerTools', 'routes', 'jobHandlers', 'jobOwnership', 'peerTool', 'taskTools', 'filterTool', 'teamEnvelope', 'admitTeamEnvelope', 'channelAdapter', 'httpRoutes', 'systemPrompt', 'allowMemory', 'observeToolResult', 'messageReceived', 'messagePersisted', 'transformOutbound', 'messageDelivered', 'beforeToolCall', 'afterToolCall', 'toolCallCancelled', 'beforeFinish', 'taskSettled', 'taskExecutor', 'inputImages', 'teamEvidence', 'teamCard', 'prepareGateway', 'start', 'drain', 'close'])
    if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function')
      throw new Error(`Plugin ${plugin.name} hook ${hook} must be a function`);
  if (plugin.cliCommands !== undefined) {
    if (!isRecord(plugin.cliCommands)) throw new Error(`Plugin ${plugin.name} cliCommands must be an object`);
    for (const [name, command] of Object.entries(plugin.cliCommands))
      if (!pluginName.test(name) || !isRecord(command) || typeof command.run !== 'function' || command.matches !== undefined && typeof command.matches !== 'function')
        throw new Error(`Plugin ${plugin.name} CLI command ${name} is invalid`);
      else if (command.valueOptions !== undefined && (!Array.isArray(command.valueOptions) || command.valueOptions.length > 64 || command.valueOptions.some((value: unknown) => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))))
        throw new Error(`Plugin ${plugin.name} CLI command ${name} has invalid value options`);
  }
}

function validate(plugin: unknown, source: string): ArdentPlugin {
  assertPlugin(plugin, source);
  return plugin;
}

/** Register a plugin programmatically (for embedders that construct Ardent themselves). */
export function registerPlugin(plugin: ArdentPlugin): void {
  const valid = validate(plugin, 'registerPlugin');
  if (registered.some(item => item.name === valid.name)) throw new Error(`Duplicate plugin: ${valid.name}`);
  registered.push(valid);
}

/** Programmatically registered plugins. */
export function registeredPlugins(): readonly ArdentPlugin[] { return [...registered]; }

/** Remove programmatic registrations (tests and embedders). */
export function clearRegisteredPlugins(): void { registered.length = 0; }

async function importSpecifier(specifier: string, profileDir: string): Promise<unknown> {
  if (specifier.startsWith('file://')) return import(specifier);
  if (isAbsolute(specifier)) return import(pathToFileURL(specifier).href);
  // Resolve a package from the profile directory first, so a plugin may be
  // installed next to the profile rather than next to Ardent itself.
  try {
    const resolved = createRequire(join(profileDir, 'package.json')).resolve(specifier);
    return await import(pathToFileURL(resolved).href);
  } catch (error: unknown) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND')) throw error;
    return import(specifier);
  }
}

/**
 * Load the plugins named by `config.plugins`, plus any registered
 * programmatically. A module's default export (or named `plugin` export) may
 * be one plugin or an array of plugins.
 */
export async function loadPlugins(config: ArdentConfig, profileDir: string, env: NodeJS.ProcessEnv = process.env): Promise<ArdentPlugin[]> {
  const plugins: ArdentPlugin[] = [...registered];
  for (const specifier of config.plugins) {
    const module: unknown = await importSpecifier(specifier, profileDir);
    if (!isRecord(module)) throw new Error(`Plugin ${specifier} did not load as a module`);
    const exported: unknown = module.default ?? module.plugin;
    const configured: unknown = isPluginFactory(exported)
      ? await exported({ config, profileDir, env }) : exported;
    for (const item of Array.isArray(configured) ? configured : [configured]) {
      const plugin = validate(item, specifier);
      if (plugins.some(existing => existing.name === plugin.name)) throw new Error(`Duplicate plugin: ${plugin.name}`);
      plugins.push(plugin);
    }
  }
  return plugins;
}

/**
 * Context for offline job-definition validation (`ardent jobs definitions
 * validate`). No runtime exists there, so `runtime` and `tools` throw; a
 * plugin's `jobHandlers` must only touch them inside `run`.
 */
class ValidationContext implements ArdentPluginContext {
  readonly runtimeAvailable = false;
  readonly defineTool = defineTool;
  constructor(readonly config: ArdentConfig, readonly profileDir: string, readonly env: NodeJS.ProcessEnv) {}
  get runtime(): ArdentRuntime { throw new Error('The Ardent runtime is unavailable during offline validation'); }
  get tools(): ToolRegistry { throw new Error('The tool registry is unavailable during offline validation'); }
}
export function validationContext(config: ArdentConfig, profileDir: string, env: NodeJS.ProcessEnv): ArdentPluginContext {
  return new ValidationContext(config, profileDir, env);
}

export function pluginContext(runtime: ArdentRuntime, env: NodeJS.ProcessEnv): ArdentPluginContext {
  return { runtimeAvailable: true, runtime, config: runtime.config, profileDir: runtime.profileDir, env, tools: runtime.tools, defineTool };
}

/** A codec cannot change authenticated identity, constraints, resources, or core actions. */
export function pluginTeamEnvelope(plugins: readonly ArdentPlugin[], value: unknown): TeamEnvelope {
  const raw = TeamEnvelope.extend({ mission: TeamMissionShape.extend({ allowed_actions: z.array(z.string()).min(1).max(8) }).passthrough() }).parse(value);
  const candidates = plugins.flatMap(plugin => {
    // Each codec gets a separate copy; neither the bindings nor another codec's
    // input may change when a plugin normalizes its private wire vocabulary.
    const envelope = plugin.teamEnvelope?.(structuredClone(raw));
    return envelope === undefined ? [] : [{ plugin, envelope: TeamEnvelope.parse(envelope) }];
  });
  if (candidates.length > 1) throw new Error('Multiple plugins claimed the team envelope');
  const selected = candidates[0];
  if (!selected) {
    const envelope = TeamEnvelope.parse(raw);
    if (envelope.mission.extensions && Object.keys(envelope.mission.extensions).length ||
        envelope.mission.allowed_actions.some(action => action.startsWith('extension:')))
      throw new Error('Team extension has no configured validator');
    return envelope;
  }
  const canonical = selected.envelope;
  const { allowed_actions: rawActions, extensions: _rawExtensions, ...rawMission } = raw.mission;
  const { allowed_actions: actions, extensions, ...mission } = canonical.mission;
  const bindings = ['id', 'revision', 'parent_task', 'constraints', 'resources', 'deadline', 'acceptance_criteria', 'expected_artifacts'] as const;
  if (canonical.version !== raw.version || canonical.caller !== raw.caller || canonical.task_id !== raw.task_id || canonical.objective !== raw.objective ||
      bindings.some(key => JSON.stringify(mission[key]) !== JSON.stringify(rawMission[key])))
    throw new Error('Plugin changed a team envelope binding');
  if (extensions && Object.keys(extensions).some(key => key !== selected.plugin.name)) throw new Error('Plugin claimed another extension namespace');
  if (actions.length !== rawActions.length || actions.some((action, index) =>
      action.startsWith('extension:') && !action.startsWith(`extension:${selected.plugin.name}:`) ||
      action !== rawActions[index] && action !== `extension:${selected.plugin.name}:${rawActions[index]}`))
    throw new Error('Plugin changed a team action grant');
  return canonical;
}

/** Merge plugin job handlers into a base registry; a duplicate handler ID is an error. */
export function pluginJobHandlers(plugins: readonly ArdentPlugin[], ctx: ArdentPluginContext, base: JobRegistry = {}): JobRegistry {
  const registry: JobRegistry = { ...base };
  for (const plugin of plugins) for (const [id, handler] of Object.entries(plugin.jobHandlers?.(ctx) ?? {})) {
    if (id in registry) throw new Error(`Duplicate job handler ${id} from plugin ${plugin.name}`);
    registry[id] = handler;
  }
  return registry;
}

export function pluginChannelAdapter(plugins: readonly ArdentPlugin[], ctx: ArdentPluginContext, channel: 'telegram' | 'mattermost', jobs?: JobEngine): ArdentChannelAdapter | undefined {
  const adapters = plugins.flatMap(plugin => {
    const adapter = plugin.channelAdapter?.(ctx, channel, jobs);
    if (adapter !== undefined && typeof adapter.run !== 'function') throw new Error(`Plugin ${plugin.name} returned an invalid channel adapter`);
    return adapter ? [adapter] : [];
  });
  if (adapters.length > 1) throw new Error(`Multiple plugins own the ${channel} consumer`);
  return adapters[0];
}

/** Task additions cannot bypass context, preview effect, peer grant or restrictive filters. */
export function pluginTaskTools(plugins: readonly ArdentPlugin[], ctx: ArdentTaskPluginContext): ToolRegistry {
  if (ctx.task.context === 'mission' && !ctx.envelope) throw new Error('Mission task has no recorded mission');
  const tools = new Map(ctx.baseTools.map(tool => [tool.name, tool]));
  for (const plugin of plugins) {
    const additions = plugin.taskTools?.(ctx) ?? [];
    const raw: unknown = additions;
    if (!Array.isArray(raw)) throw new Error(`Plugin ${plugin.name} taskTools must return an array`);
    for (const tool of additions) {
      if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(tool.name) ||
          !['read', 'artifact-write', 'memory-write', 'external-write'].includes(tool.effect) ||
          !Array.isArray(tool.contexts) || !tool.contexts.every((context: unknown) => typeof context === 'string' && ['direct', 'peer', 'scheduled', 'mission', 'preview'].includes(context)) ||
          !Number.isSafeInteger(tool.timeoutMs) || tool.timeoutMs < 1 || typeof tool.invoke !== 'function' ||
          typeof tool.input?.safeParse !== 'function' || typeof tool.output?.parse !== 'function') throw new Error(`Plugin ${plugin.name} returned an invalid task tool`);
      if (!tool.contexts.includes(ctx.task.context) || (ctx.task.context === 'preview' && tool.effect !== 'read')) continue;
      if (ctx.task.context === 'peer' || ctx.task.context === 'mission') {
        if (!ctx.envelope?.mission.resources.includes(`tool:${tool.name}`) && plugin.peerTool?.(tool, ctx.task, ctx.envelope) !== true) continue;
      }
      const prior = tools.get(tool.name);
      if (prior && prior !== tool) throw new Error(`Duplicate task tool: ${tool.name}`);
      tools.set(tool.name, tool);
    }
  }
  const registry = new ToolRegistry();
  for (const tool of tools.values()) if (plugins.every(plugin => plugin.filterTool?.(ctx, tool) !== false)) registry.register(tool);
  return registry;
}

/** The longest a lifecycle hook may run before it counts as failed. */
export const PLUGIN_HOOK_TIMEOUT_MS = 5_000;
/** The largest text `transformOutbound` may return. */
export const MAX_OUTBOUND_TEXT_BYTES = 64 * 1024;
export type PluginHookName = 'observeToolResult' | 'messageReceived' | 'messagePersisted' | 'transformOutbound' | 'messageDelivered' | 'beforeToolCall' | 'afterToolCall' | 'toolCallCancelled';
/** Records a failed hook (`plugin_hook_failed`); it must not throw. */
export type PluginHookFailureSink = (plugin: string, hook: PluginHookName) => void;

/** A deep-frozen copy, so a hook cannot change what the runtime keeps using. */
export function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    if (ArrayBuffer.isView(item)) return; // Typed arrays cannot be frozen; they are already copies.
    Object.freeze(item);
    for (const key of Reflect.ownKeys(item)) freeze(Reflect.get(item, key));
  };
  freeze(copy);
  return copy;
}

async function bounded<T>(run: () => T | Promise<T>, timeoutMs = PLUGIN_HOOK_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Plugin hook timed out')), timeoutMs); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Run one observer hook on every plugin, in registration order (reverse for
 * cleanup). A throw, rejection or timeout is reported and never propagates.
 */
export async function runPluginObservers(plugins: readonly ArdentPlugin[], hook: PluginHookName,
  invoke: (plugin: ArdentPlugin) => unknown, onFailure: PluginHookFailureSink, options: { reverse?: boolean } = {}): Promise<void> {
  for (const plugin of options.reverse ? [...plugins].reverse() : plugins) {
    if (typeof plugin[hook] !== 'function') continue;
    try { await bounded(() => invoke(plugin)); }
    catch { try { onFailure(plugin.name, hook); } catch { /* A failure record must not fail the caller. */ } }
  }
}

/** Synchronous `observeToolResult`: a throw is reported and ignored. */
export function observePluginToolResult(plugins: readonly ArdentPlugin[], ctx: ArdentTaskPluginContext, name: string,
  result: ToolResult, evidence: TaskEvidence, onFailure: PluginHookFailureSink): void {
  for (const plugin of plugins) {
    if (!plugin.observeToolResult) continue;
    try { plugin.observeToolResult(ctx, name, result, evidence); }
    catch { try { onFailure(plugin.name, 'observeToolResult'); } catch { /* ignored */ } }
  }
}

const denialCode = /^[A-Z][A-Z0-9_]{1,63}$/;
/**
 * Ask every plugin, in registration order, whether a validated call may run.
 * The first denial wins. A throw, timeout or malformed denial denies the call.
 */
export async function pluginBeforeToolCall(plugins: readonly ArdentPlugin[], ctx: ArdentTaskPluginContext, call: ArdentToolCall,
  onFailure: PluginHookFailureSink): Promise<{ plugin: string; code: string; message: string } | undefined> {
  for (const plugin of plugins) {
    const hook = plugin.beforeToolCall;
    if (!hook) continue;
    let verdict: unknown;
    try { verdict = await bounded(() => hook.call(plugin, ctx, frozenCopy(call))); }
    catch {
      try { onFailure(plugin.name, 'beforeToolCall'); } catch { /* ignored */ }
      return { plugin: plugin.name, code: 'TOOL_DENIED_BY_PLUGIN', message: `Plugin ${plugin.name} could not approve this call` };
    }
    if (!verdict || typeof verdict !== 'object' || !('deny' in verdict)) continue;
    const parsed = z.object({ deny: z.object({ code: z.string().regex(denialCode), message: z.string().min(1).max(1000) }) }).safeParse(verdict);
    return parsed.success ? { plugin: plugin.name, ...parsed.data.deny }
      : { plugin: plugin.name, code: 'TOOL_DENIED_BY_PLUGIN', message: `Plugin ${plugin.name} denied this call` };
  }
  return undefined;
}

/**
 * Chain `transformOutbound` in registration order. Any throw, timeout or
 * invalid text (empty or over 64 KiB) fails closed to the original text.
 */
export async function pluginTransformOutbound(plugins: readonly ArdentPlugin[], ctx: ArdentPluginContext, delivery: ArdentChannelDelivery,
  onFailure: PluginHookFailureSink): Promise<{ text: string; plugins: string[] }> {
  let text = delivery.text;
  const applied: string[] = [];
  for (const plugin of plugins) {
    const hook = plugin.transformOutbound;
    if (!hook) continue;
    let output: unknown;
    try { output = await bounded(() => hook.call(plugin, ctx, frozenCopy({ ...delivery, text }))); }
    catch { output = null; }
    if (output === undefined) continue;
    const parsed = z.object({ text: z.string().refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= MAX_OUTBOUND_TEXT_BYTES) }).safeParse(output);
    if (!parsed.success) {
      try { onFailure(plugin.name, 'transformOutbound'); } catch { /* ignored */ }
      return { text: delivery.text, plugins: [] };
    }
    if (parsed.data.text !== text) applied.push(plugin.name);
    text = parsed.data.text;
  }
  return { text, plugins: applied };
}
