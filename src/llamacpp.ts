import { z } from 'zod';
import type { ArdentConfig } from './config.js';
import { resolveReference } from './config.js';
import type { BackendEventSink } from './backend-events.js';
import { AttemptError, isTransportError, responseFailure, retryWithPolicy, type RetryAttemptRecord } from './retry.js';

export type ChatMessage = import('@hivemagnus/emberfold').ChatMessage;
export type ModelToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ModelReply = { content: string; reasoning?: string; toolCalls: ModelToolCall[]; usage?: { promptTokens?: number; completionTokens?: number } };
export type LlamaCapabilities = { modelListed: boolean | null; contextTokens: number | null; supportsTools: boolean | null; supportsReasoningEffort: boolean | null; sampling: { temperature: number | null; topP: number | null }; reasoningFormat: string | null; chatFormat: string | null };

/** One repeated model request, for the task journal (`model_retry`). */
export type ModelRetryEvent = { operation: 'complete' | 'count_tokens'; attempt: number; reason: string; delay_ms: number };
/** Optional per-request settings for `complete` and `countInputTokens`. */
export type LlamaRequestOptions = {
  /**
   * Extra outbound request headers (for example execution context). They never replace
   * `Authorization`, `Content-Type` or `Accept`, and invalid names or values are dropped.
   */
  requestHeaders?: Record<string, string> | undefined;
  /** Absolute epoch-ms deadline (the task deadline). No retry starts at or after it. */
  deadlineMs?: number | undefined;
  /** Called before each retry wait. */
  onRetry?: ((event: ModelRetryEvent) => void) | undefined;
  /** Test seams for backoff jitter and the clock. */
  random?: (() => number) | undefined;
  now?: (() => number) | undefined;
};

const PROTECTED_HEADERS = new Set(['authorization', 'content-type', 'accept']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
/** Caller headers first, so the backend's own `Content-Type`, `Accept` and `Authorization` win. */
export function mergeRequestHeaders(own: Record<string, string>, extra: Record<string, string> | undefined): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (typeof value !== 'string' || !HEADER_NAME.test(name) || PROTECTED_HEADERS.has(name.toLowerCase())) continue;
    if (value.length > 8192 || /[\r\n\0]/.test(value)) continue;
    merged[name] = value;
  }
  return { ...merged, ...own };
}

function retryObserver(operation: ModelRetryEvent['operation'], options: LlamaRequestOptions | undefined): (record: RetryAttemptRecord) => void {
  return record => { if (record.delayMs !== null) options?.onRetry?.({ operation, attempt: record.attempt, reason: record.reason, delay_ms: record.delayMs }); };
}

export function llamaEndpoint(base: string, operation: 'chat/completions' | 'chat/completions/input_tokens' | 'models'): URL {
  const url = new URL(base);
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = `${path}${path.endsWith('/v1') ? '' : '/v1'}/${operation}`;
  return url;
}

const ToolCall = z.object({ id: z.string().min(1), type: z.literal('function'), function: z.object({ name: z.string().min(1), arguments: z.string() }) });
const FullResponse = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().optional(), tool_calls: z.array(ToolCall).optional() }) })).min(1), usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional() });
const Delta = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), tool_calls: z.array(z.object({ index: z.number().int().nonnegative(), id: z.string().optional(), type: z.literal('function').optional(), function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).optional() }) })), usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).nullable().optional() });
const Models = z.object({ data: z.array(z.object({ id: z.string(), aliases: z.array(z.string()).optional(), meta: z.object({ n_ctx: z.number().int().positive().optional() }).passthrough().optional() }).passthrough()) }).passthrough();
const Props = z.object({ model_alias: z.string().optional(), default_generation_settings: z.object({ n_ctx: z.number().int().positive().optional(), params: z.object({ temperature: z.number().optional(), top_p: z.number().optional(), reasoning_format: z.string().optional(), chat_format: z.string().optional() }).passthrough().optional() }).passthrough().optional(), chat_template_caps: z.object({ supports_tools: z.boolean().optional(), supports_tool_calls: z.boolean().optional(), supports_reasoning_effort: z.boolean().optional() }).passthrough().optional() }).passthrough();

function readUsage(value: { prompt_tokens?: number | undefined; completion_tokens?: number | undefined }): NonNullable<ModelReply['usage']> {
  return { ...(value.prompt_tokens === undefined ? {} : { promptTokens: value.prompt_tokens }), ...(value.completion_tokens === undefined ? {} : { completionTokens: value.completion_tokens }) };
}

