/** OpenCode integration: local MCP config with no separate instructions layer. */
import { constants, existsSync, promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { binaryInPath } from '../tui/detect-helpers.js';
import { removeJsonConfigEntry, writeJsonConfig } from '../tui/config-writer-json.js';

const MCP_KEY_PATH = ['mcp', 'wigolo'] as const;
const MCP_ENTRY_LABEL = '~/.config/opencode/opencode.json (wigolo mcp entry)';
const LEGACY_ENTRY_LABEL = '~/.config/opencode/config.json (legacy wigolo mcp entry)';

interface SyncOpencodeConfigResult {
  ok: boolean;
  code: string;
  message?: string;
  removed: string[];
  backupPath?: string;
  dryRun?: boolean;
}

interface OpencodeCommand {
  command: string;
  args: string[];
}

export interface SyncOpencodeConfigOptions {
  command?: OpencodeCommand;
  dryRun?: boolean;
  configPath?: string;
  legacyConfigPath?: string;
}

function opencodeDir(): string {
  return join(homedir(), '.config', 'opencode');
}

function configPath(): string {
  return join(opencodeDir(), 'opencode.json');
}

function legacyConfigPath(): string {
  return join(opencodeDir(), 'config.json');
}

function detect(): boolean {
  if (existsSync(opencodeDir())) return true;
  return binaryInPath('opencode') !== null;
}

/**
 * Resolve a config path the user symlinked ON PURPOSE, e.g.
 * `opencode.json -> ./opencode.jsonc` (OpenCode reads JSONC, and some editors
 * only associate the schema with a `.json` name). The shared writer refuses
 * symlinks because a blind write can clobber an arbitrary target; here the link
 * IS the config the user maintains, so following it is the only way to wire the
 * agent.
 *
 * Follow only a DIRECT symlink whose target:
 *   - resolves inside the user's home,
 *   - is a regular file,
 *   - is writable.
 * Anything else (a link into the Nix store, /etc, a directory, a dangling link)
 * is returned unchanged, and the writer's refusal still applies.
 */
async function resolveConfigTarget(path: string): Promise<string> {
  let isLink = false;
  try {
    isLink = (await fs.lstat(path)).isSymbolicLink();
  } catch {
    return path; // missing: let the writer create it
  }
  if (!isLink) return path;
  let resolved: string;
  try {
    resolved = await fs.realpath(path);
  } catch {
    return path; // dangling link: the refusal explains it better than ENOENT
  }
  const rel = relative(homedir(), resolved);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return path;
  try {
    if (!(await fs.stat(resolved)).isFile()) return path;
    await fs.access(resolved, constants.W_OK);
  } catch {
    return path;
  }
  return resolved;
}

function buildEntry(command: OpencodeCommand): Record<string, unknown> {
  return { type: 'local', command: [command.command, ...command.args], enabled: true };
}

async function rollbackConfig(
  path: string,
  existed: boolean,
  changed: boolean,
  backupPath: string | undefined,
  writtenContentHash: string | undefined,
  dryRun: boolean | undefined,
): Promise<string | undefined> {
  if (!changed || dryRun) return undefined;
  const rollbackPath = `${path}.rollback-${process.pid}-${randomBytes(6).toString('hex')}`;
  const verifyWrittenConfig = async (): Promise<string | undefined> => {
    const current = await fs.lstat(path);
    if (current.isSymbolicLink()) {
      return 'current OpenCode config rollback failed: refused symbolic link config';
    }
    if (!writtenContentHash) {
      return 'current OpenCode config rollback failed: required write fingerprint is missing';
    }
    const currentHash = createHash('sha256').update(await fs.readFile(path)).digest('hex');
    if (currentHash !== writtenContentHash) {
      return 'current OpenCode config rollback failed: config changed after Wigolo update';
    }
    return undefined;
  };
  try {
    const conflict = await verifyWrittenConfig();
    if (conflict) return conflict;
    if (existed) {
      if (!backupPath) return 'current OpenCode config rollback failed: required backup is missing';
      const backup = await fs.lstat(backupPath);
      if (backup.isSymbolicLink()) {
        return 'current OpenCode config rollback failed: refused symbolic link backup';
      }
      await fs.copyFile(backupPath, rollbackPath);
      const restoreConflict = await verifyWrittenConfig();
      if (restoreConflict) return restoreConflict;
      await fs.rename(rollbackPath, path);
    } else {
      const removeConflict = await verifyWrittenConfig();
      if (removeConflict) return removeConflict;
      await fs.unlink(path);
    }
    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `current OpenCode config rollback failed: ${message}`;
  } finally {
    try { await fs.unlink(rollbackPath); } catch {}
  }
}

async function preflightLegacyRemoval(
  path: string,
  action: 'migration' | 'cleanup',
): Promise<SyncOpencodeConfigResult | undefined> {
  const result = await removeJsonConfigEntry({
    path,
    keyPath: [...MCP_KEY_PATH],
    dryRun: true,
    allowJsonc: true,
    requireBackup: true,
    refuseSymlink: true,
  });
  if (result.ok) return undefined;
  return {
    ok: false,
    code: result.code,
    message: `legacy OpenCode config ${action} failed: ${result.message ?? result.code}`,
    removed: [],
  };
}

export async function syncOpencodeConfig(
  options: SyncOpencodeConfigOptions = {},
): Promise<SyncOpencodeConfigResult> {
  const { command, dryRun } = options;
  const removed: string[] = [];
  // Follow a user-made same-config symlink (opencode.json -> opencode.jsonc)
  // before any read/write/backup/rollback, so the whole transaction targets the
  // real file and the link itself stays untouched.
  const targetConfigPath = await resolveConfigTarget(options.configPath ?? configPath());
  const targetLegacyConfigPath = await resolveConfigTarget(
    options.legacyConfigPath ?? legacyConfigPath(),
  );

  if (command) {
    const legacyFailure = await preflightLegacyRemoval(targetLegacyConfigPath, 'migration');
    if (legacyFailure) return { ...legacyFailure, dryRun };

    const currentExisted = existsSync(targetConfigPath);
    const wrote = await writeJsonConfig({
      path: targetConfigPath,
      keyPath: [...MCP_KEY_PATH],
      entry: buildEntry(command),
      allowJsonc: true,
      requireBackup: true,
      refuseSymlink: true,
      dryRun,
    });
    if (!wrote.ok) {
      return {
        ok: false,
        code: wrote.code,
        message: `OpenCode config write failed: ${wrote.message ?? wrote.code}`,
        backupPath: wrote.backupPath,
        removed,
        dryRun,
      };
    }

    const migrated = await removeJsonConfigEntry({
      path: targetLegacyConfigPath,
      keyPath: [...MCP_KEY_PATH],
      dryRun,
      allowJsonc: true,
      requireBackup: true,
      refuseSymlink: true,
    });
    if (!migrated.ok) {
      const rollbackFailure = await rollbackConfig(
        targetConfigPath,
        currentExisted,
        true,
        wrote.backupPath,
        wrote.writtenContentHash,
        dryRun,
      );
      return {
        ok: false,
        code: migrated.code,
        message: [
          `legacy OpenCode config migration failed: ${migrated.message ?? migrated.code}`,
          rollbackFailure,
        ].filter(Boolean).join('; '),
        backupPath: wrote.backupPath ?? migrated.backupPath,
        removed,
        dryRun: migrated.dryRun,
      };
    }
    if (migrated.removed) {
      removed.push(LEGACY_ENTRY_LABEL);
    }

    return {
      ok: true,
      code: 'OK',
      removed,
      backupPath: wrote.backupPath ?? migrated.backupPath,
      dryRun: wrote.dryRun ?? migrated.dryRun,
    };
  }

  const legacyFailure = await preflightLegacyRemoval(targetLegacyConfigPath, 'cleanup');
  if (legacyFailure) return { ...legacyFailure, dryRun };

  const currentExisted = existsSync(targetConfigPath);
  const current = await removeJsonConfigEntry({
    path: targetConfigPath,
    keyPath: [...MCP_KEY_PATH],
    dryRun,
    allowJsonc: true,
    requireBackup: true,
    refuseSymlink: true,
  });
  if (!current.ok) {
    return {
      ok: false,
      code: current.code,
      message: `OpenCode config cleanup failed: ${current.message ?? current.code}`,
      backupPath: current.backupPath,
      removed,
      dryRun: current.dryRun,
    };
  }
  if (current.removed) {
    removed.push(MCP_ENTRY_LABEL);
  }

  const migrated = await removeJsonConfigEntry({
    path: targetLegacyConfigPath,
    keyPath: [...MCP_KEY_PATH],
    dryRun,
    allowJsonc: true,
    requireBackup: true,
    refuseSymlink: true,
  });
  if (!migrated.ok) {
    const rollbackFailure = await rollbackConfig(
      targetConfigPath,
      currentExisted,
      current.removed,
      current.backupPath,
      current.writtenContentHash,
      dryRun,
    );
    if (!rollbackFailure) removed.length = 0;
    return {
      ok: false,
      code: migrated.code,
      message: [
        `legacy OpenCode config cleanup failed: ${migrated.message ?? migrated.code}`,
        rollbackFailure,
      ].filter(Boolean).join('; '),
      backupPath: current.backupPath ?? migrated.backupPath,
      removed,
      dryRun: migrated.dryRun,
    };
  }
  if (migrated.removed) {
    removed.push(LEGACY_ENTRY_LABEL);
  }

  return {
    ok: true,
    code: 'OK',
    removed,
    backupPath: current.backupPath ?? migrated.backupPath,
    dryRun: current.dryRun ?? migrated.dryRun,
  };
}

async function installMcp(cmd: { command: string; args: string[] }): Promise<void> {
  const result = await syncOpencodeConfig({ command: { command: cmd.command, args: cmd.args } });
  if (!result.ok) {
    throw new Error(result.message ?? 'OpenCode install failed');
  }
}

async function uninstall(): Promise<{ removed: string[] }> {
  const result = await syncOpencodeConfig();
  if (!result.ok) {
    throw new Error(result.message ?? 'OpenCode cleanup failed');
  }
  return { removed: result.removed };
}

export const opencodeHandler = {
  id: 'opencode' as const,
  displayName: 'OpenCode',
  supportsSkills: true,
  supportsCommands: false,
  supportsInstructions: false,
  detect,
  installMcp,
  installInstructions: async () => { /* OpenCode receives guidance through MCP server instructions. */ },
  uninstall,
};
