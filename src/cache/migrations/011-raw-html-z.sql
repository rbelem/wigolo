-- Compressed HTML payload for url_cache.
--
-- `raw_html` holds the fetched page verbatim and dominated the cache size
-- (94.28 MB over 530 rows on the live DB, vs 6.43 MB of extracted markdown).
-- The HTML is still required — `extract {url}` reads the cached HTML as its
-- INPUT — so it is kept, but stored gzipped in the new `raw_html_z` BLOB.
--
-- New rows write `raw_html_z` and leave `raw_html` NULL. Legacy rows keep
-- `raw_html` set with `raw_html_z` NULL and are read through the same
-- accessor. No backfill here: this migration is schema-only, and the runner
-- wraps every migration in a transaction (VACUUM cannot run inside one).
--
-- This .sql file is a grep-mirror only — the runner.ts MIGRATIONS[] entry
-- (postStep-guarded on PRAGMA table_info, since SQLite has no
-- `ADD COLUMN IF NOT EXISTS`) is what actually runs.

ALTER TABLE url_cache ADD COLUMN raw_html_z BLOB;
