# Fetch a page

Fetch turns a URL into clean markdown and stores the page in the local cache. A user runs it once from the terminal and reads the result as JSON.

## Sub-features

- `fetch-json` fetches a URL and returns one JSON document on stdout.
- `fetch-content` returns extracted markdown with a title and URL.
- `fetch-cache` leaves a row that a later cache search can read.
- `fetch-refresh` bypasses the cache when asked.

## How to get to it (user POV)

- Run `wigolo fetch https://example.com --json` in a terminal.
- Run the same command with `--force-refresh` to get fresh content.

## Driving it with the wigolo CLI

Preconditions:

- The baseline preconditions in `README.md` hold.
- The data directory is empty of cached pages.
- Network access to `https://example.com` is available.

- **Fetch once.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID timeout 180 bun run dev -- fetch https://example.com --json 2>/tmp/wigolo-verify-$RUN_ID/artifacts/fetch/fetch.stderr.log`. A cold first fetch can initialize the browser tier and embedding model. Give it 180 seconds. A later fetch from cache exits in a few seconds. Exit code is `0`. Capture stdout to `artifacts/fetch/fetch.stdout.json` and the exit code to `artifacts/fetch/fetch.exit`. The JSON has a `url` field containing `example.com` and non-empty `markdown` or `excerpt` content.
- **Inspect the side effect.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- cache search example.com --json 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/fetch/cache-after.stdout.json`. The result lists the fetched URL.
- **Force refresh.** Run `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- fetch https://example.com --force-refresh --json 2>/dev/null`. Exit code is `0`. Capture stdout to `artifacts/fetch/fetch-refresh.stdout.json`. The response time is present and the content is non-empty.
- **Proof.** The artifacts together show the user command, its JSON result, and the cache row written by that command.

## Gotchas

- Logs go to stderr. Redirect it or the captured stdout will not parse as JSON.
- The first fetch may download the browser engine or embedding model and can keep the process alive past 120 seconds. That is a real product path, not a mock. Use a 180-second timeout and confirm the JSON was written before treating exit 124 as a failure.
- `example.com` can be routed to the browser tier. A `multi-browser pool initialized` line on stderr is expected.
- Do not assert exact response times. Network and model warmup vary.
