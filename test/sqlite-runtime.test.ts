import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync as PriorDatabase } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import Database, { assertPatchedSqliteVersion } from '../src/sqlite.js';

describe('embedded SQLite security boundary', () => {
  it('rejects affected and unverifiable libraries independently of scanner feeds', () => {
    for (const version of ['3.9.0', '3.53.4', '3.54.0', '3.54', '3.54.1-unverified', '', undefined]) {
      expect(() => assertPatchedSqliteVersion(version)).toThrow();
    }
    for (const version of ['3.54.1', '3.54.10', '3.55.0', '4.0.0']) assertPatchedSqliteVersion(version);
  });

  it('executes the patched native FTS5 engine and preserves atomic rollback', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE documents USING fts5(body)');
      const write = db.prepare('INSERT INTO documents(body) VALUES (?)');
      const failed = db.transaction(() => { write.run('discarded'); throw new Error('fixture rollback'); });
      expect(failed).toThrow('fixture rollback');
      db.transaction(() => { expect(db.inTransaction).toBe(true); write.run('retained'); })();
      expect(db.inTransaction).toBe(false);
      expect(db.prepare("SELECT body FROM documents WHERE documents MATCH 'retained'").get()).toEqual({ body: 'retained' });
      expect(db.prepare("SELECT body FROM documents WHERE documents MATCH 'discarded'").all()).toEqual([]);
    } finally { db.close(); db.close(); }
  });
});

it('opens an existing SQLite database without replacing data and never creates a required missing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-runtime-fixture-'));
  try {
    const file = join(directory, 'fixture # database.sqlite');
    const legacy = new PriorDatabase(file);
    legacy.exec("CREATE TABLE retained(id INTEGER PRIMARY KEY,value TEXT NOT NULL UNIQUE); INSERT INTO retained VALUES(1,'synthetic retained value')");
    legacy.close();
    const db = new Database(file, { fileMustExist: true });
    db.prepare('INSERT INTO retained VALUES(?,?)').run(2, 'synthetic new value');
    db.close();
    const reader = new Database(file, { readonly: true, fileMustExist: true });
    try {
      expect(reader.prepare('SELECT value FROM retained ORDER BY id').all()).toEqual([
        { value: 'synthetic retained value' }, { value: 'synthetic new value' },
      ]);
      expect(() => reader.prepare('DELETE FROM retained').run()).toThrow();
      expect(reader.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { reader.close(); }
    const missing = join(directory, 'missing.sqlite');
    expect(() => new Database(missing, { fileMustExist: true })).toThrow();
    expect(existsSync(missing)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('preserves BLOB bytes as Buffers through single, multiple, and streamed reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ardent-blob-')), file = join(dir, 'existing.sqlite');
    const prior = new PriorDatabase(file);
    const bytes = Buffer.from([0, 255, 128, 1, 0]);
    prior.exec('CREATE TABLE uploads (id INTEGER PRIMARY KEY, data BLOB, note TEXT)');
    prior.prepare('INSERT INTO uploads VALUES (?,?,?)').run(1, bytes, 'retained');
    prior.prepare('INSERT INTO uploads VALUES (?,?,?)').run(2, null, 'empty'); prior.close();
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT data,note FROM uploads ORDER BY id');
      const expected = [{ data: bytes, note: 'retained' }, { data: null, note: 'empty' }];
      expect(rows.get()).toEqual(expected[0]); expect(rows.all()).toEqual(expected); expect([...rows.iterate()]).toEqual(expected);
      const first = rows.get(); if (!first || typeof first !== 'object' || !('data' in first)) throw new Error('Missing retained blob');
      expect(Buffer.isBuffer(first.data)).toBe(true);
      expect(db.prepare('SELECT * FROM uploads WHERE id=3').get()).toBeUndefined();
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

