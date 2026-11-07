/** Shared bounded, redirect-refusing reader for role-owned read-only service APIs. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const envelope = z.object({ success: z.literal(true), data: z.unknown().optional(), meta: z.unknown().optional() }).passthrough();
const bareEnvelope = z.object({ success: z.undefined().optional() }).passthrough();
const MAX_RESPONSE_BYTES = 512_000;

export async function readOwnedApi(baseEnv: string, tokenEnv: string, path: string, env: NodeJS.ProcessEnv, signal: AbortSignal, extraHeaders: Record<string, string> = {}, previewBody?: unknown, bare = false): Promise<{ value: unknown; source: string; sourceDate: string | null; meta: unknown }> {
  const base = env[baseEnv];
  const token = env[tokenEnv];
  if (!base || !token) throw Object.assign(new Error('Role read-only service binding is unavailable'), { code: 'SERVICE_BINDING_UNAVAILABLE' });
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw Object.assign(new Error('Role service URL must be an HTTP(S) origin'), { code: 'INVALID_SERVICE_BINDING' });
  if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
    throw Object.assign(new Error('Role bearer token requires HTTPS outside loopback'), { code: 'INVALID_SERVICE_BINDING' });
  const [pathname = '', query] = path.split('?', 2);
  url.pathname = pathname;
  if (query) url.search = query;
  const body = previewBody === undefined ? undefined : JSON.stringify(previewBody);
  if (body && Buffer.byteLength(body, 'utf8') > 64_000)
    throw Object.assign(new Error('Role preview request exceeds limit'), { code: 'SERVICE_REQUEST_TOO_LARGE' });
  const result = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body }), signal, redirect: 'manual' });
  if (!result.ok) throw Object.assign(new Error(`Read-only service returned HTTP ${result.status}`), { code: 'SERVICE_READ_FAILED' });
  const length = Number(result.headers.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw Object.assign(new Error('Role service response exceeds limit'), { code: 'SERVICE_RESPONSE_TOO_LARGE' });
  if (!result.body) throw Object.assign(new Error('Role service response has no body'), { code: 'SERVICE_READ_FAILED' });
  const reader = result.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error('Role service response exceeds limit'), { code: 'SERVICE_RESPONSE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  const rawDate = result.headers.get('date');
  const sourceDate = rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
  const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  // A few owner routes return a bare object; that shape is accepted only where a caller names it.
  if (bare && bareEnvelope.safeParse(parsed).success) return { value: parsed, source: url.toString(), sourceDate, meta: null };
  const owned = envelope.parse(parsed);
  return { value: owned.data, source: url.toString(), sourceDate, meta: owned.meta ?? null };
}

// Defence in depth: owner APIs already redact for a read principal, but a projection must never carry these.
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[_-]?key|credential|private[_-]?key|cookie|^env$|^args$|^command$|stdout|stderr/i;
const DEFAULT_MAX_ITEMS = 100;

function project(value: unknown, depth: number, maxItems: number, flags: { truncated: boolean }): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length <= 500) return value;
    flags.truncated = true;
    return `${value.slice(0, 500)}…`;
  }
  if (depth >= 7) { flags.truncated = true; return '[depth limit]'; }
  if (Array.isArray(value)) {
    if (value.length > maxItems) flags.truncated = true;
    return value.slice(0, maxItems).map(item => project(item, depth + 1, maxItems, flags));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 80) flags.truncated = true;
    return Object.fromEntries(entries.slice(0, 80).map(([key, item]) =>
      [key, SENSITIVE_KEY.test(key) ? '[redacted]' : project(item, depth + 1, maxItems, flags)]));
  }
  return null;
}

/** Bounded, redacted projection of an owner response; `truncated` is true whenever any content was cut. */
export function boundOwnerData(value: unknown, maxBytes = 64_000): { data: unknown; truncated: boolean; sha256: string } {
  for (let items = DEFAULT_MAX_ITEMS; items >= 5; items = Math.floor(items / 2)) {
    const flags = { truncated: false };
    const data = project(value, 0, items, flags);
    const text = JSON.stringify(data ?? null);
    if (Buffer.byteLength(text, 'utf8') <= maxBytes)
      return { data: data ?? null, truncated: flags.truncated, sha256: createHash('sha256').update(text).digest('hex') };
  }
  const omitted = { omitted: 'Owner response exceeds the bounded projection' };
  return { data: omitted, truncated: true, sha256: createHash('sha256').update(JSON.stringify(omitted)).digest('hex') };
}

export const ownerReadOutput = z.object({
  source: z.string().url(), sources: z.array(z.string().url()).min(1).max(4),
  source_date: z.string().datetime().nullable(), observed_at: z.string().datetime(),
  row_count: z.number().int().nonnegative().nullable(), total_available: z.number().int().nonnegative().nullable(), limit_reached: z.boolean().nullable(),
  truncated: z.boolean(), data_sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.unknown().optional()
}).strict();
export type OwnerReadOutput = z.infer<typeof ownerReadOutput>;

export function ownerReadResult(reads: Array<{ source: string; sourceDate: string | null; meta?: unknown }>, data: unknown, rowLimit?: number): OwnerReadOutput {
  const bounded = boundOwnerData(data);
  const rows = Array.isArray(data) ? data.length : null;
  const first = reads[0];
  if (!first) throw new Error('Owner read has no source');
  return { source: first.source, sources: reads.map(read => read.source), source_date: first.sourceDate,
    observed_at: new Date().toISOString(), row_count: rows, total_available: totalOf(first.meta) ?? totalOf(data), limit_reached: rows === null || rowLimit === undefined ? null : rows >= rowLimit,
    truncated: bounded.truncated, data_sha256: bounded.sha256, data: bounded.data };
}

function totalOf(value: unknown): number | null {
  const parsed = z.object({ total: z.number().int().nonnegative() }).passthrough().safeParse(value);
  return parsed.success ? parsed.data.total : null;
}

export function withQuery(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
