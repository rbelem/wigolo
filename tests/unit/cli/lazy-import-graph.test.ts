import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Guard: the CLI entrypoint must not statically pull heavy optional
 * dependencies into the process.
 *
 * `src/index.ts` used to import every command module at the top level, so
 * EVERY invocation — including `wigolo --version` — paid for playwright
 * (83 MB), gpt-tokenizer (69 MB), the four LLM SDKs (~68 MB) and sharp
 * (20 MB). That cost 254 MB and ~2 s of startup. Dynamic imports brought it
 * to 69 MB and ~0.1 s.
 *
 * This walks the static import graph from the entrypoint and fails if any of
 * those packages becomes statically reachable again.
 */
const REPO = resolve(import.meta.dirname, '..', '..', '..');
const SRC = resolve(REPO, 'src');

/** Packages that must never be reachable through STATIC imports from the CLI. */
const FORBIDDEN = [
  'playwright',
  'playwright-core',
  'gpt-tokenizer',
  'sharp',
  'linkedom',
  '@anthropic-ai/sdk',
  'openai',
  '@google/genai',
  'groq-sdk',
  '@huggingface/transformers',
];

function resolveLocal(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null;
  const p = resolve(dirname(fromFile), spec.replace(/\.js$/, '.ts'));
  if (existsSync(p)) return p;
  const d = resolve(dirname(fromFile), spec.replace(/\.js$/, '') + '/index.ts');
  if (existsSync(d)) return d;
  return null;
}

/** Static (value) import specifiers of a file. Type-only and dynamic imports
 *  are erased or deferred at runtime, so neither costs resident memory. */
function staticImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /^[ \t]*(?:import|export)\s+(?:[^'"();]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, m.index + m[0].length);
    // `import type { X } from '...'` is erased at build time.
    if (/^\s*(?:import|export)\s+type\b/.test(line)) continue;
    out.push(m[1]);
  }
  return out;
}

function packageName(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

/** Every package statically reachable from the CLI entrypoint. */
function reachablePackages(entry: string): Map<string, string> {
  const seen = new Set<string>();
  const found = new Map<string, string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(file)) {
      const local = resolveLocal(spec, file);
      if (local) {
        stack.push(local);
        continue;
      }
      const pkg = packageName(spec);
      if (pkg && !found.has(pkg)) found.set(pkg, file);
    }
  }
  return found;
}

/** Number of local modules the entrypoint statically reaches. */
function reachableLocalCount(entry: string): number {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(file)) {
      const local = resolveLocal(spec, file);
      if (local) stack.push(local);
    }
  }
  return seen.size;
}

describe('CLI static import graph', () => {
  const reachable = reachablePackages(resolve(SRC, 'index.ts'));

  it.each(FORBIDDEN)('does not statically import %s', (pkg) => {
    expect(
      reachable.has(pkg),
      `${pkg} is statically reachable from src/index.ts (via ${reachable.get(pkg)}). ` +
        `Import it dynamically at the call site so the CLI boot path stays small.`,
    ).toBe(false);
  });

  it('reaches no third-party package at all from the entrypoint', () => {
    // The entrypoint pulls in only its own light modules; every dependency
    // (including better-sqlite3 and sqlite-vec, via the shutdown path) is
    // loaded dynamically at the point of use.
    expect([...reachable.keys()]).toEqual([]);
  });

  it('keeps the boot path small', () => {
    // Canary against the boot path growing back: 10 local modules today.
    // A command module that is statically imported again would push this up.
    const localModules = reachableLocalCount(resolve(SRC, 'index.ts'));
    expect(localModules).toBeLessThanOrEqual(25);
  });
});
