# Channel Release Runbook

Per-release checklist for pushing a new wigolo version across every distribution
channel. Nothing here runs automatically — each step is a deliberate release act.
Do them in order; npm publish gates everything downstream (the formula url/sha
and the Docker build both point at the published artifact).

## 0. SDK contract drift gate (pre-publish)

- Run `scripts/verify-sdks.sh` (or `npm run test:sdk:ts && npm run test:sdk:py`).
  The SDK drift tests validate both clients against the live `/openapi.json` —
  any REST contract change since the last release fails here, BEFORE anything
  publishes. Fix the SDK manifests/types (or revert the contract change) first.
- SDK package publishing (npm + PyPI) is a SEPARATE, deliberate act with its own
  naming/licensing decisions — not part of this runbook until those are settled.

## 0.5. Skill-pack hash ledger (pre-publish, only when `skills/` changed)

- If this release changes ANY file under `skills/`, regenerate the ledger before
  bumping: `node scripts/gen-legacy-skill-hashes.mjs`. It is a UNION — it seeds
  from the committed manifest, scans BOTH historical roots (`assets/skills/**`
  and `skills/**`) at every relevant commit and every release tag, and walks the
  working tree — so it can only add hashes, never drop them.
- Verify, do not assume: the run must report no shrink, and the previous release
  tag's `skills/**` bytes must be in the output. Check both explicitly:
  `git diff --stat assets/legacy-skill-hashes.json` (additions only) and a
  per-file comparison against `<last-published-tag>`'s tree. A shallow clone or a
  rewritten history reproduces only a subset of the historical bytes — if the
  seeded count is lower than the manifest's current total, STOP; fix the clone
  (fetch the tags/history) rather than committing a smaller ledger. Without the
  previous release's hashes, `wigolo skills remove` / `wigolo uninstall` refuses
  to clean receipt-less installs (the safe-remove fallback matches known
  canonical bytes only).
- Also check the gate condition itself:
  `git diff --quiet <last-published-tag> HEAD -- skills assets/skills || echo "skills changed: ledger required"`.
- Binary channel note: `packaging/binary/pkg.config.json` globs `skills/**/*` —
  pkg globs that match nothing WARN instead of failing, so binary re-validation
  (`scripts/verify-channel-binary.sh`) must include a skills-touching smoke
  (`wigolo skills list`) to catch a silently empty snapshot.

## 1. npm publish (source of truth)

- Handled by existing CI on the release tag (`make release-tag`). No manual
  `npm publish`.
- Confirm the version is live before touching any other channel:
  `npm view wigolo@<version> dist.tarball`

## 2. Homebrew formula refresh — `packaging/homebrew/wigolo.rb`

1. Set `url` to the published tarball:
   `https://registry.npmjs.org/wigolo/-/wigolo-<version>.tgz`
2. Fetch the real digest and replace the `PLACEHOLDER_REFRESHED_AT_RELEASE`
   sha256:
   `curl -sL <tarball-url> | shasum -a 256`
3. `depends_on "node@22"` stays pinned — do not float it (see the formula
   header for why). Bump the major only as a deliberate, tested change.

## 3. Tap repo — `homebrew-wigolo`

- The formula is consumed from a tap, not this repo.
- First release: create the public tap repo `<org>/homebrew-wigolo`, add
  `Formula/wigolo.rb`.
- Every release: copy the refreshed `packaging/homebrew/wigolo.rb` into the tap
  as `Formula/wigolo.rb`, commit, push.
- Install path for users: `brew install <org>/wigolo/wigolo`.

## 4. install.sh — copy to `site/public/`

- `cp packaging/install.sh site/public/install.sh`
- The site deploys on push to `main`, so **this copy is the publish act** — do
  it only at release time, not before.

## 5. Docker tags (multi-arch + -full variant)

- Registry: `ghcr.io/knockoutez/wigolo` (lowercase).
- Multi-arch build/push: `linux/amd64,linux/arm64`.
- Tags per release: `<version>`, `latest`, plus the `-full` variant
  (`<version>-full`, `latest-full`) that ships the browser engine preloaded.

## 6. Binary checksums + macOS signing

- Publish a `SHA256SUMS` (or `checksums.txt`) file alongside any prebuilt
  binaries in the GitHub release.
- **macOS binaries MUST be codesigned + notarized.** Gatekeeper blocks
  unsigned, browser-downloaded binaries outright.
- Escape hatch for unsigned local testing only (never document to end users as
  the install path): `xattr -d com.apple.quarantine <binary>`.

## FUTURE BREAKING CHANGE — formula → cask flip

When wigolo ships prebuilt standalone binaries, the Homebrew distribution
switches from a **formula** (builds from the npm tarball via node@22) to a
**cask** (drops a signed prebuilt binary). This is a named breaking change:

- Users migrate with: `brew uninstall wigolo && brew install --cask wigolo`.
- At flip time, add deprecation caveats to the formula pointing at the cask.
- Casks require the notarized binary from step 6 — do not flip before signing
  is in place.
