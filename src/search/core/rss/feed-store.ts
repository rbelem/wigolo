import type Database from '../../../util/sqlite.js';
import { getDatabase } from '../../../cache/db.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('search');

export interface FeedStoreItem {
  id: number;
  feedUrl: string;
  guid: string;
  title: string;
  link: string;
  summary: string;
  publishedDate?: string;
  category: string;
  fetchedAt: string;
}

export interface FeedStoreQueryOptions {
  maxResults?: number;
  fromDate?: string;
  toDate?: string;
  category?: string;
}

interface Stmts {
  insert: Database.Statement;
  count: Database.Statement;
  clear: Database.Statement;
  clearFts: Database.Statement;
}

let cachedDb: Database.Database | null = null;
let cachedStmts: Stmts | null = null;

function stmts(): { db: Database.Database; s: Stmts } {
  const db = getDatabase();
  if (cachedDb !== db) {
    cachedDb = db;
    cachedStmts = {
      insert: db.prepare(
        `INSERT OR IGNORE INTO feed_items
         (feed_url, guid, title, link, summary, published_date, category, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      count: db.prepare('SELECT COUNT(*) AS n FROM feed_items'),
      clear: db.prepare('DELETE FROM feed_items'),
      clearFts: db.prepare("INSERT INTO feed_items_fts(feed_items_fts) VALUES('rebuild')"),
    };
  }
  return { db, s: cachedStmts! };
}

// FTS5 reserves characters; quote each token to be safe.
function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return tokens.join(' ');
}

export function upsertFeedItems(items: Array<{
  feedUrl: string; guid: string; title: string; link: string;
  summary: string; publishedDate?: string; category?: string;
}>): number {
  if (items.length === 0) return 0;
  const { db, s } = stmts();
  const now = new Date().toISOString();
  let added = 0;
  const tx = db.transaction(() => {
    for (const it of items) {
      const res = s.insert.run(
        it.feedUrl,
        it.guid,
        it.title,
        it.link,
        it.summary,
        it.publishedDate ?? null,
        it.category ?? 'news',
        now,
      );
      if (res.changes > 0) added += 1;
    }
  });
  try {
    tx();
  } catch (err) {
    log.error('feed_items upsert failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return added;
}

interface RawRow {
  id: number;
  feed_url: string;
  guid: string;
  title: string;
  link: string;
  summary: string;
  published_date: string | null;
  category: string;
  fetched_at: string;
}

function rowToItem(r: RawRow): FeedStoreItem {
  const item: FeedStoreItem = {
    id: r.id,
    feedUrl: r.feed_url,
    guid: r.guid,
    title: r.title,
    link: r.link,
    summary: r.summary,
    category: r.category,
    fetchedAt: r.fetched_at,
  };
  if (r.published_date) item.publishedDate = r.published_date;
  return item;
}

export function queryFeedStore(query: string, options: FeedStoreQueryOptions = {}): FeedStoreItem[] {
  const { db } = stmts();
  const max = options.maxResults ?? 10;
  const safe = sanitizeFtsQuery(query);
  if (!safe) return [];

  const clauses: string[] = [];
  const params: Array<string | number> = [safe];

  if (options.fromDate) {
    clauses.push('feed_items.published_date >= ?');
    params.push(options.fromDate);
  }
  if (options.toDate) {
    clauses.push('feed_items.published_date <= ?');
    params.push(options.toDate);
  }
  if (options.category) {
    clauses.push('feed_items.category = ?');
    params.push(options.category);
  }

  const where = clauses.length > 0 ? ' AND ' + clauses.join(' AND ') : '';
  params.push(max);

  const sql = `
    SELECT feed_items.*
    FROM feed_items_fts
    JOIN feed_items ON feed_items.id = feed_items_fts.rowid
    WHERE feed_items_fts MATCH ?${where}
    ORDER BY bm25(feed_items_fts)
    LIMIT ?
  `;
  try {
    const rows = db.prepare(sql).all(...params) as RawRow[];
    return rows.map(rowToItem);
  } catch (err) {
    log.warn('feed_items_fts query failed', {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function countFeedItems(): number {
  try {
    const { s } = stmts();
    const row = s.count.get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    // Table missing — treat as empty.
    return 0;
  }
}

export function _clearFeedStoreForTest(): void {
  try {
    const { s } = stmts();
    s.clear.run();
    s.clearFts.run();
  } catch {
    // ignore — store may not be initialized in this test
  }
}
