import { classifyRetry, DEFAULT_RETRY_POLICY, readRetrySignal, retry, retryAfterFromHeaders, RetryExhaustedError, type RetryPolicy } from '@hivemagnus/hive-common/retry';
import { parseHiveError } from '@hivemagnus/hive-common/errors';
import type { ExecutionContext } from '@hivemagnus/hive-common/execution';
import { ArdentClientError, ConflictError, NotFoundError, TransportError, UnauthorizedError, UnsupportedCapabilityError } from './errors.js';

/** Returns the bearer token. `refresh` is true once after a 401: return a fresh token then. */
export type TokenProvider = (context: { readonly refresh: boolean }) => string | Promise<string>;
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface DirectTransportOptions {
  /** The Ardent management API origin (and path prefix, if a proxy adds one), e.g. `http://127.0.0.1:9910`. */
  readonly baseUrl: string;
  readonly getToken: TokenProvider;
  /** Extra headers for every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

interface MagnusTarget {
  /** The managed node that runs the profile. */
  readonly nodeId: string;
  /** The Ardent profile on that node. */
  readonly profile: string;
  readonly getToken: TokenProvider;
  /** Extra headers for every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

/**
 * Where Magnus is: either its origin (`baseUrl`; the client adds `/api/v1`) or the API root itself
 * (`apiBase`, e.g. a Hive console's `https://console.example.com/api/magnus`, where the console
 * serves Magnus's `/api/v1`). Give exactly one.
 */
export type MagnusTransportOptions = MagnusTarget & (
  | { /** The Magnus Control API origin, e.g. `https://magnus.example.com`. */ readonly baseUrl: string; readonly apiBase?: undefined }
  | { /** The Magnus API root, the URL that stands for Magnus's `/api/v1`, e.g. `https://console.example.com/api/magnus`. */ readonly apiBase: string; readonly baseUrl?: undefined }
);

/** The options a Magnus transport carries once `viaMagnus()` has checked them: `apiBase` is always set. */
export type ResolvedMagnusTransportOptions = MagnusTarget & { readonly baseUrl?: string | undefined; readonly apiBase: string };

/** How the client reaches a profile: built by `direct()` or `viaMagnus()`. */
export interface ArdentTransport {
  readonly kind: 'direct' | 'magnus';
  readonly options: DirectTransportOptions | ResolvedMagnusTransportOptions;
}

/** Talk to a standalone Ardent management API. */
export function direct(options: DirectTransportOptions): ArdentTransport {
  return { kind: 'direct', options: { ...options, baseUrl: checkedBase(options.baseUrl) } };
}

/**
 * Talk to a Magnus-managed profile through the Magnus Control API
 * (`/api/v1/ardent/installations/:nodeId/profiles/:profile/...`). Give Magnus's origin as
 * `baseUrl`, or, behind a proxy that serves Magnus's `/api/v1` under another path (a Hive
 * console's `/api/magnus`), that path as `apiBase`. Only routes Magnus allows are available;
 * the others raise `UnsupportedCapabilityError`.
 */
export function viaMagnus(options: MagnusTransportOptions): ArdentTransport {
  for (const [name, value] of [['nodeId', options.nodeId], ['profile', options.profile]] as const)
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new ArdentClientError('invalid_request', `Invalid Magnus ${name}`, { status: 400 });
  const { baseUrl, apiBase } = options as { baseUrl?: unknown; apiBase?: unknown };
  if ((baseUrl === undefined) === (apiBase === undefined))
    throw new ArdentClientError('invalid_request', 'Give viaMagnus either baseUrl (the Magnus origin) or apiBase (the Magnus API root), not both', { status: 400 });
  if (apiBase !== undefined) return { kind: 'magnus', options: { ...options, apiBase: checkedBase(apiBase, 'apiBase') } };
  const origin = checkedBase(baseUrl, 'baseUrl');
  return { kind: 'magnus', options: { ...options, baseUrl: origin, apiBase: `${origin}/api/v1` } };
}

function checkedBase(value: unknown, name = 'baseUrl'): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new ArdentClientError('invalid_request', `${name} must be an absolute http(s) URL`, { status: 400 }); }
  if (typeof value !== 'string' || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new ArdentClientError('invalid_request', `${name} must be an absolute http(s) URL`, { status: 400 });
  if (url.username || url.password) throw new ArdentClientError('invalid_request', `${name} must not carry credentials; use getToken`, { status: 400 });
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** Routes that need a capability Magnus or an older Ardent may lack. */
export type Gate = 'recovery' | 'lineage' | 'artifact_transfer' | 'task_filters';
/** The level each gate needs in a Magnus installation report (`capabilities`). */
const GATE_LEVEL: Record<Gate, number> = { recovery: 1, lineage: 1, artifact_transfer: 2, task_filters: 1 };
const GATE_CAPABILITY: Record<Gate, string> = { recovery: 'ardent.recovery.v1', lineage: 'ardent.lineage.v1', artifact_transfer: 'artifact-transfer.v2', task_filters: 'ardent.task-filters.v1' };

export type Effect = 'none' | 'idempotent' | 'unknown';
export type Query = Readonly<Record<string, string | number | undefined>>;

export interface ReadSpec {
  /** The Ardent path below `/api/v1/`, e.g. `tasks/<id>/events`. */
  readonly path: string;
  readonly query?: Query;
  readonly gate?: Gate;
}

export interface ActionSpec {
  /** The Ardent path below `/api/v1/` for a direct POST. */
  readonly path: string;
  readonly body?: unknown;
  /** The Magnus action that performs it, its target and its body. */
  readonly magnus: { readonly action: string; readonly target?: string; readonly body?: unknown };
  /** An execution context: Ardent's body field directly, a top-level action field through Magnus when it advertises one. */
  readonly execution?: ExecutionContext | undefined;
  readonly gate?: Gate;
  /** Whether repeating the request is safe. Through Magnus an action is never repeated automatically. */
  readonly effect: 'idempotent' | 'unknown';
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RawRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly gate?: Gate;
  readonly signal?: AbortSignal | undefined;
  /** Statuses returned to the caller instead of raised (e.g. 416 for a download). */
  readonly allow?: readonly number[];
}

interface MagnusReport { readonly at: number; readonly capabilities: Readonly<Record<string, unknown>> | undefined; readonly version: string | undefined }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** A JSON object, taken as the documented response type `T`. */
function documented<T>(value: unknown): value is T {
  return isRecord(value);
}

/** Combine signals; `undefined` when none is given. */
export function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/** A retryable answer, kept until the retry loop decides; its body is read only for the final error. */
class RetryableStatus extends Error {
  constructor(readonly response: Response) { super(`HTTP ${response.status}`); }
}
class NetworkFailure extends Error {}

/** One profile reached through one transport: URLs, authentication, retries and error mapping. */
export class Connection {
  readonly kind: 'direct' | 'magnus';
  readonly #options: DirectTransportOptions | ResolvedMagnusTransportOptions;
  /** The API root: `<baseUrl>/api/v1` directly, Magnus's API root through Magnus. */
  readonly #api: string;
  readonly #magnus: { readonly nodeId: string; readonly profile: string } | undefined;
  readonly #fetch: FetchLike;
  readonly #signal: AbortSignal | undefined;
  readonly #policy: RetryPolicy;
  readonly #deadlineMs: number | undefined;
  #report: MagnusReport | undefined;
  #reportLoad: Promise<MagnusReport> | undefined;

  constructor(transport: ArdentTransport, options: { signal?: AbortSignal | undefined; retryPolicy?: RetryPolicy | undefined; deadlineMs?: number | undefined } = {}) {
    this.kind = transport.kind;
    this.#options = transport.options;
    const resolved = transport.options;
    this.#magnus = 'nodeId' in resolved ? { nodeId: resolved.nodeId, profile: resolved.profile } : undefined;
    this.#api = 'apiBase' in resolved ? resolved.apiBase : `${resolved.baseUrl}/api/v1`;
    const custom = transport.options.fetch;
    this.#fetch = custom ?? ((input, init) => globalThis.fetch(input, init));
    this.#signal = options.signal;
    this.#policy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.#deadlineMs = options.deadlineMs;
  }

  get signal(): AbortSignal | undefined { return this.#signal; }
  get retryPolicy(): RetryPolicy { return this.#policy; }
  get fetcher(): FetchLike { return this.#fetch; }

  /** The URL of an Ardent path below `/api/v1/` on this transport. */
  url(path: string, query: Query = {}): string {
    const base = this.kind === 'direct' ? `${this.#api}/${path}` : `${this.#profileBase()}/${path}`;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
    const text = search.toString();
    return text ? `${base}?${text}` : base;
  }

  #profileBase(): string {
    const magnus = this.#magnus ?? { nodeId: '', profile: '' };
    return `${this.#api}/ardent/installations/${encodeURIComponent(magnus.nodeId)}/profiles/${encodeURIComponent(magnus.profile)}`;
  }

  async headers(refresh: boolean): Promise<Record<string, string>> {
    const token = await this.#options.getToken({ refresh });
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new UnauthorizedError('unauthorized', 'getToken() returned no usable token', { status: 401 });
    return { ...this.#options.headers, authorization: `Bearer ${token}` };
  }

  async read<T>(spec: ReadSpec, signal?: AbortSignal): Promise<T> {
    const response = await this.send({ url: this.url(spec.path, spec.query), method: 'GET', effect: 'none', gate: spec.gate, signal });
    return this.#json<T>(response);
  }

  async action<T>(spec: ActionSpec, signal?: AbortSignal): Promise<T> {
    if (this.kind === 'direct') {
      const body = spec.execution !== undefined && spec.body && typeof spec.body === 'object' ? { ...spec.body, execution: spec.execution } : spec.body;
      const response = await this.send({ url: this.url(spec.path), method: 'POST', effect: spec.effect, gate: spec.gate, signal,
        headers: { 'content-type': 'application/json', ...spec.headers }, body: JSON.stringify(body ?? {}) });
      return this.#json<T>(response);
    }
    const execution = spec.execution !== undefined && await this.advertises('lineage') ? spec.execution : undefined;
    const payload = { action: spec.magnus.action, ...(spec.magnus.target !== undefined ? { target: spec.magnus.target } : {}),
      ...(spec.magnus.body !== undefined ? { body: spec.magnus.body } : {}), ...(execution ? { execution } : {}) };
    const response = await this.send({ url: `${this.#profileBase()}/action`, method: 'POST', effect: 'unknown', gate: spec.gate, action: true, signal,
      headers: { 'content-type': 'application/json', ...spec.headers }, body: JSON.stringify(payload) });
    return this.#json<T>(response);
  }

  /** A GET whose body the caller consumes (streams and downloads). */
  async raw(request: RawRequest): Promise<Response> {
    return this.send({ ...request, method: 'GET', effect: 'none' });
  }

  /**
   * The JSON body. The client trusts the documented response shape (the generated OpenAPI
   * types) once it is a JSON object; through Magnus it is the `data` of `{ success: true, data }`.
   */
  async #json<T>(response: Response): Promise<T> {
    let value: unknown;
    try { value = await response.json(); }
    catch (error: unknown) { throw new TransportError('invalid_response', 'The response is not JSON', { status: 502, cause: error }); }
    if (this.kind === 'magnus') {
      if (!isRecord(value) || value['success'] !== true || !('data' in value))
        throw new TransportError('invalid_response', 'Magnus answered without its { success, data } envelope', { status: 502 });
      value = value['data'];
    }
    if (!documented<T>(value)) throw new TransportError('invalid_response', 'The response is not a JSON object', { status: 502 });
    return value;
  }

  /**
   * Send one request: fresh token per attempt, one more token after a 401, automatic retries
   * for safe requests, and every refusal mapped to a client error.
   */
  async send(request: { url: string; method: 'GET' | 'POST'; effect: Effect; gate?: Gate | undefined; signal?: AbortSignal | undefined;
    headers?: Readonly<Record<string, string>> | undefined; body?: string; allow?: readonly number[] | undefined; action?: boolean }): Promise<Response> {
    const signal = anySignal(this.#signal, request.signal);
    let refreshed = false;
    const attempt = async (): Promise<Response> => {
      if (signal?.aborted) throw abortReason(signal);
      const headers = { ...await this.headers(refreshed), ...request.headers };
      let response: Response;
      try {
        response = await this.#fetch(request.url, { method: request.method, headers, ...(request.body !== undefined ? { body: request.body } : {}),
          ...(signal ? { signal } : {}), redirect: 'error' });
      } catch (error: unknown) {
        if (signal?.aborted) throw abortReason(signal);
        throw new NetworkFailure(error instanceof Error ? error.message : 'Network request failed', { cause: error });
      }
      if (response.status === 401 && !refreshed) {
        await response.body?.cancel().catch(() => undefined);
        refreshed = true;
        return attempt();
      }
      if (response.ok || request.allow?.includes(response.status)) return response;
      if ([408, 425, 429].includes(response.status) || response.status >= 500) throw new RetryableStatus(response);
      throw await this.error(response, request.gate, request.action);
    };
    try {
      return await retry(() => attempt(), {
        policy: this.#policy, ...(signal ? { signal } : {}), ...(this.#deadlineMs !== undefined ? { deadlineMs: this.#deadlineMs } : {}),
        classify: error => {
          if (error instanceof NetworkFailure) return { retry: classifyRetry({ network: true, effect: request.effect }) === 'retryable', reason: 'network' };
          if (error instanceof RetryableStatus) {
            const headers = error.response.headers;
            const exhausted = readRetrySignal(headers) === 'exhausted';
            const ok = !exhausted && classifyRetry({ status: error.response.status, effect: request.effect }) === 'retryable';
            if (ok) void error.response.body?.cancel().catch(() => undefined);
            return { retry: ok, retryAfterMs: retryAfterFromHeaders(headers), reason: exhausted ? 'exhausted' : `http_${error.response.status}` };
          }
          return { retry: false };
        },
      });
    } catch (error: unknown) {
      const cause = error instanceof RetryExhaustedError ? error.cause : error;
      if (cause instanceof RetryableStatus) throw await this.error(cause.response, request.gate, request.action);
      if (cause instanceof NetworkFailure) throw new TransportError('network_error', cause.message, { status: 503, cause: cause.cause });
      throw cause;
    }
  }

  /** Map a refused response to a client error. */
  async error(response: Response, gate?: Gate, action = false): Promise<ArdentClientError> {
    const text = await response.text().catch(() => '');
    let body: unknown = text;
    try { body = text ? JSON.parse(text) as unknown : ''; } catch { /* plain text */ }
    const parsed = parseHiveError(response.status, body, { requestId: response.headers.get('x-request-id') ?? undefined });
    const error = isRecord(body) && isRecord(body['error']) ? body['error'] : {};
    const options = { status: response.status, ...(parsed.requestId ? { requestId: parsed.requestId } : {}), ...(parsed.details ? { details: parsed.details } : {}) };
    const code = parsed.code;
    if (response.status === 401) return new UnauthorizedError(code, parsed.message, options);
    if (response.status === 409 && /^(?:unsupported_capability|AGENT_UPGRADE_REQUIRED)$/i.test(code)) {
      const field = (name: string) => typeof error[name] === 'string' ? error[name] : typeof parsed.details?.[name] === 'string' ? parsed.details[name] : undefined;
      return new UnsupportedCapabilityError(field('capability') ?? (gate ? GATE_CAPABILITY[gate] : code.toLowerCase()), parsed.message,
        { ...options, requiredVersion: field('required_version'), installedVersion: field('installed_version') });
    }
    // Magnus answers a read it does not allow with 403 or 404, and an action it does not know
    // with 400. When it advertises the capability, those are Ardent's own answers.
    if (gate && this.kind === 'magnus' && (response.status === 403 || ((response.status === 404 || (action && response.status === 400)) && !await this.advertises(gate))))
      return new UnsupportedCapabilityError(GATE_CAPABILITY[gate], `Magnus does not offer this route (${GATE_CAPABILITY[gate]}): ${parsed.message}`, options);
    if (response.status === 404) return new NotFoundError(code, parsed.message, options);
    if (response.status === 409) return new ConflictError(code, parsed.message, { ...options, idempotency: /idempotency/i.test(parsed.message) });
    if (response.status >= 502 && response.status <= 504) return new TransportError(code, parsed.message, options);
    return new ArdentClientError(code, parsed.message, options);
  }

  /** The Magnus installation report for the node, cached for a minute. Undefined when it cannot be read. */
  async magnusReport(): Promise<MagnusReport | undefined> {
    if (this.kind !== 'magnus') return undefined;
    if (this.#report && Date.now() - this.#report.at < 60_000) return this.#report;
    this.#reportLoad ??= (async (): Promise<MagnusReport> => {
      const magnus = this.#magnus ?? { nodeId: '', profile: '' };
      try {
        const response = await this.send({ url: `${this.#api}/ardent/installations/${encodeURIComponent(magnus.nodeId)}`, method: 'GET', effect: 'none' });
        const data = await this.#json<Record<string, unknown>>(response);
        const profiles: unknown[] = Array.isArray(data['profiles']) ? data['profiles'] : [];
        const profile = profiles.filter(isRecord).find(item => item['id'] === magnus.profile);
        const record = (value: unknown) => isRecord(value) ? value : undefined;
        const capabilities = { ...record(data['capabilities']), ...record(profile?.['capabilities']) };
        const version = typeof profile?.['version'] === 'string' ? profile['version'] : typeof data['version'] === 'string' ? data['version'] : undefined;
        return { at: Date.now(), capabilities, version };
      } catch {
        // A service identity may not read installations; the gates then fall back to the route's own answer.
        return { at: Date.now(), capabilities: undefined, version: undefined };
      }
    })().finally(() => { this.#reportLoad = undefined; });
    this.#report = await this.#reportLoad;
    return this.#report;
  }

  /** Whether the transport offers a gated route: always directly, through Magnus when its report says so. */
  async advertises(gate: Gate): Promise<boolean> {
    if (this.kind === 'direct') return true;
    const level = (await this.magnusReport())?.capabilities?.[gate];
    return typeof level === 'number' && level >= GATE_LEVEL[gate];
  }
}
