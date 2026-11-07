import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, copyFile, chmod, cp, open, unlink, lstat, rm, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';

const envName = /^[A-Z][A-Z0-9_]*$/;
const pathName = /^[A-Za-z0-9._-]+\.md$/;
function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
}
const urlReference = z.string().min(1).max(2048).refine(value => /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value) || safeUrl(value), 'Expected an HTTP(S) URL without embedded credentials or an environment reference');
const provider = z.object({ base_url: urlReference, model: z.string().min(1).max(200), api_key_env: z.string().regex(envName), request_timeout_seconds: z.number().int().min(1).max(600), context_window_tokens: z.number().int().min(2048).max(2_000_000).optional(), max_output_tokens: z.number().int().min(256).max(32768).optional(), reasoning_effort: z.enum(['none', 'low', 'medium', 'xhigh']).optional() }).strict();

/** The host's IANA timezone, or UTC when it cannot be determined. */
export function systemTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
const ianaTimezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}, 'Unknown IANA timezone');

const NoMemory = z.object({ provider: z.literal('none') }).strict();
export const HiveMemConfigSchema = z.object({ provider: z.literal('hivemem'), base_url: urlReference, token_env: z.string().regex(envName), agent_id: z.string().min(1).max(100), workspace_id: z.string().min(1).max(100), default_scope: z.enum(['private', 'project']).default('private') }).strict();
export type HiveMemConfig = z.infer<typeof HiveMemConfigSchema>;

const TelegramChannel = z.object({ enabled: z.boolean().default(false), token_env: z.string().regex(envName).default('TELEGRAM_BOT_TOKEN'), allowed_user_ids: z.array(z.number().int().positive()).default([]), allowed_chat_ids: z.array(z.number().int()).default([]), receive_mode: z.literal('polling').default('polling') }).strict();
const MattermostChannel = z.object({ enabled: z.boolean().default(false), base_url: urlReference.default('${MATTERMOST_URL}'), token_env: z.string().regex(envName).default('MATTERMOST_TOKEN'), allowed_user_ids: z.array(z.string().min(1)).default([]), allowed_channel_ids: z.array(z.string().min(1)).default([]), require_mention: z.boolean().default(true), reply_mode: z.enum(['thread', 'flat']).default('thread') }).strict();
/** A plugin module specifier: an npm package name, or an absolute path / file URL to an ES module. */
const pluginSpecifier = z.string().min(1).max(500).refine(value =>
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/.test(value) || value.startsWith('/') || value.startsWith('file://'),
'Expected an npm package name, an absolute path, or a file:// URL');
const magnusControlDefault = { enabled: false, base_url: '${ARDENT_MAGNUS_API_URL}', token_env: 'ARDENT_MAGNUS_READ_TOKEN' };
const a2aRateLimitDefault = { enabled: true, ip_requests_per_minute: 600, ip_burst: 120, peer_requests_per_minute: 300, peer_burst: 60, max_concurrent_tasks_per_peer: 16, trusted_proxies: [] as string[] };
const a2aDefault = { rate_limit: a2aRateLimitDefault, enabled: false, protocol_version: '1.0' as const, bindings: ['jsonrpc' as const, 'http-json' as const], public_url: '${ARDENT_A2A_PUBLIC_URL}', listen_host: '127.0.0.1', peers_file: 'peers.yaml', hermes_compat: false };
const researchDefault = { enabled: false, searxng_url: '${ARDENT_SEARXNG_URL}', firecrawl_url: '${ARDENT_FIRECRAWL_URL}', firecrawl_token_env: 'FIRECRAWL_API_KEY' };

