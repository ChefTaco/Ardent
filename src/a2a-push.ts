import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type Database from 'better-sqlite3';
import { StreamResponse as StreamCodec, TaskPushNotificationConfig as PushCodec, type StreamResponse, type Task, type TaskPushNotificationConfig } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import type { PushNotificationSender, PushNotificationStore, ServerCallContext, StoredPushNotificationConfig } from '@a2a-js/sdk/server';
import { z } from 'zod';
import type { PeerConfig } from './a2a-peers.js';

const Row = z.object({ config_json: z.string(), wire_version: z.string() });
const Delivery = z.object({ state: z.enum(['queued', 'sent', 'failed', 'unknown']) });

function scope(context: ServerCallContext): { tenant: string; caller: string } {
  const user = context.user;
  if (!user?.isAuthenticated || !user.userName) throw new Error('Authenticated A2A caller required');
  return { tenant: context.tenant ?? '', caller: user.userName };
}

function validatedUrl(raw: string, peer: PeerConfig): string {
  if (raw.length > 2048) throw new RequestMalformedError('A2A callback URL is too long');
  let callback: URL;
  try { callback = new URL(raw); }
  catch { throw new RequestMalformedError('A2A callback URL is invalid'); }
  const home = new URL(peer.url);
  const port = Number(callback.port || (callback.protocol === 'https:' ? 443 : 80));
  const homePort = Number(home.port || (home.protocol === 'https:' ? 443 : 80));
  if (!['http:', 'https:'].includes(callback.protocol) || callback.username || callback.password || callback.hash || callback.search ||
      callback.hostname !== home.hostname || !new Set([homePort, ...peer.callback_ports]).has(port)) throw new RequestMalformedError('A2A callback URL is outside the configured peer destination');
  if (callback.protocol === 'http:' && (!peer.allow_private_callbacks || !isIP(callback.hostname))) throw new RequestMalformedError('HTTP callback requires an explicit trusted IP peer');
  if (home.protocol === 'https:' && callback.protocol !== 'https:') throw new RequestMalformedError('A2A callback cannot downgrade a secure peer');
  return callback.href;
}

export class SqliteA2APushStore implements PushNotificationStore {
  constructor(readonly db: Database.Database, readonly peers: PeerConfig[]) {
    db.exec(`CREATE TABLE IF NOT EXISTS a2a_push_configs (
      task_id TEXT NOT NULL, tenant TEXT NOT NULL, caller TEXT NOT NULL, id TEXT NOT NULL,
      config_json TEXT NOT NULL, wire_version TEXT NOT NULL, created_ms INTEGER NOT NULL,
      PRIMARY KEY(task_id,tenant,caller,id));
      CREATE TABLE IF NOT EXISTS a2a_push_deliveries (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tenant TEXT NOT NULL, caller TEXT NOT NULL,
      config_id TEXT NOT NULL, state TEXT NOT NULL, http_status INTEGER, error TEXT,
      created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS a2a_push_delivery_task ON a2a_push_deliveries(task_id,tenant,caller);`);
    const columns = z.array(z.object({ name: z.string() })).parse(db.pragma('table_info(a2a_push_deliveries)'));
    if (!columns.some(column => column.name === 'error')) db.exec('ALTER TABLE a2a_push_deliveries ADD COLUMN error TEXT');
    db.prepare("UPDATE a2a_push_deliveries SET state='unknown',updated_ms=? WHERE state='queued'").run(Date.now());
  }
  async save(taskId: string, context: ServerCallContext, config: TaskPushNotificationConfig): Promise<void> {
    const owner = scope(context);
    const peer = this.peers.find(item => item.id === owner.caller && item.enabled);
    if (!peer) throw new RequestMalformedError('A2A callback caller is not a configured peer');
    if (config.taskId !== taskId || (config.tenant && config.tenant !== owner.tenant)) throw new RequestMalformedError('A2A callback task or tenant mismatch');
    const url = validatedUrl(config.url, peer);
    if (config.token.length > 512 || (config.authentication && (config.authentication.scheme.toLowerCase() !== 'bearer' || config.authentication.credentials.length > 512))) throw new RequestMalformedError('A2A callback authentication is unsupported');
    if (!config.id) config.id = randomUUID();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.id)) throw new RequestMalformedError('A2A callback ID is invalid');
    const count = z.object({ count: z.number() }).parse(this.db.prepare('SELECT COUNT(*) AS count FROM a2a_push_configs WHERE task_id=? AND tenant=? AND caller=?').get(taskId, owner.tenant, owner.caller)).count;
    const exists = this.db.prepare('SELECT 1 FROM a2a_push_configs WHERE task_id=? AND tenant=? AND caller=? AND id=?').get(taskId, owner.tenant, owner.caller, config.id);
    if (!exists && count >= 5) throw new RequestMalformedError('A2A callback limit reached');
    const stored = PushCodec.toJSON({ ...config, url, tenant: owner.tenant });
    this.db.prepare(`INSERT INTO a2a_push_configs(task_id,tenant,caller,id,config_json,wire_version,created_ms) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(task_id,tenant,caller,id) DO UPDATE SET config_json=excluded.config_json,wire_version=excluded.wire_version`)
      .run(taskId, owner.tenant, owner.caller, config.id, JSON.stringify(stored), context.requestedVersion || '1.0', Date.now());
  }
  async load(taskId: string, context: ServerCallContext): Promise<TaskPushNotificationConfig[]> {
    return (await this.loadWithMetadata(taskId, context)).map(item => item.config);
  }
  async loadWithMetadata(taskId: string, context: ServerCallContext): Promise<StoredPushNotificationConfig[]> {
    const owner = scope(context);
    return this.db.prepare('SELECT config_json,wire_version FROM a2a_push_configs WHERE task_id=? AND tenant=? AND caller=? ORDER BY created_ms,id')
      .all(taskId, owner.tenant, owner.caller).map(row => {
        const parsed = Row.parse(row);
        const value: unknown = JSON.parse(parsed.config_json);
        return { config: PushCodec.fromJSON(value), wireVersion: parsed.wire_version };
      });
  }
  async delete(taskId: string, context: ServerCallContext, configId?: string): Promise<void> {
    const owner = scope(context);
    if (configId) this.db.prepare('DELETE FROM a2a_push_configs WHERE task_id=? AND tenant=? AND caller=? AND id=?').run(taskId, owner.tenant, owner.caller, configId);
    else this.db.prepare('DELETE FROM a2a_push_configs WHERE task_id=? AND tenant=? AND caller=?').run(taskId, owner.tenant, owner.caller);
  }
  claimDelivery(id: string, taskId: string, context: ServerCallContext, configId: string): boolean {
    const owner = scope(context);
    const result = this.db.prepare("INSERT OR IGNORE INTO a2a_push_deliveries(id,task_id,tenant,caller,config_id,state,http_status,error,created_ms,updated_ms) VALUES (?,?,?,?,?,'queued',NULL,NULL,?,?)")
      .run(id, taskId, owner.tenant, owner.caller, configId, Date.now(), Date.now());
    return result.changes === 1;
  }
  deliveryState(id: string): 'queued' | 'sent' | 'failed' | 'unknown' | undefined {
    const row = this.db.prepare('SELECT state FROM a2a_push_deliveries WHERE id=?').get(id);
    return row ? Delivery.parse(row).state : undefined;
  }
  setDelivery(id: string, state: 'sent' | 'failed' | 'unknown', httpStatus?: number, error?: string): void {
    this.db.prepare('UPDATE a2a_push_deliveries SET state=?,http_status=?,error=?,updated_ms=? WHERE id=?').run(state, httpStatus ?? null, error?.slice(0, 300) ?? null, Date.now(), id);
  }
}

