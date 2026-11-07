/** Bounds on the A2A surface: per-client and per-peer token buckets and a per-peer task cap. */
import { isIPv4, isIPv6 } from 'node:net';
import { type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export type TakeResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface BucketLimits { perMinute: number; burst: number; maxKeys?: number; now?: () => number }

/** Answers from memory only, and keeps at most maxKeys buckets so many clients cannot grow it. */
export class TokenBucketLimiter {
  readonly #buckets = new Map<string, { tokens: number; updated: number }>();
  readonly #perMs: number;
  readonly #burst: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  constructor(limits: BucketLimits) {
    this.#perMs = limits.perMinute / 60_000;
    this.#burst = limits.burst;
    this.#maxKeys = limits.maxKeys ?? 10_000;
    this.#now = limits.now ?? Date.now;
  }
  take(key: string): TakeResult {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, updated: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + Math.max(0, now - bucket.updated) * this.#perMs);
    bucket.updated = now;
    // Reinsert so the Map's order runs from least to most recently used.
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next();
      if (!oldest.done) this.#buckets.delete(oldest.value);
    }
    if (bucket.tokens < 1) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.#perMs / 1000)) };
    bucket.tokens -= 1;
    return { allowed: true };
  }
}

/** One bucket per client: an IPv4-mapped address is its IPv4 address, and IPv6 clients share a /64. */
export function clientKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const bare = address.split('%')[0] ?? address;
  const mapped = bare.toLowerCase().startsWith('::ffff:') ? bare.slice(7) : bare;
  if (isIPv4(mapped) || !isIPv6(bare)) return mapped;
  const [head = '', tail = ''] = bare.toLowerCase().split('::');
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const groups = [...before, ...new Array<string>(Math.max(0, 8 - before.length - after.length)).fill('0'), ...after];
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export function tooManyRequests(res: Response, retryAfterSeconds: number, error = 'Too many A2A requests'): void {
  res.status(429).set({ 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' }).json({ error });
}

export function limitRequests(limiter: TokenBucketLimiter, key: (req: Request, res: Response) => string): RequestHandler {
  return (req, res, next) => {
    const result = limiter.take(key(req, res));
    if (result.allowed) { next(); return; }
    tooManyRequests(res, result.retryAfterSeconds);
  };
}

/** Admitted peer tasks, from before the SDK creates the task until the executor settles it. */
export class PeerTaskGate {
  readonly #active = new Map<string, Set<string>>();
  constructor(readonly maxPerPeer: number) {}
  isFull(peer: string): boolean { return (this.#active.get(peer)?.size ?? 0) >= this.maxPerPeer; }
  holds(peer: string, key: string): boolean { return this.#active.get(peer)?.has(key) ?? false; }
  acquire(peer: string, key: string): boolean {
    const active = this.#active.get(peer) ?? new Set<string>();
    if (!active.has(key) && active.size >= this.maxPerPeer) return false;
    active.add(key);
    this.#active.set(peer, active);
    return true;
  }
  release(peer: string, key: string): void {
    const active = this.#active.get(peer);
    if (!active?.delete(key)) return;
    if (active.size === 0) this.#active.delete(peer);
  }
}

/** Frees a task's slot when its execution ends, however it ends. */
export class GatedA2AExecutor implements AgentExecutor {
  constructor(readonly inner: AgentExecutor, readonly gate: PeerTaskGate) {}
  async execute(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    try { await this.inner.execute(request, bus); }
    finally {
      const peer = request.context.user?.userName;
      if (peer) this.gate.release(peer, request.userMessage.messageId);
    }
  }
  cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> { return this.inner.cancelTask(taskId, bus); }
}

const SendRpc = z.object({ method: z.string(), params: z.object({ message: z.object({ metadata: z.record(z.string(), z.unknown()).nullish() }).nullish() }).nullish() });
const SEND_METHODS = new Set(['SendMessage', 'SendStreamingMessage', 'message/send', 'message/stream']);
/** How long a peer at its task cap should wait; tasks have no fixed duration to report instead. */
export const TASK_CAP_RETRY_SECONDS = 5;

/**
 * Answers an HTTP 429 before the transports turn the handler's refusal into an
 * application error. The handler still enforces the cap atomically and for gRPC.
 * Team control messages stay allowed so a peer at its cap can still cancel work.
 */
export function jsonRpcTaskCap(gate: PeerTaskGate, peerOf: (res: Response) => string): RequestHandler {
  return (req, res, next) => {
    const rpc = SendRpc.safeParse(req.body as unknown);
    if (rpc.success && SEND_METHODS.has(rpc.data.method) && !('hermesTeamControl' in (rpc.data.params?.message?.metadata ?? {})) && gate.isFull(peerOf(res))) {
      tooManyRequests(res, TASK_CAP_RETRY_SECONDS, 'Peer task limit reached');
      return;
    }
    next();
  };
}

/** The REST body is not parsed yet here; cancel has its own route and stays available. */
export function restTaskCap(gate: PeerTaskGate, peerOf: (res: Response) => string): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'POST' && /\/message:(?:send|stream)$/.test(req.path) && gate.isFull(peerOf(res))) {
      tooManyRequests(res, TASK_CAP_RETRY_SECONDS, 'Peer task limit reached');
      return;
    }
    next();
  };
}
