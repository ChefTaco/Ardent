import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { initTestProfile } from './helpers.js';
import { ArdentRuntime } from '../src/runtime.js';
import { ChannelCore, DeliveryRejectedError, type ChannelEvent, type ChannelReply } from '../src/channels.js';
import { TaskStore } from '../src/store.js';
import { JobEngine } from '../src/job-engine.js';

const dirs: string[] = [];
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'ardent-channel-')); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('shared channel state', () => {
  it('migrates old inbound rows to unknown and never relabels a claimed channel type', async () => {
    const dir = await temp();
    const stateDir = join(dir, 'state');
    await mkdir(stateDir);
    const path = join(stateDir, 'legacy.sqlite');
    const old = new Database(path);
    old.exec(`CREATE TABLE channel_inbound (
      platform TEXT NOT NULL, account TEXT NOT NULL, update_id TEXT NOT NULL,
      task_id TEXT, created_ms INTEGER NOT NULL,
      PRIMARY KEY(platform,account,update_id));
      INSERT INTO channel_inbound VALUES ('mattermost','bot','old-post',NULL,1);`);
    old.close();
    const store = new TaskStore(path);
    try {
      const type = (updateId: string) => store.db.prepare(`SELECT channel_type FROM channel_inbound
        WHERE platform='mattermost' AND account='bot' AND update_id=?`).get(updateId);
      expect(type('old-post')).toEqual({ channel_type: 'unknown' });
      expect(store.claimInbound('mattermost', 'bot', 'old-post', 'mattermost_dm'))
        .toEqual({ claimed: false, taskId: null });
      expect(type('old-post')).toEqual({ channel_type: 'unknown' });
      expect(store.claimInbound('mattermost', 'bot', 'new-post', 'mattermost_dm'))
        .toEqual({ claimed: true, taskId: null });
      expect(type('new-post')).toEqual({ channel_type: 'mattermost_dm' });
      expect(store.claimInbound('mattermost', 'bot', 'new-post', 'mattermost_dm'))
        .toEqual({ claimed: false, taskId: null });
      expect(() => store.claimInbound('mattermost', 'bot', 'new-post', 'mattermost_channel'))
        .toThrow('channel type changed');
      expect(() => store.claimInbound('telegram', 'bot', 'wrong-platform', 'mattermost_dm'))
        .toThrow('differs from platform');
      expect(() => store.db.prepare(`UPDATE channel_inbound SET channel_type='mattermost_channel'
        WHERE platform='mattermost' AND account='bot' AND update_id='new-post'`).run())
        .toThrow('Inbound channel type is immutable');
    } finally { store.close(); }
    const reopened = new TaskStore(path);
    try { expect(reopened.db.prepare("SELECT channel_type FROM channel_inbound WHERE update_id='old-post'").get())
      .toEqual({ channel_type: 'unknown' }); }
    finally { reopened.close(); }
  });
  it('reports profile status and installed job definitions without claiming delivery', async () => {
    const dir = await temp();
    await initTestProfile(dir, { profile: 'coordinator' });
    const runtime = new ArdentRuntime(dir, (await loadConfig(dir)).config);
    const replies: ChannelReply[] = [];
    const event: ChannelEvent = { platform: 'telegram', account: 'coordinator-bot', user: 'operator', conversation: 'chat', thread: null,
      update_id: 'status-1', reply_to: null, text: '/status', attachments: [], authorized: true, bot_message: false };
    const deliver = async (reply: ChannelReply) => { replies.push(reply); return 'telegram-message'; };
    try {
      await new ChannelCore(runtime).handle(event, deliver);
      expect(replies.at(-1)?.text).toContain('coordinator is running');
      await new ChannelCore(runtime).handle({ ...event, update_id: 'jobs-0', text: '/jobs' }, deliver);
      expect(replies.at(-1)?.text).toContain('No scheduled job definitions');
      await mkdir(join(dir, 'jobs'), { recursive: true });
      await writeFile(join(dir, 'jobs', 'active.json'), JSON.stringify({ schema_version: 1, profile: 'coordinator', revision: 3, jobs: [] }));
      const engine = new JobEngine(runtime.store.db, dir, 'coordinator', {}, async () => {});
      await engine.load();
      await new ChannelCore(runtime, {}, engine).handle({ ...event, update_id: 'jobs-1', text: '/jobs' }, deliver);
      expect(replies.at(-1)?.text).toContain('Job definitions revision 3');
      expect(replies.at(-1)?.text).toContain('No job windows recorded yet');
    } finally { runtime.close(); }
  });
  it('delivers a completed task after a crash only when no send was attempted', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    const first = new ArdentRuntime(dir, config);
    const event: ChannelEvent = { platform: 'telegram', account: 'bot', user: 'user', conversation: 'chat', thread: null, update_id: 'update-1', reply_to: 'message-1', text: 'Research', attachments: [], authorized: true, bot_message: false };
    const session = first.store.session('telegram:bot:user', 'direct', 'telegram:bot:chat:');
    first.store.claimInbound('telegram', 'bot', 'update-1');
    const task = first.accept('Research', 'telegram:bot:user', 'direct', 'telegram:bot:update-1', session.id);
    first.store.bindInboundTask('telegram', 'bot', 'update-1', task.id);
    first.store.setState(task.id, 'completed', 'Recovered answer');
    first.close();
    const restarted = new ArdentRuntime(dir, config);
    const delivered: ChannelReply[] = [];
    try {
      const result = await new ChannelCore(restarted).handle(event, async reply => { delivered.push(reply); return 'remote-1'; });
      expect(result).toMatchObject({ duplicate: true, taskId: task.id, delivery: 'sent' });
      expect(delivered[0]?.text).toBe('Recovered answer');
      expect(restarted.store.delivery('telegram', 'bot', 'update-1')?.state).toBe('sent');
    } finally { restarted.close(); }
  });
  it('keeps an interrupted queued send uncertain and does not send twice', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const config = (await loadConfig(dir)).config;
    const first = new ArdentRuntime(dir, config);
    const event: ChannelEvent = { platform: 'telegram', account: 'bot', user: 'user', conversation: 'chat', thread: null, update_id: 'update-2', reply_to: 'message-2', text: 'Research', attachments: [], authorized: true, bot_message: false };
    first.store.claimInbound('telegram', 'bot', 'update-2');
    const task = first.accept('Research', 'telegram:bot:user', 'direct', 'telegram:bot:update-2');
    first.store.bindInboundTask('telegram', 'bot', 'update-2', task.id);
    first.store.setState(task.id, 'completed', 'Original answer');
    first.store.queueDelivery('telegram', 'bot', 'update-2', task.id);
    first.close();
    const restarted = new ArdentRuntime(dir, config);
    let sends = 0;
    try {
      const result = await new ChannelCore(restarted).handle(event, async () => { sends++; return 'should-not-send'; });
      expect(result.delivery).toBe('unknown');
      expect(sends).toBe(0);
    } finally { restarted.close(); }
  });
  it('isolates session keys, handles commands, and records sent, failed, and uncertain delivery', async () => {
    const dir = await temp();
    await initTestProfile(dir);
    const runtime = new ArdentRuntime(dir, (await loadConfig(dir)).config);
    const core = new ChannelCore(runtime);
    const base: ChannelEvent = { platform: 'telegram', account: 'bot-1', user: 'user-1', conversation: 'chat-1', thread: null, update_id: '1', reply_to: 'message-1', text: '/status', attachments: [], authorized: true, bot_message: false };
    const replies: ChannelReply[] = [];
    const sent = async (reply: ChannelReply): Promise<string> => { replies.push(reply); return 'external-1'; };
    try {
      expect((await core.handle(base, sent)).delivery).toBe('sent');
      expect(replies[0]?.text).toContain('Session:');
      const originalSession = runtime.store.session('telegram:bot-1:user-1', 'direct', 'telegram:bot-1:chat-1:').id;
      expect((await core.handle(base, sent)).duplicate).toBe(true);
      expect(replies).toHaveLength(1);
      await core.handle({ ...base, update_id: '2', text: '/model codex' }, sent);
      expect(runtime.store.channelBackend('telegram:bot-1:user-1', 'telegram:bot-1:chat-1:')).toBe('codex');
      await core.handle({ ...base, update_id: '3', text: '/new' }, sent);
      expect(runtime.store.session('telegram:bot-1:user-1', 'direct', 'telegram:bot-1:chat-1:').id).not.toBe(originalSession);
      expect(runtime.store.session('telegram:bot-1:user-1', 'direct', 'telegram:bot-1:chat-1:thread-1').id).not.toBe(originalSession);
      expect(runtime.store.session('mattermost:bot-1:user-1', 'direct', 'mattermost:bot-1:chat-1:').id).not.toBe(originalSession);
      const rejected = await core.handle({ ...base, update_id: '4', text: '/help' }, async () => { throw new DeliveryRejectedError('HTTP 403'); });
      expect(rejected.delivery).toBe('failed');
      expect(runtime.store.delivery('telegram', 'bot-1', '4')?.state).toBe('failed');
      const uncertain = await core.handle({ ...base, update_id: '5', text: '/help' }, async () => { throw new Error('Connection reset after send'); });
      expect(uncertain.delivery).toBe('unknown');
      expect((await core.handle({ ...base, update_id: '5', text: '/help' }, sent)).duplicate).toBe(true);
      expect(replies).toHaveLength(3);
      expect((await core.handle({ ...base, update_id: '6', bot_message: true }, sent)).delivery).toBeNull();
    } finally { runtime.close(); }
  });
});
