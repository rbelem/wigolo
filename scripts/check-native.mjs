/**
 * Exit non-zero when a native module cannot load in the Node that is running.
 *
 * Why this exists: this repo pins Node 22 in devbox.json (matching CI), while
 * the machine-wide devbox profile carries Node 26. better-sqlite3 is a
 * NODE_MODULE_VERSION-bound addon, so any `npm install`/`npm rebuild` that runs
 * in the other shell silently swaps the binding: it loads in one Node and
 * throws ERR_DLOPEN_FAILED in the other. The symptom is ~700 unrelated test
 * failures (every cache/RSS/embedding test) that read as code regressions.
 *
 * The devbox test scripts call this first and rebuild when it fails, so the
 * suite always starts from a binding that matches the Node running it.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  // A bare require is enough: the addon either loads or it does not.
  require('better-sqlite3');
  process.exit(0);
} catch (err) {
  const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
  process.stdout.write(`native module unusable under ${process.version}: ${reason}\n`);
  process.exit(1);
}
