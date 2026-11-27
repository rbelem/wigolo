# Inspect the cache

The cache stores fetched pages and their full-text index. A user reads stats, searches cached pages, and clears entries with scoped filters.

## Sub-features

- `cache-stats` reports page count and size.
- `cache-search` finds cached pages by keyword.
- `cache-clear` removes entries matching a query or URL pattern.

## How to get to it (user POV)

- Run `wigolo cache stats --json` in a terminal.
- Run `wigolo cache search example --json` to find cached pages.
- Run `wigolo cache clear --url-pattern='*example.com*' --json` to remove them.

## Driving it with the wigolo CLI

Preconditions:

- The fetch feature has run in this data directory, or the user has cached pages another way.
- No other instance is writing to this data directory.

- **Read stats.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- cache stats --json 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/cache/stats-before.stdout.json`. The JSON has a `stats` object with `total_urls` and `total_size_mb`.
- **Search cached pages.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- cache search example.com --json 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/cache/search.stdout.json`. The result contains at least one cached URL when fetch ran first.
- **Clear by pattern.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- cache clear --url-pattern='*example.com*' --json 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/cache/clear.stdout.json`. The JSON reports the number of cleared rows.
- **Confirm the clear.** Repeat the stats command and capture to `artifacts/cache/stats-after.stdout.json`. `total_urls` decreased by the number of cleared rows.
- **Proof.** The four artifacts show the action and the read-only state before and after it.

## Gotchas

- `cache clear` without a filter removes everything. Always scope it with `--url-pattern` or `--query`.
- Stats count rows, not HTTP requests. A refreshed page can overwrite a row.
- The FTS index updates through triggers. A search immediately after a clear can lag by one transaction.