export const ConfigSchema = z.object({
  schema_version: z.literal(1),
  profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().min(1).max(100),
  product: z.string().min(1).max(100).default('Ardent'),
  /** IANA timezone for schedules and dates shown to the model. Defaults to the host zone. */
  timezone: ianaTimezone.default(systemTimezone),
  identity: z.object({ soul_file: z.string().regex(pathName).default('SOUL.md'), identity_file: z.string().regex(pathName).default('IDENTITY.md') }).strict().default({ soul_file: 'SOUL.md', identity_file: 'IDENTITY.md' }),
  execution: z.object({ backend: z.enum(['llamacpp', 'codex']), max_model_steps: z.number().int().min(1).max(200), max_tool_calls: z.number().int().min(0).max(500), max_parallel_tools: z.number().int().min(1).max(16), deadline_seconds: z.number().int().min(1).max(86400), max_delegation_depth: z.number().int().min(0).max(8) }).strict(),
  providers: z.object({ llamacpp: provider, codex: z.object({ command: z.string().min(1).max(500), model: z.string().min(1).max(200), auth_mode: z.enum(['chatgpt', 'api_key']).default('chatgpt'), approval_policy: z.literal('never'), sandbox: z.literal('read-only') }).strict() }).strict(),
  /** Long-term memory. `none` (default) disables memory tools; `hivemem` uses a HiveMem server. */
  memory: z.discriminatedUnion('provider', [NoMemory, HiveMemConfigSchema]).default({ provider: 'none' }),
  research: z.object({ enabled: z.boolean().default(false), searxng_url: urlReference.default('${ARDENT_SEARXNG_URL}'), firecrawl_url: urlReference.default('${ARDENT_FIRECRAWL_URL}'), firecrawl_token_env: z.string().regex(envName).default('FIRECRAWL_API_KEY') }).strict().default(researchDefault),
  skills: z.object({ directories: z.array(z.string().regex(/^[A-Za-z0-9._/-]+$/)).max(16).default(['skills']), enabled: z.array(z.string().min(1).max(100)).max(100).default([]) }).strict().default({ directories: ['skills'], enabled: [] }),
  a2a: z.object({ enabled: z.boolean().default(false), protocol_version: z.literal('1.0').default('1.0'), bindings: z.array(z.enum(['jsonrpc', 'http-json', 'grpc'])).min(1).default(['jsonrpc', 'http-json']), public_url: urlReference.default('${ARDENT_A2A_PUBLIC_URL}'), listen_host: z.string().min(1).default('127.0.0.1'), listen_port: z.number().int().min(1).max(65534).optional(), peers_file: z.string().regex(/^[A-Za-z0-9._-]+\.yaml$/).default('peers.yaml'),
    /** Serve Hermes Agent team-card discovery and slash-style JSON-RPC method aliases. */
    hermes_compat: z.boolean().default(false),
    /** Request and task limits. `trusted_proxies` lists the reverse proxies whose X-Forwarded-For is believed; by default none is. */
    rate_limit: z.object({ enabled: z.boolean().default(true), ip_requests_per_minute: z.number().int().min(1).max(1_000_000).default(600), ip_burst: z.number().int().min(1).max(1_000_000).default(120), peer_requests_per_minute: z.number().int().min(1).max(1_000_000).default(300), peer_burst: z.number().int().min(1).max(1_000_000).default(60), max_concurrent_tasks_per_peer: z.number().int().min(1).max(100_000).default(16), trusted_proxies: z.array(z.string().min(1).max(64)).max(64).default([]) }).strict().default(a2aRateLimitDefault),
    /** Agent Card skill advertised to peers. */
    skill: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: z.string().min(1).max(100), description: z.string().min(1).max(500), tags: z.array(z.string().min(1).max(40)).max(10).default([]), example: z.string().min(1).max(300).optional() }).strict().optional() }).strict().default(a2aDefault),
  channels: z.object({ telegram: TelegramChannel.default(TelegramChannel.parse({})), mattermost: MattermostChannel.default(MattermostChannel.parse({})) }).strict().default({ telegram: TelegramChannel.parse({}), mattermost: MattermostChannel.parse({}) }),
  integrations: z.object({
    /** Optional read-only Magnus Control tools. URL and token come only from config or the environment. */
    magnus_control: z.object({ enabled: z.boolean().default(false), base_url: urlReference.default('${ARDENT_MAGNUS_API_URL}'), token_env: z.string().regex(envName).default('ARDENT_MAGNUS_READ_TOKEN') }).strict().default(magnusControlDefault)
  }).strict().default({ magnus_control: magnusControlDefault }),
  /** Plugin modules loaded by the gateway (npm package names, absolute paths, or file:// URLs). */
  plugins: z.array(pluginSpecifier).max(32).default([]),
  api: z.object({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(9910), token_env: z.string().regex(envName).default('ARDENT_API_TOKEN') }).strict().default({ host: '127.0.0.1', port: 9910, token_env: 'ARDENT_API_TOKEN' })
}).strict();

export type ArdentConfig = z.infer<typeof ConfigSchema>;
export type Profile = { name: string; path: string };
export type LoadedConfig = { config: ArdentConfig; revision: string; text: string; path: string };

export function ardentHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ARDENT_HOME ?? join(homedir(), '.ardent'));
}

export const DEFAULT_PROFILE = 'assistant';

export function profilePath(name = DEFAULT_PROFILE, override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override) {
    if (!isAbsolute(override)) throw new Error('Profile path override must be absolute');
    return resolve(override);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid profile name');
  return join(ardentHome(env), 'profiles', name);
}

