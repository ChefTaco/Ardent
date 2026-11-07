import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { StreamResponse as StreamCodec, type StreamResponse } from '@a2a-js/sdk';
import { z } from 'zod';
import type { PeerConfig } from './a2a-peers.js';

const Outbound = z.object({ id: z.string(), peer_id: z.string(), task_id: z.string().nullable() });
const Count = z.object({ count: z.number() });
const EventRow = z.object({ event_json: z.string() });
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export class A2APushInbox {
  constructor(readonly db: Database.Database, readonly peers: PeerConfig[], readonly publicUrl: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS a2a_outbound_calls (
      id TEXT PRIMARY KEY, peer_id TEXT NOT NULL, message_id TEXT NOT NULL, task_id TEXT,
      token_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS a2a_inbound_push (
      id TEXT PRIMARY KEY, outbound_id TEXT NOT NULL, task_id TEXT NOT NULL,
      event_json TEXT NOT NULL, received_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS a2a_inbound_push_outbound ON a2a_inbound_push(outbound_id,received_ms);`);
  }
  register(peerId: string, messageId: string): { id: string; token: string; url: string } {
    if (!this.peers.some(peer => peer.enabled && peer.id === peerId)) throw new Error('A2A push peer is not configured');
    if (!messageId || messageId.length > 128) throw new Error('A2A push message ID is invalid');
    const url = new URL(`/a2a/push/${encodeURIComponent(peerId)}`, this.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('A2A callback public URL is invalid');
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO a2a_outbound_calls(id,peer_id,message_id,task_id,token_hash,state,created_ms,updated_ms) VALUES (?,?,?,NULL,?,?,?,?)')
      .run(id, peerId, messageId, digest(token), 'pending', now, now);
    return { id, token, url: url.href };
  }
  bind(id: string, taskId: string): void {
    const row = this.db.prepare('SELECT id,peer_id,task_id FROM a2a_outbound_calls WHERE id=?').get(id);
    if (!row) throw new Error('A2A outbound call is missing');
    const call = Outbound.parse(row);
    if (!taskId || taskId.length > 256 || (call.task_id && call.task_id !== taskId)) throw new Error('A2A callback task mismatch');
    this.db.prepare("UPDATE a2a_outbound_calls SET task_id=?,state='bound',updated_ms=? WHERE id=?").run(taskId, Date.now(), id);
  }
  markFailed(id: string): void { this.db.prepare("UPDATE a2a_outbound_calls SET state='failed',updated_ms=? WHERE id=?").run(Date.now(), id); }
  /** Checks the callback token alone, so an unauthorized sender cannot make the server parse its body. */
  authorize(peerId: string, token: string | undefined): z.infer<typeof Outbound> {
    if (!token || token.length > 256 || !this.peers.some(peer => peer.enabled && peer.id === peerId)) throw new Error('A2A push is unauthorized');
    const row = this.db.prepare('SELECT id,peer_id,task_id FROM a2a_outbound_calls WHERE token_hash=?').get(digest(token));
    if (!row) throw new Error('A2A push is unauthorized');
    const call = Outbound.parse(row);
    if (call.peer_id !== peerId) throw new Error('A2A push is unauthorized');
    return call;
  }
  accept(peerId: string, token: string | undefined, raw: unknown): { duplicate: boolean; outboundId: string; taskId: string } {
    const call = this.authorize(peerId, token);
    const event = StreamCodec.fromJSON(raw);
    const payload = event.payload;
    if (!payload) throw new Error('A2A push event is malformed');
    const taskId = payload.$case === 'task' ? payload.value.id : payload.value.taskId;
    if (!taskId || taskId.length > 256 || (call.task_id && call.task_id !== taskId)) throw new Error('A2A push task does not match the outbound call');
    const body = JSON.stringify(StreamCodec.toJSON(event));
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('A2A push event exceeds 2 MiB');
    const id = digest(`${call.id}\n${body}`);
    return this.db.transaction(() => {
      const count = Count.parse(this.db.prepare('SELECT COUNT(*) AS count FROM a2a_inbound_push WHERE outbound_id=?').get(call.id)).count;
      const prior = this.db.prepare('SELECT 1 FROM a2a_inbound_push WHERE id=?').get(id);
      if (!prior && count >= 100) throw new Error('A2A push event limit reached');
      if (!call.task_id) this.db.prepare("UPDATE a2a_outbound_calls SET task_id=?,state='bound',updated_ms=? WHERE id=? AND task_id IS NULL").run(taskId, Date.now(), call.id);
      const inserted = this.db.prepare('INSERT OR IGNORE INTO a2a_inbound_push(id,outbound_id,task_id,event_json,received_ms) VALUES (?,?,?,?,?)').run(id, call.id, taskId, body, Date.now());
      return { duplicate: inserted.changes === 0, outboundId: call.id, taskId };
    })();
  }
  events(outboundId: string): StreamResponse[] {
    return this.db.prepare('SELECT event_json FROM a2a_inbound_push WHERE outbound_id=? ORDER BY received_ms,id LIMIT 100').all(outboundId)
      .map(row => { const parsed = EventRow.parse(row); return StreamCodec.fromJSON(JSON.parse(parsed.event_json) as unknown); });
  }
}