/** Thrown by a `beforeDelivery` hook to refuse a push deterministically (recorded as failed, not unknown). */
export class DeliveryVetoError extends Error {}

export class SafeA2APushSender implements PushNotificationSender {
  readonly #chains = new Map<string, Promise<void>>();
  constructor(readonly store: SqliteA2APushStore, readonly beforeDelivery?: (taskId: string) => void) {}
  async drain(): Promise<void> {
    for (let pass = 0; pass < 3; pass++) {
      await Promise.allSettled([...this.#chains.values()]);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (!this.#chains.size) return;
    }
    throw new Error('A2A push delivery remains unsettled');
  }
  async send(event: StreamResponse, context: ServerCallContext, _task?: Task): Promise<void> {
    const payload = event.payload;
    if (!payload) throw new Error('A2A push event is missing payload');
    const taskId = payload.$case === 'task' ? payload.value.id : payload.value.taskId;
    if (!taskId) return;
    const prior = this.#chains.get(taskId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
      const body = JSON.stringify(StreamCodec.toJSON(event));
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) return;
      const owner = scope(context);
      const configs = await this.store.loadWithMetadata(taskId, context);
      for (const { config, wireVersion } of configs) {
        if (wireVersion !== '1.0') continue;
        const id = createHash('sha256').update(JSON.stringify([owner.tenant, owner.caller, taskId, config.id, body])).digest('hex');
        if (!this.store.claimDelivery(id, taskId, context, config.id)) continue;
        const headers: Record<string, string> = { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' };
        if (config.authentication) headers['Authorization'] = `${config.authentication.scheme} ${config.authentication.credentials}`;
        else if (config.token) headers['X-A2A-Notification-Token'] = config.token;
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            this.beforeDelivery?.(taskId);
            const response = await fetch(config.url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(5000) });
            if (response.ok) { this.store.setDelivery(id, 'sent', response.status); break; }
            if (response.status === 429 && attempt < 2) {
              const seconds = Number(response.headers.get('retry-after') ?? '1');
              await new Promise<void>(resolve => setTimeout(resolve, Number.isFinite(seconds) ? Math.min(5, Math.max(1, seconds)) * 1000 : 1000));
              continue;
            }
            this.store.setDelivery(id, response.status >= 500 ? 'unknown' : 'failed', response.status);
            break;
          }
        } catch (error: unknown) { this.store.setDelivery(id, error instanceof DeliveryVetoError ? 'failed' : 'unknown', undefined, error instanceof Error ? error.message : 'Callback outcome unknown'); }
      }
    });
    this.#chains.set(taskId, next);
    try { await next; } finally { if (this.#chains.get(taskId) === next) this.#chains.delete(taskId); }
  }
}
