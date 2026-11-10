import { pathToFileURL } from 'node:url';

// The native module bundles patched SQLite independently of the host Node version.
import { DatabaseSync, StatementSync, backup, enhance } from '@photostructure/sqlite';


function sqliteOperation<T>(action: () => T): T {
  try { return action(); } catch (error) {
    if (error instanceof Error && 'sqliteCodeName' in error && typeof error.sqliteCodeName === 'string') {
      // Preserve native numeric details while keeping existing busy/locked retry behavior.
      Object.assign(error, { code: error.sqliteCodeName });
    }
    throw error;
  }
}

type Options = { readonly?: boolean; fileMustExist?: boolean; timeout?: number };

export function assertPatchedSqliteVersion(version: unknown): void {
  const match = typeof version === 'string' ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version) : null;
  if (!match) throw new Error('Cannot verify embedded SQLite version');
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major === undefined || minor === undefined || patch === undefined ||
      !(major > 3 || (major === 3 && (minor > 54 || (minor === 54 && patch >= 1))))) {
    throw new Error('Embedded SQLite 3.54.1 or later is required');
  }
}

/** Application storage boundary. Keep transaction ownership on the same connection. */
class Statement {
  constructor(private readonly statement: StatementSync) {}
  run(...parameters: unknown[]): ReturnType<StatementSync['run']> { return sqliteOperation(() => this.statement.run(...parameters)); }
  get(...parameters: unknown[]): unknown { return sqliteOperation(() => this.statement.get(...parameters)); }
  all(...parameters: unknown[]): unknown[] { return sqliteOperation(() => this.statement.all(...parameters)); }
  iterate(...parameters: unknown[]): IterableIterator<unknown> { return this.statement.iterate(...parameters); }
}

export class Database {
  readonly #database: ReturnType<typeof enhance<DatabaseSync>>;

  constructor(path: string, options: Options = {}) {
    let location: string | URL = path;
    if (options.fileMustExist) {
      if (path === ':memory:') throw new Error('An existing on-disk database is required');
      const uri = pathToFileURL(path);
      uri.searchParams.set('mode', options.readonly ? 'ro' : 'rw');
      location = uri;
    }
    this.#database = enhance(new DatabaseSync(location, {
      readOnly: options.readonly ?? false,
      timeout: options.timeout ?? 5000,
    }));
    try {
      const row: unknown = this.#database.prepare('SELECT sqlite_version() AS version').get();
      assertPatchedSqliteVersion(row !== null && typeof row === 'object' && 'version' in row ? row.version : undefined);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  get inTransaction(): boolean { return this.#database.isTransaction; }
  get open(): boolean { return this.#database.isOpen; }
  prepare(sql: string): Statement { return new Statement(sqliteOperation(() => this.#database.prepare(sql))); }
  exec(sql: string): this { sqliteOperation(() => this.#database.exec(sql)); return this; }
  pragma(sql: string, options?: { simple?: boolean }): unknown { return sqliteOperation(() => this.#database.pragma(sql, options)); }
  transaction<F extends (...args: never[]) => unknown>(fn: F) {
    return this.#database.transaction(fn);
  }
  async backup(destination: string): Promise<void> { await backup(this.#database, destination); }
  close(): void { if (this.#database.isOpen) this.#database.close(); }
}

export default Database;
