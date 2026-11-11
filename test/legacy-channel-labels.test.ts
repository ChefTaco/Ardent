import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Database } from '../src/sqlite.js';
import { TaskStore } from '../src/store.js';
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
it('retains legacy inbound identities and never reclassifies an unknown or known receipt', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'ardent-channel-legacy-')); directories.push(dir); const file = join(dir, 'journal.sqlite');
 const old = new Database(file);
 old.exec(`CREATE TABLE channel_inbound(platform TEXT NOT NULL,account TEXT NOT NULL,update_id TEXT NOT NULL,task_id TEXT,created_ms INTEGER NOT NULL,
 channel_type TEXT NOT NULL DEFAULT 'unknown' CHECK(channel_type IN('unknown','telegram_private','telegram_group','telegram_supergroup','chattermost_dm','chattermost_channel')),PRIMARY KEY(platform,account,update_id));
 INSERT INTO channel_inbound VALUES('chattermost','fixture-account','historical',NULL,1,'chattermost_dm');
 INSERT INTO channel_inbound VALUES('chattermost','fixture-account','unclassified',NULL,2,'unknown');`);
 const before = old.prepare('SELECT * FROM channel_inbound ORDER BY update_id').all(); old.close();
 const store = new TaskStore(file);
 try {
  expect(store.db.prepare('SELECT * FROM channel_inbound ORDER BY update_id').all()).toEqual(before);
  expect(store.claimInbound('chattermost','fixture-account','historical','chattermost_dm')).toEqual({claimed:false,taskId:null});
  expect(store.claimInbound('chattermost','fixture-account','unclassified','chattermost_dm').claimed).toBe(false);
  expect(store.db.prepare("SELECT channel_type FROM channel_inbound WHERE update_id='unclassified'").get()).toEqual({channel_type:'unknown'});
  expect(()=>store.claimInbound('chattermost','fixture-account','historical','chattermost_channel')).toThrow('Inbound channel type changed');
  expect(store.claimInbound('chattermost','fixture-account','new','chattermost_dm').claimed).toBe(true);
  expect(()=>store.claimInbound('telegram','fixture-account','wrong','chattermost_dm')).toThrow('differs from platform');
  expect(()=>store.claimInbound('chattermost','fixture-account','wrong','telegram_private')).toThrow('differs from platform');
 } finally {store.close();}
});
it('new journals accept both transport labels without merging their distinct receipt identities', async()=>{
 const dir = await mkdtemp(join(tmpdir(), 'ardent-channel-current-'));directories.push(dir);const store = new TaskStore(join(dir,'journal.sqlite'));
 try {
  expect(store.claimInbound('chattermost','fixture-account','message','chattermost_dm').claimed).toBe(true);
  expect(store.claimInbound('mattermost','fixture-account','message','mattermost_dm').claimed).toBe(true);
  expect(store.db.prepare('SELECT platform,channel_type FROM channel_inbound ORDER BY platform').all()).toEqual([{platform:'chattermost',channel_type:'chattermost_dm'},{platform:'mattermost',channel_type:'mattermost_dm'}]);
 } finally {store.close();}
});
