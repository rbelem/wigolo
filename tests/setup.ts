import { beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Strip ambient configuration that changes what the suite measures.
//
// CI is accidentally hermetic: its environment holds no provider keys and no
// WIGOLO_* selectors, so tests that assert "no provider configured" or "default
// backend" pass there and fail on a developer box that exports real ones. Two
// observed failures, both from exactly this: a real GEMINI_API_KEY made
// key-store's precedence assertions compare against the ambient key, and an
// exported BRAVE_API_KEY added an engine to the search pool that no test route
// mocks, which tripped the degraded-pool lexical gate and emptied the results.
//
// Deleting here — at module load, before any test file is imported — makes the
// suite depend on the code rather than on the operator's shell. A test that
// needs a key or a non-default mode sets it itself, which is also how it stays
// readable. Proxies are deliberately NOT stripped: a sandboxed runner may need
// them to reach its fixtures.
const AMBIENT_CONFIG_VARS = [
  // LLM providers
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'ALIBABA_TOKEN_PLAN_API_KEY',
  'ALIBABA_CODING_PLAN_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
  'LLM_API_KEY',
  'TEXT_MODEL_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'WIGOLO_LLM_API_KEY',
  'WIGOLO_LLM_PROVIDER',
  'WIGOLO_LLM_MODEL',
  // inference backends and their endpoints
  'WIGOLO_RERANKER',
  'WIGOLO_RERANKER_MODEL',
  'WIGOLO_RERANKER_BASE_URL',
  'WIGOLO_RERANKER_API_KEY',
  'WIGOLO_RERANK_API_BASE',
  'WIGOLO_RERANK_API_KEY',
  'WIGOLO_RELEVANCE_THRESHOLD',
  'WIGOLO_EMBEDDING_PROVIDER',
  'WIGOLO_EMBEDDING_MODEL',
  'WIGOLO_EMBEDDING_BASE_URL',
  'WIGOLO_EMBEDDING_API_KEY',
  'WIGOLO_EMBEDDING_DIM',
  // key-gated engines and backend selection
  'BRAVE_API_KEY',
  'EXA_API_KEY',
  'FIRECRAWL_API_KEY',
  'WIGOLO_GITHUB_TOKEN',
  'WIGOLO_SEARCH',
  'WIGOLO_SEARXNG_URL',
  'SEARXNG_URL',
  'WIGOLO_WARM_ENGINES',
  'WIGOLO_EAGER_WARMUP',
  'WIGOLO_API_TOKEN',
  // browser selection: a developer's installed Chrome would replace the mock
  'WIGOLO_BROWSER_CHANNEL',
  'WIGOLO_CHROME_PATH',
  'WIGOLO_CDP_URL',
  // data/config paths: never point the suite at a developer's real profile
  'WIGOLO_DATA_DIR',
  'WIGOLO_CONFIG_PATH',
] as const;

for (const key of AMBIENT_CONFIG_VARS) delete process.env[key];

// The OS keychain is the other half of "the developer's real configuration".
// `resolveKeychainSecret` reaches libsecret/Keychain when an env var is absent,
// so a stored key would answer where CI answers `undefined` — and a test that
// asserts "not configured" would pass or fail by desktop state. Install an
// inert adapter; a test that exercises the keychain path injects its own with
// `_setCredentialKeychainForTests`.

// Isolate the data dir so the suite NEVER writes to a developer's real
// ~/.wigolo (a vitest worker otherwise opens the live wigolo.db). One dir per
// worker process, reused across the files that worker runs. The path contains
// `.wigolo` so config's default-path assertion still holds. Tests that need a
// specific dir set WIGOLO_DATA_DIR themselves — the guard respects it. Several
// tests `delete process.env.WIGOLO_DATA_DIR` in cleanup to restore the
// "unset" state; re-asserting in beforeEach (only when unset) stops the next
// test in that worker from falling back to the real home dir. Invisible on CI
// (throwaway HOME), decisive locally.
const TEST_DATA_DIR = join(tmpdir(), 'wigolo-test', String(process.pid), '.wigolo');
function ensureTestDataDir(): void {
  if (!process.env.WIGOLO_DATA_DIR) {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    process.env.WIGOLO_DATA_DIR = TEST_DATA_DIR;
  }
}
ensureTestDataDir();

// The data dir alone does not protect the persisted settings: code that saves
// them resolves WIGOLO_CONFIG_PATH, then falls back to <home>/.wigolo/config.json.
// A test that persists settings therefore rewrote the developer's real config
// and dropped every key the test did not know about. Same guard shape as above:
// set it only when unset, and re-assert in beforeEach so a test that deletes it
// in cleanup cannot leak the next one onto the real file.
const TEST_CONFIG_PATH = join(TEST_DATA_DIR, 'config.json');
function ensureTestConfigPath(): void {
  if (!process.env.WIGOLO_CONFIG_PATH) {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    process.env.WIGOLO_CONFIG_PATH = TEST_CONFIG_PATH;
  }
}
ensureTestConfigPath();

// Default reranker to 'none' in tests so the cross-encoder model isn't lazily
// downloaded. Tests that exercise the reranker explicitly set
// WIGOLO_RERANKER='onnx' and mock the rerank provider in their own scope.
if (!process.env.WIGOLO_RERANKER) {
  process.env.WIGOLO_RERANKER = 'none';
}

// Phase 0: production default flipped from `searxng` to `core`. Most existing
// tests were authored against the legacy SearXNG path (they pass a mock engines
// array to handleSearch). Pin the test-suite default back to `searxng` so
// pre-Phase-0 tests keep their semantics. Tests that exercise the new default
// or any other backend override this per-test with process.env.WIGOLO_SEARCH.
if (!process.env.WIGOLO_SEARCH) {
  process.env.WIGOLO_SEARCH = 'searxng';
}

// The driver-hardened stealth launcher (`patchright`) ships as an INSTALLED
// optionalDependency, and `stealthDriver` defaults to 'auto' — so the dedicated
// stealth path prefers it over the standard launcher. That silently escapes
// every `vi.mock('playwright')` in the suite: the pool launches a REAL browser,
// navigates to a fake host, and the test fails on ERR_NAME_NOT_RESOLVED rather
// than exercising its mock. It cost 22 failures that read as environmental
// flake. Pin the suite to the standard driver — `resolveStealthLauncher`
// short-circuits on this mode and never probes the optional package.
//
// Env, deliberately: a static `import` of the stealth module here would be
// hoisted above the assignments in this file (populating the config cache with
// the wrong search backend), and a dynamic import inside a hook would execute
// the src graph inside each test file's own mocked-fs/os context. A test that
// genuinely exercises the hardened driver overrides this var in its own scope.
if (!process.env.WIGOLO_STEALTH_DRIVER) {
  process.env.WIGOLO_STEALTH_DRIVER = 'playwright';
}

// Isolate CI-detection env vars from the host. Production code in
// `src/cli/config.ts` and `src/cli/tui/theme/motion-guard.ts` (correctly)
// disables Ink mount and TUI motion when CI/GITHUB_ACTIONS are set. Under
// GitHub Actions runners those vars are always present, which would otherwise
// silently flip TUI tests into reduced-motion mode and skip Ink-mount paths.
// Per-test cases that need to assert CI-on behavior set the var inside their
// own `it(...)` block; this save/restore guarantees each test starts with a
// clean slate and the host's CI vars never leak into assertions.
const CI_ENV_KEYS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'CONTINUOUS_INTEGRATION',
] as const;

const savedCIEnv: Partial<Record<(typeof CI_ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  ensureTestDataDir();
  ensureTestConfigPath();
  for (const key of CI_ENV_KEYS) {
    savedCIEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CI_ENV_KEYS) {
    const orig = savedCIEnv[key];
    if (orig === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = orig;
    }
  }
});
