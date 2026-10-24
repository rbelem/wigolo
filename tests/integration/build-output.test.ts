import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Build into a temp dir, never into `dist/`.
//
// `tsup` is configured with `clean: true`, so `npm run build` DELETES dist and
// recreates it. Running that from a test body meant every other file in the
// same parallel run that spawns `dist/index.js` (repl-e2e, mcp-startup, the e2e
// fetch tests) could observe a half-written tree and fail with
// `ENOENT: dist/index.js` or a missing chunk — an intermittent failure that
// looked like whatever change happened to be under test. The assertions below
// are about what the build EMITS, which a temp out-dir shows just as well.
const OUT = join(tmpdir(), 'wigolo-build-output', String(process.pid));

describe('build output (tsup)', () => {
  beforeAll(() => {
    execSync(`npx tsup --out-dir "${OUT}" && npx tsc -p tsconfig.build.json --outDir "${OUT}"`, {
      stdio: 'pipe',
    });
  }, 120_000);

  it('emits index.js', () => {
    expect(existsSync(join(OUT, 'index.js'))).toBe(true);
  });

  it('emits type declarations', () => {
    expect(existsSync(join(OUT, 'index.d.ts'))).toBe(true);
    expect(existsSync(join(OUT, 'types.d.ts'))).toBe(true);
  });

  it('ships zero Python (no scripts or python output)', () => {
    // Phase 4 removed the Python reranker subprocess. The build no longer
    // copies any Python assets — its absence is the contract we assert.
    expect(existsSync(join(OUT, 'scripts'))).toBe(false);
    expect(existsSync(join(OUT, 'python'))).toBe(false);
  });

  it('produces sourcemaps', () => {
    expect(existsSync(join(OUT, 'index.js.map'))).toBe(true);
  });

  it('respects bin shebang', () => {
    const content = readFileSync(join(OUT, 'index.js'), 'utf-8');
    expect(content.startsWith('#!')).toBe(true);
  });
});
