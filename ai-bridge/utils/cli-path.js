/**
 * Shared CLI binary path resolution for the opencode CLI.
 *
 * Priority:
 * 1. Explicit env overrides
 * 2. PATH lookup (`which` / `where`)
 * 3. Common home install candidates
 * 4. Bare binary name fallback
 *
 * Windows note: npm global installs create three shims (`pi`, `pi.cmd`, `pi.ps1`).
 * `where pi` often lists the extensionless bash wrapper first. Node's
 * `spawn()` cannot CreateProcess that file (ENOENT). Prefer `.cmd` / `.exe`
 * and shell-spawn `.cmd`/`.bat` (see `isWindowsCmdShim`).
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute } from 'path';
import { execFileSync, execSync } from 'child_process';

/** Extensions Node can CreateProcess on Windows (with shell for .cmd/.bat). */
const WINDOWS_SPAWNABLE_EXT = /\.(cmd|bat|exe)$/i;
/** Prefer real PE binaries, then cmd shims, over extensionless npm wrappers. */
const WINDOWS_SPAWNABLE_PRIORITY = ['.exe', '.cmd', '.bat'];

/**
 * Windows npm global installs only ship a `.cmd` / `.bat` shim (no `.exe`),
 * and Node cannot spawn those without `shell: true`.
 * @param {string} bin - resolved binary path or bare name
 * @returns {boolean}
 */
export function isWindowsCmdShim(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(bin || ''));
}

/**
 * Whether the resolved binary must be spawned through a shell on Windows.
 *
 * True for `.cmd`/`.bat` shims AND for bare command names (no path, no
 * extension). Node's `spawn()` without a shell cannot resolve a bare name via
 * PATHEXT, so on Windows we must hand it to `cmd /c` to let PATHEXT pick the
 * real `.exe`/`.cmd`. Absolute/relative paths with an extension (`.exe`, `.com`,
 * …) are left to `CreateProcess` directly.
 *
 * @param {string} bin
 * @returns {boolean}
 */
export function needsShellOnWindows(bin) {
  if (process.platform !== 'win32') return false;
  const s = String(bin || '');
  if (/\.(cmd|bat)$/i.test(s)) return true;
  const looksLikePath = /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
  const hasExt = /\.[a-z0-9]+$/i.test(s);
  return !looksLikePath && !hasExt;
}

/**
 * Pick the best match from `where` output lines on Windows.
 * Prefer `.exe` / `.cmd` / `.bat` over extensionless npm bash shims.
 *
 * @param {string[]|null|undefined} matches
 * @returns {string|null}
 */
