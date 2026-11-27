# wigolo verification map

This directory is the maintained source for verifying the user-facing behavior of wigolo. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Run from the repository root after `bun install --frozen-lockfile` and `bun run build`.
- Set `WIGOLO_DATA_DIR=/tmp/wigolo-verify-$RUN_ID` with a fresh directory for every run. Do not reuse a directory from another run.
- Run `bun run dev -- --version` and require the version in `package.json`.
- Run `bun run dev -- doctor --json` and require `status` of `ok` or `ok_with_warnings`, `exitCode` of `0`, and a `data-dir` check of `ok` naming this run's directory. An `embeddings` check of `failed` is expected on a fresh directory.
- Run `bun run dev -- cache stats --json` and require a `stats` object with `total_urls: 0`.
- Put `jq` and `curl` on `PATH`.
- Never drive a daemon or data directory that this run did not create.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Pass `--json` on every tool command. Parse stdout with `jq`. Never parse human-readable stderr.
- Capture stdout, stderr, and exit code for every command. Write them under `/tmp/wigolo-verify-$RUN_ID/artifacts/<feature-id>/`.
- Use `cache stats` and `cache search` as the second, read-only view that proves a fetch wrote to the local store.
- Mutations use a dedicated `WIGOLO_DATA_DIR`. A run never mutates the operator's `~/.wigolo`.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final response.
- CLI proof includes the exact command, stdout, stderr, and exit code.
- Mutation proof includes a read-only second view of the stored value.
- Record the feature ID and the entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the wigolo CLI` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Fetch a page](./fetch.md) covers a one-shot fetch, the JSON contract, and the cache row it leaves behind.
- [Search the web](./search.md) covers a cache-only search and an engine search with bounded output.
- [Inspect the cache](./cache.md) covers stats, cached-page search, and scoped clear.
- [Check installation health](./doctor.md) covers doctor, status, and the exit-code contract.
