import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Hono } from 'hono';
import type { ArdentConfig } from './config.js';
import type { JobRegistry, OwnershipCheck } from './job-engine.js';
import type { ArdentRuntime } from './runtime.js';
import type { Task } from './store.js';
import { defineTool, type Tool, type ToolRegistry } from './tools.js';
import type { TeamEnvelope } from './team-contract.js';

/** Everything a plugin may use. Plugins receive no authority beyond the profile's own runtime. */
export type ArdentPluginContext = {
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
  options: ReadonlyMap<string, string | true>;
  profileDir: string;
  config: ArdentConfig;
  env: NodeJS.ProcessEnv;
  /** Print a JSON value to stdout. */
  print(value: unknown): void;
};
export type ArdentCliCommand = {
  description: string;
  run(invocation: ArdentCliInvocation): Promise<void>;
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
  /** Called with a validation context (no runtime) by `ardent jobs definitions validate`; use `ctx.runtime` only inside `run`. */
  routes?(app: Hono, ctx: ArdentPluginContext): void;
  cliCommands?: Record<string, ArdentCliCommand>;
  /** Also called with a runtime-less validation context by `ardent jobs definitions validate`; touch `ctx.runtime` only inside `run`. */
  jobHandlers?(ctx: ArdentPluginContext): JobRegistry;
  jobOwnership?(ctx: ArdentPluginContext): OwnershipCheck;
  peerTool?(tool: Tool, task: Task, envelope: TeamEnvelope | undefined): boolean;
}

const pluginName = /^[a-z][a-z0-9-]{0,63}$/;
const registered: ArdentPlugin[] = [];

/** Identity helper that type-checks a plugin definition. */
export function definePlugin(plugin: ArdentPlugin): ArdentPlugin {
  return plugin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlugin(plugin: unknown, source: string): asserts plugin is ArdentPlugin {
  if (!isRecord(plugin) || typeof plugin.name !== 'string' || !pluginName.test(plugin.name))
    throw new Error(`Plugin ${source} must export an object with a lowercase name`);
  for (const hook of ['registerTools', 'routes', 'jobHandlers', 'jobOwnership', 'peerTool'])
    if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function')
      throw new Error(`Plugin ${plugin.name} hook ${hook} must be a function`);
  if (plugin.cliCommands !== undefined) {
    if (!isRecord(plugin.cliCommands)) throw new Error(`Plugin ${plugin.name} cliCommands must be an object`);
    for (const [name, command] of Object.entries(plugin.cliCommands))
      if (!pluginName.test(name) || !isRecord(command) || typeof command.run !== 'function')
        throw new Error(`Plugin ${plugin.name} CLI command ${name} is invalid`);
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
export async function loadPlugins(config: ArdentConfig, profileDir: string): Promise<ArdentPlugin[]> {
  const plugins: ArdentPlugin[] = [...registered];
  for (const specifier of config.plugins) {
    const module: unknown = await importSpecifier(specifier, profileDir);
    if (!isRecord(module)) throw new Error(`Plugin ${specifier} did not load as a module`);
    const exported: unknown = module.default ?? module.plugin;
    for (const item of Array.isArray(exported) ? exported : [exported]) {
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
  readonly defineTool = defineTool;
  constructor(readonly config: ArdentConfig, readonly profileDir: string, readonly env: NodeJS.ProcessEnv) {}
  get runtime(): ArdentRuntime { throw new Error('The Ardent runtime is unavailable during offline validation'); }
  get tools(): ToolRegistry { throw new Error('The tool registry is unavailable during offline validation'); }
}
export function validationContext(config: ArdentConfig, profileDir: string, env: NodeJS.ProcessEnv): ArdentPluginContext {
  return new ValidationContext(config, profileDir, env);
}

export function pluginContext(runtime: ArdentRuntime, env: NodeJS.ProcessEnv): ArdentPluginContext {
  return { runtime, config: runtime.config, profileDir: runtime.profileDir, env, tools: runtime.tools, defineTool };
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
