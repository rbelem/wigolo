import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

/**
 * `.d.ts` files tsup emitted, sampled BETWEEN the two build stages.
 *
 * tsc runs second and would fill these in either way, so sampling here is the
 * only way to see a `dts: true` regression in `tsup.config.ts` (tsup must stay
 * `dts: false`; declaration emit belongs to `tsc -p tsconfig.build.json`).
 */
let tsupDeclarations: string[] = [];

describe('build output (tsup)', () => {
  beforeAll(() => {
    execSync(`npx tsup --out-dir "${OUT}"`, { stdio: 'pipe' });
    tsupDeclarations = readdirSync(OUT).filter((f) => f.endsWith('.d.ts'));
    execSync(`npx tsc -p tsconfig.build.json --outDir "${OUT}"`, { stdio: 'pipe' });
  }, 120_000);

  afterAll(() => {
    rmSync(OUT, { recursive: true, force: true });
  });

  it('emits index.js', () => {
    expect(existsSync(join(OUT, 'index.js'))).toBe(true);
  });

  it('tsup alone emits no declarations (dts: false)', () => {
    expect(tsupDeclarations).toEqual([]);
  });

  it('emits type declarations', () => {
    expect(existsSync(join(OUT, 'index.d.ts'))).toBe(true);
    expect(existsSync(join(OUT, 'types.d.ts'))).toBe(true);
  });

  it('emits types.js for the ./types export', () => {
    expect(existsSync(join(OUT, 'types.js'))).toBe(true);
  });

  it('keeps both build stages, in order (package.json `build`)', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const build = pkg.scripts.build;
    // tsup emits the JS; tsc emits the declarations tsup does not. Dropping
    // either stage ships a broken package, so the script is part of the contract.
    expect(build).toContain('tsup');
    expect(build).toContain('tsc');
    expect(build.indexOf('tsup')).toBeLessThan(build.indexOf('tsc'));
    expect(build).toContain('tsconfig.build.json');
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
