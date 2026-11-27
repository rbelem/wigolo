/**
 * Runtime-neutral SQLite driver.
 *
 * wigolo runs in two modes:
 *   - Bun (dev, CI): the pinned better-sqlite3 v12 addon cannot load in Bun
 *     (V8 APIs Bun does not implement — oven-sh/bun#4290/#16050; the shim PR
 *     #36712 was closed unmerged). Bun's built-in `bun:sqlite` has a
 *     near-identical API, so this module transparently uses it when `Bun` is
 *     present.
 *   - Node (npm tarball, @yao-pkg/pkg single-file binary): better-sqlite3 is
 *     kept because the binary's require-hook extracts its .node addon from the
 *     /snapshot VFS and sqlite-vec's loadable extension works unchanged.
 *
 * The two APIs differ in one place wigolo relies on: better-sqlite3 has a
 * `.pragma()` method; `bun:sqlite` does not. The Bun-side wrapper below
 * implements it by preparing a `PRAGMA ...` query and returning rows in the
 * same shape as better-sqlite3 (an array, or a scalar with `{ simple: true }`).
 *
 * The require is synchronous and lazily evaluated under a `typeof Bun` guard,
 * so Node never tries to resolve the `bun:` protocol and the ESM source stays
 * free of top-level await (required by the CJS binary bundle).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/** Minimal shape shared by both drivers; see src/cache/db.ts for usage. */
export interface PragmaOptions {
  simple?: boolean;
}

export class Database {
  private readonly native: any;

  constructor(path: string, options: Record<string, unknown> = {}) {
    if (isBun) {
      const { Database: BunDatabase } = require('bun:sqlite') as any;
      // bun:sqlite's constructor takes a path; readonly + create controls
      // map to open()/flags where supported. Most callers use defaults.
      this.native = new BunDatabase(path, options as any);
    } else {
      const BetterSqlite3 = require('better-sqlite3') as any;
      this.native = new BetterSqlite3(path, options as any);
    }
  }

  /** Forward the common better-sqlite3 API straight to the underlying driver. */
  prepare(sql: string): any {
    return this.native.prepare(sql);
  }

  exec(sql: string): any {
    return this.native.exec(sql);
  }

  run(sql: string, ...params: unknown[]): any {
    return this.native.run(sql, ...params);
  }

  query(sql: string): any {
    return this.native.query?.(sql) ?? this.native.prepare(sql);
  }

  transaction(fn: (...args: any[]) => any): any {
    return this.native.transaction(fn);
  }

  loadExtension(path: string): void {
    this.native.loadExtension(path);
  }

  close(): void {
    this.native.close();
  }

  /**
   * better-sqlite3-compatible PRAGMA access. Bun's SQLite lacks `.pragma()`,
   * so translate to a prepared `PRAGMA` query. better-sqlite3 returns an array
   * of row objects (or a single scalar for `{ simple: true }`); match that
   * exactly.
   */
  pragma(source: string, options: PragmaOptions = {}): any {
    if (!isBun) {
      return this.native.pragma(source, options);
    }
    const rows = this.native.query('PRAGMA ' + source).all() as Record<string, unknown>[];
    if (options.simple) {
      if (rows.length === 0) return undefined;
      const first = rows[0] as Record<string, unknown>;
      const keys = Object.keys(first);
      return keys.length === 1 ? first[keys[0]] : first;
    }
    return rows;
  }
}

export default Database;

// better-sqlite3 uses a namespace for `Database.Database` and `Database.Statement`.
// Keep those type names so existing annotations across src/ and tests/ compile
// unchanged on both runtimes.
export namespace Database {
  export type Database = import('./sqlite.js').Database;
  export type Statement = ReturnType<import('./sqlite.js').Database['prepare']>;
}
