# Contributing to wigolo

Thanks for your interest in improving wigolo. This document covers how to get set
up, how to propose changes, and the contribution terms.

## Development setup

Requires **Bun ≥ 1.4** (primary runtime, package manager, and script runner).
Node 22+ is still needed for the `@yao-pkg/pkg` single-file binary channel and
for `npm publish`; everything else runs under Bun.

```bash
bun install                  # uses bun.lock (frozen in CI)
bun run build                # tsup + tsc -> dist/
bun run test                 # full vitest suite
bun run test:unit            # unit tests only
bun run lint                 # tsc --noEmit
```

`bun run dev` runs the CLI directly from TypeScript (`bun src/index.ts`).

## SQLite / native modules

`bun:sqlite` is used under Bun; `better-sqlite3` is used under Node (npm
tarball and packaged binary). Both go through the compatibility adapter in
`src/util/sqlite.ts`, so callers use the same API. `sqlite-vec` works with both.
If you add a new SQLite call, keep it to the shared API surface (`prepare`,
`exec`, `pragma`, `transaction`, `loadExtension`, `close`).

Because native addons are ABI-bound, run `bun install` inside the devbox shell
(`devbox shell`) — its `bun` and Node versions are pinned in `devbox.json`.

## Proposing changes

1. Open an issue first for anything non-trivial so we can agree on the approach.
2. Branch from `main`, keep changes focused, and add tests for new behavior.
3. Use [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `test:`, `refactor:`, `chore:`, `docs:`).
4. Make sure `bun run test` and `bun run lint` pass before opening a PR.
5. Open a pull request describing the change and why it matters.

## Guidelines

- Prefer the smallest change that fully solves the problem.
- Match the surrounding code style. Minimal comments — only where the "why" is
  non-obvious.
- All logging goes to stderr (stdout is reserved for the MCP stdio protocol).
- Don't add dependencies without a clear need; note new deps in the PR.

## Contributor License Agreement (CLA)

By submitting a contribution (a pull request, patch, or any other work) to this
project, you agree to the following:

1. **License of your contribution.** You license your contribution to the project
   and to everyone downstream under the same license as the project
   (GNU AGPL-3.0-only).

2. **Grant to the maintainer.** You additionally grant the project maintainer a
   perpetual, worldwide, non-exclusive, royalty-free, irrevocable copyright and
   patent license to reproduce, modify, distribute, sublicense, and **relicense**
   your contribution, including under different license terms (for example, a
   commercial license). This lets the project offer commercial licensing
   alongside the open-source AGPL release.

3. **You have the right to grant this.** You certify that the contribution is your
   original work (or that you have the right to submit it) and that, to your
   knowledge, it does not infringe anyone else's rights.

4. **No warranty.** Your contribution is provided "as is", without warranty of
   any kind.

If you are contributing on behalf of an employer, you confirm you have permission
to do so. If you cannot agree to these terms, please open an issue to discuss
before contributing.
