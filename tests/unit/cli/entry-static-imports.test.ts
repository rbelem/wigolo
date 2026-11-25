import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `wigolo mcp` runs from the same entry file as every other command, so a
// package that the entry reaches through static imports must load before the
// MCP server can answer. The interactive prompt library is only needed by
// commands that ask questions; a missing or damaged copy must not stop the
// server from starting. This walks the static import graph from src/index.ts.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function staticImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(STATIC_IMPORT)].map((m) => m[1]);
}

function resolveLocal(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function packagesReachedFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(file)) {
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec);
        if (next) queue.push(next);
      } else {
        packages.add(spec);
      }
    }
  }
  return packages;
}

describe('entry point static imports', () => {
  it('does not load the interactive prompt library at startup', () => {
    const packages = packagesReachedFrom(join(SRC, 'index.ts'));
    // Control: the walk genuinely reaches the proxy dispatcher's `undici`,
    // which upstream installs at the entry so every fetch honors the proxy.
    // The MCP server, commands and prompt library are all dynamic imports
    // in this fork (see the lazy-import graph guard), so they are absent.
    expect(packages.has('undici')).toBe(true);
    expect([...packages].filter((p) => p.startsWith('@inquirer/'))).toEqual([]);
  });
});
