import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from '../../../src/util/sqlite.js';
import * as sv from 'sqlite-vec';
import {
  getVectorStore,
  _resetVectorStoreForTest,
} from '../../../src/providers/vector-store.js';
import { SqliteVecStore } from '../../../src/cache/sqlite-vec-store.js';

vi.mock('../../../src/cache/db.js', async () => {
  // We construct a fresh in-memory db per test so the factory can call
  // getDatabase() without us needing to bootstrap the full cache init path.
  let db: Database.Database | null = null;
  return {
    getDatabase: vi.fn(() => {
      if (!db) {
        db = new Database(':memory:');
        sv.load(db);
        db.exec(`
          CREATE VIRTUAL TABLE vec_documents USING vec0(embedding float[4]);
          CREATE TABLE vec_id_map (rowid INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE);
          CREATE TABLE vec_metadata (
            rowid INTEGER PRIMARY KEY REFERENCES vec_id_map(rowid) ON DELETE CASCADE,
            url TEXT NOT NULL, content_hash TEXT NOT NULL, model_id TEXT NOT NULL,
            created_at INTEGER NOT NULL, extra_json TEXT
          );
        `);
      }
      return db;
    }),
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    isVecExtensionLoaded: vi.fn(() => true),
  };
});

describe('getVectorStore', () => {
  beforeEach(() => { _resetVectorStoreForTest(); });
  afterEach(() => { _resetVectorStoreForTest(); });

  it('returns SqliteVecStore', async () => {
    expect(await getVectorStore()).toBeInstanceOf(SqliteVecStore);
  });

  it('memoizes the resolved provider', async () => {
    const a = await getVectorStore();
    const b = await getVectorStore();
    expect(a).toBe(b);
  });
});