export function revision(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export function parseConfig(text: string): ArdentConfig {
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Invalid YAML: ${doc.errors[0]?.message ?? 'unknown error'}`);
  const value: unknown = doc.toJS();
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid Ardent config: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export async function loadConfig(dir: string): Promise<LoadedConfig> {
  const path = join(dir, 'config.yaml');
  const text = await readFile(path, 'utf8');
  return { config: parseConfig(text), revision: revision(text), text, path };
}

export function resolveReference(value: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const match = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(value);
  if (!match) return value;
  return env[match[1] ?? ''];
}

export function runtimeProblems(config: ArdentConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const need = (field: string, value: string): string | undefined => {
    const found = resolveReference(value, env);
    if (!found) problems.push(`${field} is unresolved`);
    return found;
  };
  if (config.execution.backend === 'llamacpp') {
    const base = need('providers.llamacpp.base_url', config.providers.llamacpp.base_url);
    need('providers.llamacpp.model', config.providers.llamacpp.model);
    if (base && !safeUrl(base)) problems.push('providers.llamacpp.base_url must be a credential-free HTTP(S) URL');
  } else need('providers.codex.model', config.providers.codex.model);
  if (config.channels.telegram.enabled && !env[config.channels.telegram.token_env]) problems.push('Telegram token is missing');
  if (config.channels.mattermost.enabled && !env[config.channels.mattermost.token_env]) problems.push('Mattermost token is missing');
  if (config.channels.mattermost.enabled) need('channels.mattermost.base_url', config.channels.mattermost.base_url);
  if (config.a2a.enabled) need('a2a.public_url', config.a2a.public_url);
  if (config.memory.provider === 'hivemem') {
    need('memory.base_url', config.memory.base_url);
    if (!env[config.memory.token_env]) problems.push('HiveMem token is missing');
  }
  if (config.research.enabled) {
    need('research.searxng_url', config.research.searxng_url);
    need('research.firecrawl_url', config.research.firecrawl_url);
  }
  if (magnusControlEnabled(config, env)) {
    need('integrations.magnus_control.base_url', config.integrations.magnus_control.base_url);
    if (!env[config.integrations.magnus_control.token_env]) problems.push('Magnus Control read token is missing');
  }
  return problems;
}

export function redactedConfig(config: ArdentConfig): ArdentConfig {
  return structuredClone(config); // Values are references only; no resolution is performed here.
}

/** Optional Magnus Control read tools are enabled by config or `ARDENT_MAGNUS_CONTROL_TOOLS=true`. */
export function magnusControlEnabled(config: ArdentConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return config.integrations.magnus_control.enabled || env.ARDENT_MAGNUS_CONTROL_TOOLS === 'true';
}

const templates = fileURLToPath(new URL('../profiles/', import.meta.url));
/** The bundled neutral profile template copied by `ardent init`. */
export const PROFILE_TEMPLATE = 'assistant';
export async function initProfile(dir: string, options: { profile?: string; apiPort?: number; template?: string } = {}): Promise<void> {
  const profile = options.profile ?? DEFAULT_PROFILE;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw new Error('Invalid profile name');
  const apiPort = options.apiPort ?? 9910;
  if (!Number.isSafeInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw new Error('Profile API port must be 1024-65535');
  const target = resolve(dir);
  const templateName = options.template ?? PROFILE_TEMPLATE;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(templateName)) throw new Error('Invalid profile template');
  const template = join(templates, templateName);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = join(parent, `.ardent-init-${createHash('sha256').update(target).digest('hex').slice(0, 24)}.lock`);
  const lock = await open(lockPath, 'wx', 0o600).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new Error('Profile initialization is already in progress');
    throw error;
  });
  const staged = join(parent, `.${profile}.${randomUUID()}.staging`);
  try {
    const existing = await lstat(target).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing && (!existing.isDirectory() || (await readdir(target)).length > 0)) throw new Error('Profile path already exists');
    await mkdir(staged, { mode: 0o700 });
    for (const name of ['SOUL.md', 'IDENTITY.md', 'peers.yaml']) {
      await copyFile(join(template, name), join(staged, name));
      await chmod(join(staged, name), 0o600);
    }
    const document = YAML.parseDocument(await readFile(join(template, 'config.yaml'), 'utf8'));
    document.set('profile', profile);
    if (profile !== templateName) document.set('name', profile);
    if (!document.has('timezone')) document.set('timezone', systemTimezone());
    document.setIn(['api', 'port'], apiPort);
    const text = String(document);
    parseConfig(text);
    await writeFile(join(staged, 'config.yaml'), text, { flag: 'wx', mode: 0o600 });
    await writeFile(join(staged, '.env'), `ARDENT_API_TOKEN=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    for (const name of ['workspace', 'state', 'artifacts', 'logs']) await mkdir(join(staged, name), { mode: 0o700 });
    await cp(join(template, 'skills'), join(staged, 'skills'), { recursive: true, force: false, errorOnExist: true });
    await rename(staged, target);
  } finally {
    await rm(staged, { recursive: true, force: true });
    await lock.close();
    await unlink(lockPath);
  }
}

export async function saveConfig(dir: string, nextText: string, expectedRevision: string): Promise<string> {
  const path = join(dir, 'config.yaml');
  const lockPath = join(dir, '.config.write.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new Error('Configuration edit is already in progress');
    throw error;
  });
  let tmp: string | undefined;
  try {
    const current = await loadConfig(dir);
    if (current.revision !== expectedRevision) throw new Error('Configuration revision conflict');
    parseConfig(nextText);
    tmp = join(dirname(path), `.config.${randomUUID()}.tmp`);
    await writeFile(tmp, nextText, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
    tmp = undefined;
    return revision(nextText);
  } finally {
    if (tmp) await unlink(tmp).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
