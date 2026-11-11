import type { Hono } from 'hono';
import { z } from 'zod';
import { bodyLimit } from 'hono/body-limit';
import type { JobEngine } from './job-engine.js';
import { pluginContext } from './plugins.js';
import type { ArdentRuntime } from './runtime.js';
import { TokenBucketLimiter } from './a2a-rate-limit.js';

const capacity = z.object({ perMinute: z.number().int().min(1).max(6000), burst: z.number().int().min(1).max(1200) }).strict();

/** Hono's route precedence must never let an extension shadow an existing handler. */
function overlaps(a: string, b: string): boolean {
  const left = a.split('/'), right = b.split('/');
  return left.length === right.length && left.every((part, index) => part === right[index] || part.startsWith(':') || right[index]?.startsWith(':'));
}

export function mountPluginHttp(app: Hono, runtime: ArdentRuntime, env: NodeJS.ProcessEnv, jobs?: JobEngine): void {
  const claimed = app.routes.filter(route => route.method !== 'ALL').map(route => ({ method: route.method, path: route.path, owner: '' }));
  const planned = [];
  const capacities = new Map<string, z.infer<typeof capacity>>();
  const ctx = pluginContext(runtime, env);
  for (const plugin of runtime.plugins) for (const mount of plugin.httpRoutes?.(ctx, jobs) ?? []) {
    if (!['management', 'independent'].includes(mount.security)) throw new Error('Plugin HTTP security declaration is required');
    const scope = `${plugin.name}:${mount.security}`, budget = capacity.parse(mount.rateLimit ?? { perMinute: 600, burst: 120 });
    const priorBudget = capacities.get(scope);
    if (priorBudget && (priorBudget.perMinute !== budget.perMinute || priorBudget.burst !== budget.burst)) throw new Error('Conflicting plugin ingress capacity within an authentication boundary');
    capacities.set(scope, budget);
    for (const route of mount.app.routes) {
      const path = route.path;
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(route.method) ||
          !/^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*))*$/.test(path))
        throw new Error('Plugin HTTP routes require explicit methods and bounded paths');
      const management = path.startsWith('/api/v1/');
      if (mount.security === 'management' ? !management : /^\/(?:api|health|a2a)(?:\/|$)/.test(path) || path === '/openapi.json')
        throw new Error('Plugin HTTP route uses a reserved authentication boundary');
      if (claimed.some(prior => (prior.method === route.method || [prior.method, route.method].every(method => ['GET', 'HEAD'].includes(method))) && overlaps(prior.path, path) && (prior.owner !== plugin.name || prior.path.replace(/:[^/]+/g, ':') === path.replace(/:[^/]+/g, ':')))) throw new Error(`Plugin ${plugin.name} HTTP route ${route.method} ${path} overlaps an existing route`);
      claimed.push({ method: route.method, path, owner: plugin.name });
      planned.push({ route, scope });
    }
  }
  // Separate bounded buckets for management and independent ingress prevent one boundary consuming the other’s capacity.
  const limits = new Map<string, TokenBucketLimiter>();
  for (const { route, scope } of planned) {
    const limiter = limits.get(scope) ?? new TokenBucketLimiter(capacities.get(scope)!);
    limits.set(scope, limiter);
    app.on(route.method, route.path, async (c, next) => {
      const result = limiter.take('ingress');
      if (!result.allowed) return c.json({ error: { code: 'RATE_LIMITED' } }, 429,
        { 'Retry-After': String(result.retryAfterSeconds), 'Cache-Control': 'no-store' });
      return next();
    }, bodyLimit({ maxSize: 1_048_576, onError: c => c.json({ error: { code: 'BODY_TOO_LARGE' } }, 413) }), route.handler);
  }
}
