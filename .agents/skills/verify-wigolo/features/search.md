# Search the web

Search returns a ranked set of web results with evidence excerpts. A user runs one query from the terminal and reads either an evidence document or a synthesized answer.

## Sub-features

- `search-cache` returns results from the local cache only.
- `search-engines` queries the configured engines through the full pipeline.
- `search-bounded` caps result count and output size.
- `search-evidence` returns citations in a stable format.

## How to get to it (user POV)

- Run `wigolo search "zig comptime" --json` in a terminal.
- Run `wigolo search "zig comptime" --search-depth=ultra-fast --json` for a cache-only answer.

## Driving it with the wigolo CLI

Preconditions:

- The baseline preconditions in `README.md` hold.
- No LLM key is required. Omit `--format=answer` so the command returns evidence.

- **Cache-only miss.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- search "zig comptime" --search-depth=ultra-fast --json 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/search/cache-only.stdout.json`. The JSON has a `results` array and a `notice` explaining the cache miss.
- **Engine search.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- search "zig comptime" --max-results=2 --search-engines=ddg --search-depth=fast --json 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/search/engines.stdout.json` and the exit code to `artifacts/search/engines.exit`. The JSON has a `results` array with at most two objects. Each object has `title` and `url`.
- **Citation format.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- search "zig comptime" --max-results=1 --citation-format=json --search-depth=fast --json 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/search/citations.stdout.json`. The top-level JSON has a `citations` array.
- **Proof.** The artifacts show the user command and a stable evidence shape. Do not assert exact result URLs or scores.

## Gotchas

- `ultra-fast` is cache-only. A miss is a valid result, not a failure.
- Engine availability varies by runner. Use `--search-engines=ddg` to bound the run.
- `--format=answer` calls an LLM or falls back to evidence. Leave it off for a keyless proof.
- Results change over time. Assert shape, field names, and result count, not content.
