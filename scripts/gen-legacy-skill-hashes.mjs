#!/usr/bin/env node
// Generates assets/legacy-skill-hashes.json — the union of every distinct
// historical byte-set of each canonical skill-pack file, keyed by
// "<pack>/<relPath>". Hashes are computed over EOL-normalized (\r\n -> \n)
// bytes.
//
// Two rules make the ledger safe to regenerate on any clone:
//
//  1. UNION, never overwrite. The committed file is read first and every hash
//     already in it is kept. Historical bytes are re-derivable only while the
//     clone still has the history that produced them — a shallow clone, a
//     rewrite, or a fresh checkout of this slice reproduces only a subset, and
//     overwriting the manifest there silently drops hashes for RELEASED bytes.
//     `wigolo skills remove`/`uninstall` then refuses receipt-less installs of
//     an older release (unknown bytes), which is the exact failure this ledger
//     exists to prevent.
//
//  2. Every historical SOURCE path is walked, not just assets/skills. Skill
//     packs moved from `assets/skills/**` to `skills/**`, and packs added after
//     the move (wigolo-cache, wigolo-diff, wigolo-watch — and `wigolo/rules/*`)
//     never existed under the old path, so their released bytes live only in
//     tag trees of `skills/**`. Both trees are scanned at every commit that
//     touched them AND at every tag, which also covers the release tags whose
//     bytes the runbook (packaging/RELEASE-RUNBOOK.md §0.5) requires.
//
// Regenerate:  node scripts/gen-legacy-skill-hashes.mjs
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GEN_COMMAND = 'node scripts/gen-legacy-skill-hashes.mjs';
const MANIFEST = 'assets/legacy-skill-hashes.json';
const HISTORICAL_ROOTS = ['assets/skills', 'skills'];

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function sha256Normalized(buf) {
  const norm = Buffer.from(buf.toString('utf-8').replace(/\r\n/g, '\n'), 'utf-8');
  return createHash('sha256').update(norm).digest('hex');
}

// Map of "<pack>/<relPath>" -> Set<hash>
const hashes = new Map();
function add(key, hash) {
  if (!hashes.has(key)) hashes.set(key, new Set());
  hashes.get(key).add(hash);
}

// 0) Seed from the committed manifest so a partial history can never shrink it.
let seeded = 0;
if (existsSync(MANIFEST)) {
  const prior = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  for (const [key, value] of Object.entries(prior)) {
    if (key === '_comment' || !Array.isArray(value)) continue;
    for (const hash of value) {
      add(key, hash);
      seeded++;
    }
  }
}

// 1) Historical bytes at every commit that changed a scanned root, plus every
//    tag. Trees are read at the tag itself so released byte-sets are included
//    even when no later commit touched the file.
const revisions = new Set();
for (const root of HISTORICAL_ROOTS) {
  for (const sha of sh(`git log --all --format=%H -- ${root}`).split('\n')) {
    if (sha.trim()) revisions.add(sha.trim());
  }
}
for (const tag of sh('git tag --list').split('\n')) {
  if (tag.trim()) revisions.add(tag.trim());
}

for (const rev of revisions) {
  for (const root of HISTORICAL_ROOTS) {
    let tree;
    try {
      tree = sh(`git ls-tree -r --name-only ${rev} -- ${root}`);
    } catch {
      continue;
    }
    for (const path of tree.split('\n').map((s) => s.trim()).filter((f) => f.endsWith('.md'))) {
      const rel = path.replace(/^(assets\/skills|skills)\//, '');
      let buf;
      try {
        buf = execSync(`git show ${rev}:${path}`, { maxBuffer: 64 * 1024 * 1024 });
      } catch {
        continue;
      }
      add(rel, sha256Normalized(buf));
    }
  }
}

// 2) The working tree, so an edit that has not been committed yet still lands in
//    the ledger (the release flow edits skills/ and regenerates before commit).
function walk(dir, base) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, base);
    } else if (name.endsWith('.md')) {
      add(full.replace(base + '/', ''), sha256Normalized(readFileSync(full)));
    }
  }
}
walk('skills', 'skills');

// Serialize, sorted for stable diffs.
const out = { _comment: `Legacy skill-pack content hashes (sha256 over EOL-normalized bytes), union of all historical byte-sets. Regenerate with: ${GEN_COMMAND}` };
for (const key of [...hashes.keys()].sort()) {
  out[key] = [...hashes.get(key)].sort();
}

writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + '\n', 'utf-8');
console.error(
  `Seeded ${seeded} committed hashes; wrote ${hashes.size} keys, ` +
    `${[...hashes.values()].reduce((n, s) => n + s.size, 0)} total hashes`,
);