export function selectWindowsWhereMatch(matches) {
  const lines = (Array.isArray(matches) ? matches : [])
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  for (const ext of WINDOWS_SPAWNABLE_PRIORITY) {
    const hit = lines.find((line) => line.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return lines[0];
}

/**
 * If `bin` is an absolute/relative path without a spawnable Windows extension
 * and a sibling `.exe`/`.cmd`/`.bat` exists, return that sibling.
 *
 * Bare names (`pi`) are left unchanged so PATH+PATHEXT still apply at spawn.
 *
 * @param {string} bin
 * @param {(path: string) => boolean} [existsFn]
 * @param {boolean} [forceWindows] - test hook; defaults to process.platform === 'win32'
 * @returns {string}
 */
export function resolveWindowsSpawnableBin(
  bin,
  existsFn = pathExists,
  forceWindows = process.platform === 'win32',
) {
  if (!forceWindows || typeof bin !== 'string') return bin;
  const trimmed = bin.trim();
  if (!trimmed) return bin;
  if (WINDOWS_SPAWNABLE_EXT.test(trimmed)) return trimmed;

  // Bare command names: let PATHEXT / shell resolve; do not invent a path.
  const looksLikePath = isAbsolute(trimmed)
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || /^[A-Za-z]:/.test(trimmed);
  if (!looksLikePath) return trimmed;

  for (const ext of WINDOWS_SPAWNABLE_PRIORITY) {
    const candidate = `${trimmed}${ext}`;
    if (existsFn(candidate)) return candidate;
  }
  return trimmed;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function pathExists(candidate) {
  try {
    return typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate);
  } catch {
    return false;
  }
}

function whichOnPath(binaryName) {
  try {
    if (process.platform === 'win32') {
      // Prefer execFile so the binary name is not re-parsed by a shell.
      // `where` lists every PATHEXT match; the extensionless npm shim is often first
      // and cannot be spawned — selectWindowsWhereMatch prefers .cmd/.exe.
      let output;
      try {
        output = execFileSync('where.exe', [binaryName], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: process.env,
          windowsHide: true,
        });
      } catch {
        // Fallback for systems where where.exe is not on PATH of the IDE process.
        output = execSync(`where ${binaryName}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: process.env,
          windowsHide: true,
        });
      }
      const lines = String(output || '').split(/\r?\n/);
      return selectWindowsWhereMatch(lines);
    }

    const output = execFileSync('which', [binaryName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    const first = String(output || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.binaryName - e.g. "grok" | "kimi" | "opencode"
 * @param {string[]} [options.envKeys] - env var names for path override
 * @param {string[]} [options.homeCandidates] - absolute-ish candidates under $HOME
 *   (use `{home}` placeholder or pass full relative segments)
 * @returns {string}
 */
export function resolveCliPath({ binaryName, envKeys = [], homeCandidates = [] }) {
  const win = process.platform === 'win32';
  // npm global installs on Windows ship `.cmd` shims, not `.exe`.
  const exeNames = win
    ? [`${binaryName}.cmd`, `${binaryName}.bat`, `${binaryName}.exe`, binaryName]
    : [binaryName];

  const envOverride = firstNonEmpty(...envKeys.map((key) => process.env[key]));
  if (envOverride) {
    return resolveWindowsSpawnableBin(envOverride);
  }

  // `where <name>` (no extension) honors PATHEXT; we then prefer .cmd/.exe.
  const fromPath = whichOnPath(binaryName);
  if (fromPath) return resolveWindowsSpawnableBin(fromPath);

  const home = homedir();
  for (const template of homeCandidates) {
    for (const exeName of exeNames) {
      const resolved = template
        .replace('{home}', home)
        .replace('{bin}', exeName)
        .replace('{name}', binaryName);
      if (pathExists(resolved)) return resolveWindowsSpawnableBin(resolved);
    }
  }

  return binaryName;
}

/**
 * Prepend extra bin dirs to PATH when missing (IDE PATH is often sparse).
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} binDirs
 */
export function enrichPathWithBinDirs(env, binDirs = []) {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  let current = env[pathKey] || env.PATH || '';
  const parts = current ? current.split(sep) : [];
  for (const dir of binDirs) {
    if (dir && !parts.includes(dir)) {
      parts.unshift(dir);
    }
  }
  env[pathKey] = parts.join(sep);
  if (pathKey !== 'PATH') {
    env.PATH = env[pathKey];
  }
}

/**
 * Common user-level CLI install dirs (IDE PATH is often sparse / no login shell).
 * Used both for binary resolution and spawn PATH enrichment.
 */
export function commonCliBinDirs(home = homedir()) {
  const dirs = [];
  if (!home) return dirs;
  dirs.push(
    join(home, '.opencode', 'bin'),
    join(home, '.local', 'share', 'opencode', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
  );
  if (process.platform === 'win32') {
    // npm global bin dir on Windows (e.g. C:\Users\<user>\AppData\Roaming\npm).
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    dirs.push(join(appData, 'npm'));
    // pnpm global bin dir on Windows (e.g. C:\Users\<user>\AppData\Local\pnpm).
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    dirs.push(join(localAppData, 'pnpm'));
    // Scoop shims (e.g. C:\Users\<user>\scoop\shims).
    dirs.push(join(home, 'scoop', 'shims'));
  } else {
    // pnpm global bin dir on macOS/Linux (e.g. ~/.local/share/pnpm).
    dirs.push(join(home, '.local', 'share', 'pnpm'));
  }
  return dirs;
}

export function resolveOpenCodeCliPath() {
  return resolveCliPath({
    binaryName: 'opencode',
    envKeys: ['OPENCODE_BIN', 'OPENCODE_PATH', 'OPENCODE_CLI_PATH'],
    homeCandidates: [
      '{home}/.opencode/bin/{bin}',
      '{home}/.local/bin/{bin}',
      '{home}/.local/share/opencode/bin/{bin}',
    ],
  });
}

/**
 * Probe the system Node.js path and version from PATH.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ path: string, version: string } | null}
 */
export function probeSystemNode(env = process.env) {
  try {
    const nodeBin = whichOnPath('node');
    if (!nodeBin) return null;
    const versionOutput = execFileSync(nodeBin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
      timeout: 3000,
    });
    const version = String(versionOutput || '').trim();
    return { path: nodeBin, version };
  } catch {
    return null;
  }
}

/**
 * Probe the OpenCode CLI version.
 * @param {string} binaryPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function probeCliVersion(binaryPath, env = process.env) {
  if (!binaryPath) return null;
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
      timeout: 4000,
    });
    return String(output || '').trim();
  } catch {
    return null;
  }
}