export async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      pending = (pending + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const lines = event.split('\n').filter(line => line.startsWith('data:'));
        if (lines.length) yield lines.map(line => line.slice(5).trimStart()).join('\n');
      }
    }
    pending += decoder.decode();
    if (pending.trim()) throw new Error('Incomplete SSE event');
  } finally {
    // A consumer that stops early (a malformed event, [DONE]) must end the
    // response, or the server keeps generating into an unread stream.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class NativeLlmBackend {
  #discovery?: Promise<LlamaCapabilities>;
  constructor(readonly config: ArdentConfig['providers']['llamacpp'], readonly env: NodeJS.ProcessEnv = process.env) {}
  discover(): Promise<LlamaCapabilities> {
    this.#discovery ??= this.#discover();
    return this.#discovery;
  }
  async countInputTokens(messages: ChatMessage[], tools: object[], signal: AbortSignal, options?: LlamaRequestOptions): Promise<number | null> {
    const base = resolveReference(this.config.base_url, this.env);
    const model = resolveReference(this.config.model, this.env);
    if (!base || !model) throw new Error('llama.cpp endpoint/model is unconfigured');
    const token = this.env[this.config.api_key_env];
    const endpoint = llamaEndpoint(base, 'chat/completions/input_tokens');
    const headers = mergeRequestHeaders({ 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, options?.requestHeaders);
    const body = JSON.stringify({ model, messages, tools });
    try {
      // Counting has no effect, so a transient failure is repeated before the estimator takes over.
      return await retryWithPolicy('llamacpp', async () => {
        let response: Response;
        try {
          response = await fetch(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers, body });
        } catch (error: unknown) {
          if (isTransportError(error)) throw new AttemptError('llama.cpp token count transport failed', { network: true }, { cause: error });
          throw error;
        }
        if (response.status === 404 || response.status === 405) { await response.body?.cancel().catch(() => {}); return null; }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new AttemptError(`llama.cpp token count HTTP ${response.status}`, responseFailure(response, options?.now));
        }
        return z.object({ input_tokens: z.number().int().nonnegative() }).parse(await response.json()).input_tokens;
      }, { signal, deadlineMs: options?.deadlineMs, effect: 'none', onAttempt: retryObserver('count_tokens', options), random: options?.random, now: options?.now });
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return null; // Older servers lack token counting; the bounded local estimator remains active.
    }
  }
  async #discover(): Promise<LlamaCapabilities> {
    const base = resolveReference(this.config.base_url, this.env);
    const model = resolveReference(this.config.model, this.env);
    if (!base || !model) throw new Error('llama.cpp endpoint/model is unconfigured');
    const token = this.env[this.config.api_key_env];
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const get = async (url: URL): Promise<unknown> => {
      const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as unknown;
    };
    const root = new URL(base);
    root.pathname = root.pathname.replace(/\/v1\/?$/, '/') ;
    root.search = '';
    root.hash = '';
    const [modelsRaw, propsRaw] = await Promise.allSettled([get(llamaEndpoint(base, 'models')), get(new URL('props', root))]);
    const models = modelsRaw.status === 'fulfilled' ? Models.safeParse(modelsRaw.value) : undefined;
    const props = propsRaw.status === 'fulfilled' ? Props.safeParse(propsRaw.value) : undefined;
    const entries = models?.success ? models.data.data : undefined;
    const selected = entries?.find(item => item.id === model || item.aliases?.includes(model));
    const settings = props?.success ? props.data.default_generation_settings : undefined;
    const caps = props?.success ? props.data.chat_template_caps : undefined;
    return { modelListed: entries ? Boolean(selected) : null, contextTokens: this.config.context_window_tokens ?? selected?.meta?.n_ctx ?? settings?.n_ctx ?? null,
      supportsTools: caps?.supports_tools === false || caps?.supports_tool_calls === false ? false : caps?.supports_tools && caps.supports_tool_calls ? true : null,
      supportsReasoningEffort: caps?.supports_reasoning_effort ?? null,
      sampling: { temperature: settings?.params?.temperature ?? null, topP: settings?.params?.top_p ?? null },
      reasoningFormat: settings?.params?.reasoning_format ?? null, chatFormat: settings?.params?.chat_format ?? null };
  }
  /**
   * One model call. A transport failure or a 408/425/429/5xx response is repeated under the
   * `llamacpp` policy only before any response byte is consumed, never after the gateway says
   * `x-hive-retry: exhausted`, and never past `options.deadlineMs` or the request timeout. A
   * stream that fails after its first chunk is never repeated.
   */
  async complete(messages: ChatMessage[], tools: object[], signal: AbortSignal, stream = true, onText?: (chunk: string) => void, onEvent?: BackendEventSink, options?: LlamaRequestOptions): Promise<ModelReply> {
    const base = resolveReference(this.config.base_url, this.env);
    const model = resolveReference(this.config.model, this.env);
    if (!base || !model) throw new Error('llama.cpp endpoint/model is unconfigured');
    const endpoint = llamaEndpoint(base, 'chat/completions');
    const startedMs = (options?.now ?? Date.now)();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.request_timeout_seconds * 1000);
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) controller.abort();
      const token = this.env[this.config.api_key_env];
      const capabilities = this.config.reasoning_effort ? await this.discover() : undefined;
      if (this.config.reasoning_effort && capabilities?.supportsReasoningEffort !== true) throw new Error('llama.cpp reasoning effort is not advertised by the current chat template');
      if (tools.length && capabilities?.supportsTools === false) throw new Error('llama.cpp chat template does not support tools');
      onEvent?.({ kind: 'started', backend: 'llamacpp' });
      const headers = mergeRequestHeaders({ 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, options?.requestHeaders);
      const body = JSON.stringify({ model, messages, tools, stream, max_tokens: this.config.max_output_tokens ?? 4096, ...(this.config.reasoning_effort ? { reasoning_effort: this.config.reasoning_effort } : {}), ...(stream ? { stream_options: { include_usage: true } } : {}) });
      // The request timeout bounds every attempt and wait together, so it is a deadline too.
      const deadlineMs = Math.min(startedMs + this.config.request_timeout_seconds * 1000, options?.deadlineMs ?? Number.POSITIVE_INFINITY);
      // A stop on a retryable failure keeps the message (`llama.cpp HTTP 429`) and adds why it stopped.
      const response = await retryWithPolicy('llamacpp', async () => {
        let attempt: Response;
        try {
          attempt = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal });
        } catch (error: unknown) {
          if (!controller.signal.aborted && isTransportError(error)) throw new AttemptError('llama.cpp transport failed before response', { network: true }, { cause: error });
          throw error;
        }
        if (attempt.ok) return attempt;
        // The error body is discarded unread, so nothing of this response reaches the caller.
        await attempt.body?.cancel().catch(() => {});
        throw new AttemptError(`llama.cpp HTTP ${attempt.status}`, responseFailure(attempt, options?.now));
      }, { signal: controller.signal, deadlineMs, effect: 'none', onAttempt: retryObserver('complete', options), random: options?.random, now: options?.now });
      if (!stream) {
        const raw: unknown = await response.json();
        const parsed = FullResponse.parse(raw);
        const message = parsed.choices[0]?.message;
        if (!message) throw new Error('llama.cpp returned no message');
        if (message.content) { onText?.(message.content); onEvent?.({ kind: 'text_delta', backend: 'llamacpp', text: message.content }); }
        const reply: ModelReply = { content: message.content ?? '', ...(message.reasoning_content ? { reasoning: message.reasoning_content } : {}), toolCalls: message.tool_calls ?? [], ...(parsed.usage ? { usage: readUsage(parsed.usage) } : {}) };
        onEvent?.({ kind: 'completed', backend: 'llamacpp', output_chars: reply.content.length, tool_calls: reply.toolCalls.length, reasoning_chars: reply.reasoning?.length ?? 0, usage: reply.usage ?? null });
        return reply;
      }
      if (!response.body) throw new Error('llama.cpp returned no SSE stream');
      let content = '';
      let reasoning = '';
      let usage: ModelReply['usage'];
      let done = false;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const data of sseData(response.body)) {
        if (data === '[DONE]') { done = true; break; }
        const raw: unknown = JSON.parse(data);
        const event = Delta.parse(raw);
        if (event.usage) usage = readUsage(event.usage);
        for (const choice of event.choices) {
          content += choice.delta.content ?? '';
          if (choice.delta.content) { onText?.(choice.delta.content); onEvent?.({ kind: 'text_delta', backend: 'llamacpp', text: choice.delta.content }); }
          reasoning += choice.delta.reasoning_content ?? '';
          for (const call of choice.delta.tool_calls ?? []) {
            const prior = calls.get(call.index) ?? { id: '', name: '', arguments: '' };
            if (call.id) prior.id = call.id;
            if (call.function?.name) prior.name += call.function.name;
            if (call.function?.arguments) prior.arguments += call.function.arguments;
            calls.set(call.index, prior);
          }
        }
      }
      if (!done) throw new Error('llama.cpp SSE stream ended before [DONE]');
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => ToolCall.parse({ id: value.id, type: 'function', function: { name: value.name, arguments: value.arguments } }));
      onEvent?.({ kind: 'completed', backend: 'llamacpp', output_chars: content.length, tool_calls: toolCalls.length, reasoning_chars: reasoning.length, usage: usage ?? null });
      return { content, ...(reasoning ? { reasoning } : {}), toolCalls, ...(usage ? { usage } : {}) };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}
export { NativeLlmBackend as LlamaCppBackend };
