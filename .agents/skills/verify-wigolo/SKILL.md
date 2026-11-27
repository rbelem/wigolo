---
name: verify-wigolo
description: "Drive the wigolo CLI and REST daemon the way a user does, from an isolated data directory, and capture proof. Use for /verify-wigolo or when a change to wigolo's CLI tools, MCP server, cache, or REST daemon needs live verification."
---

# Verify wigolo

wigolo is a local-first web-intelligence MCP server. Its primary user surface is the `wigolo` CLI: one-shot tools (`search`, `fetch`, `crawl`, `extract`, `cache`, `find-similar`, `diff`, `watch`) and management commands (`init`, `doctor`, `verify`, `status`, `serve`). A default invocation with no arguments starts the MCP server on stdio. `wigolo serve` starts the REST daemon. This skill drives the CLI and, where a feature needs it, the REST daemon.

Read `features/README.md` before driving anything. Use the matching feature file as the recipe. Start from the baseline state it describes.

## Launch

wigolo has no long-lived process for the one-shot tools. Each CLI invocation builds its own state from the data directory and exits. There is nothing to keep alive for `search`, `fetch`, `cache`, `extract`, and the management commands.

One-time setup from the repository root:

```bash
bun install --frozen-lockfile
bun run build
```

Then run every command from the repository root with an isolated data directory:

```bash
export WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID
mkdir -p "$WIGOLO_DATA_DIR"
bun run dev -- --version
```

Expected stdout: `wigolo 0.3.4` (the current package version). A non-zero exit or a missing version means the build or install is broken. Fix that before driving.

The first tool invocation creates `wigolo.db` in the data directory and applies all migrations, including the sqlite-vec and FTS5 tables. Readiness is a successful `doctor --json` with `status` of `ok` or `ok_with_warnings` and a `data-dir` check of `ok`, followed by a `cache --stats --json` call that returns a `stats` object. `ok_with_warnings` with an `embeddings` check of `failed` is expected on a fresh directory: that model downloads on first use. Do not treat it as a fault.

For the REST daemon, start a second shell and run:

```bash
export WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID
export WIGOLO_API_TOKEN=verify-token-$RUN_ID
bun run dev -- serve --port 3477
```

Readiness is `GET http://127.0.0.1:3477/health` returning HTTP 200 with `status:healthy`. The daemon refuses to start on a loopback bind without a token unless `--allow-unauthenticated` is passed. Use a token, not the override. Give every REST request `Authorization: Bearer $WIGOLO_API_TOKEN`.

Teardown is in `Cleanup` below. Do not leave a daemon running after a run.

## Doctor

Run this read-only check before any run and whenever behavior looks wrong:

```bash
WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- doctor --json
```

Require all of the following in the JSON on stdout:

- `status` is `ok` or `ok_with_warnings`, and `exitCode` is `0`.
- `version` matches `package.json`.
- The `data-dir` check has status `ok` and reports the exact directory set for this run.
- The `browser` check has status `ok`, or reports a documented missing-engine state you are prepared to install.
- No check reports a fault you cannot explain from the baseline preconditions.

For the daemon, also require `curl -fsS http://127.0.0.1:3477/health` to return `status:healthy` and that the process was started by this run on the port this run chose. Never drive a daemon you did not start.

## Drive

Commands are literal. Keep `--json` and quoted arguments exactly as written in a feature file. `wigolo` writes every log, warning, and error to stderr and exactly one JSON document to stdout when `--json` is passed. Redirect stderr away from a parse target:

```bash
WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID bun run dev -- search "zig comptime" --json 2>/tmp/wigolo-verify-$RUN_ID/stderr.log
```

Capture stdout, stderr, and the exit code for every command. Use `jq` to assert fields, not string matching on human-readable output. For the REST daemon, use `curl -sS -w '\n%{http_code}\n'` so the response body and status code are both captured.

Prefer stable handles. For CLI tools those are the JSON field names in the tool contract, the command names from `wigolo --help`, and the exact output fields named in each feature file. For REST they are the route paths in `/openapi.json`. Do not depend on log ordering or terminal formatting.

## Evidence

Write artifacts under `/tmp/wigolo-verify-$RUN_ID/artifacts/<feature-id>/`. Name each file after the action it proves, for example `fetch.stdout.json`, `fetch.stderr.log`, `fetch.exit`, and `cache-after.stdout.json`.

Proof standards:

- Exercise the real user path. Run the CLI command or REST route a user would run. Do not call internal functions, test-only endpoints, or module internals.
- Capture the action and the resulting state. A `fetch` proof includes the fetch response and a later read-only `cache` view of the stored row.
- Verify side effects. For cache and watch features, assert the database row or file that the action wrote, not just the JSON the action returned.
- Mocks are allowed only where a production boundary already isolates an external system. wigolo's `--no-warmup` and cache-only search depth are real product modes, not mocks. State in the artifact which mode was used.
- Verify what a safe mode actually skips by observing files, network calls, and git refs. Do not trust the word `dry-run` by itself.
- Record the feature ID and the entry point used with every artifact.
- When a precondition is missing, report the attempted command and the unmet precondition. Do not mark a feature verified through a different entry point.

## Cleanup

Kill only the daemon process this run started. Record its PID when launching `serve`, then:

```bash
kill "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true
```

Never kill by process name. Never kill a daemon you did not start. Remove the data directory and all of its database files after the run. Use `find /tmp/wigolo-verify-$RUN_ID -mindepth 1 -maxdepth 1 ! -name artifacts -exec rm -rf {} +`. This removes `wigolo.db`, `jobs.db`, and their WAL sidecars while keeping `/tmp/wigolo-verify-$RUN_ID/artifacts` untouched. Proof artifacts survive teardown. If cleanup removes them, the run failed.

## Helpers

No helper scripts ship with this skill. Run the commands above directly from the repository root. The repo's own `scripts/verify-channel-rest.sh` is available as a broader REST contract check, but it starts its own daemons and data directories. Do not combine it with a run from this skill in the same data directory.
