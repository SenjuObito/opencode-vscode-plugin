/**
 * OpenCode models service.
 *
 * Enumerates `provider/model` ids from the persistent `opencode serve`
 * process via the @opencode-ai/sdk `config.providers()` endpoint. Falls back to
 * the legacy `opencode models` spawnSync path when the SDK/server is
 * unavailable (e.g. serve failed to start).
 *
 * Output contract (listModels): a single JSON object on stdout:
 *   { success: true, provider: 'opencode', models: [{ id, label, description }] }
 */

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  commonCliBinDirs,
  enrichPathWithBinDirs,
  isWindowsCmdShim,
  resolveOpenCodeCliPath,
} from '../../utils/cli-path.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import * as serveManager from './opencode-serve-manager.js';
import * as sdk from './opencode-sdk-client.js';

const DEFAULT_PORT = Number(process.env.OPENCODE_PORT) || 4096;

function stripAnsi(input) {
  return String(input || '').replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function formatLabel(fullId) {
  const trimmed = String(fullId || '').trim();
  if (!trimmed) return 'OpenCode';
  const slash = trimmed.indexOf('/');
  // UI 已按供应商分组，label 只显示模型名；id 仍保留完整 provider/model。
  const modelName = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  if (!modelName) return trimmed;
  // Title-case-ish for display.
  return modelName
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('-');
}

/**
 * Parse `opencode models` stdout into model entries (legacy fallback).
 * @param {string} stdout
 * @returns {{ id: string, label: string, description?: string }[]}
 */
export function parseOpenCodeModelsOutput(stdout) {
  const clean = stripAnsi(stdout);
  const seen = new Set();
  const models = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const token = line.split(/\s+/).find((part) => part.includes('/'));
    if (!token || seen.has(token)) continue;
    seen.add(token);
    models.push({
      id: token,
      label: formatLabel(token),
      description: token,
    });
  }
  return models;
}

/**
 * Enumerate models via the SDK `config.providers()` endpoint.
 * @param {string} [directory]
 * @returns {Promise<{ id: string, label: string, description?: string }[]>}
 */
async function listModelsFromSdk(directory) {
  const providers = await sdk.getProviders(directory);
  if (!Array.isArray(providers) || providers.length === 0) return [];

  const models = [];
  const seen = new Set();
  for (const provider of providers) {
    const providerId = provider?.id;
    const providerName = provider?.name || providerId;
    const modelMap = provider?.models;
    if (!providerId || !modelMap || typeof modelMap !== 'object') continue;
    for (const [modelId, modelInfo] of Object.entries(modelMap)) {
      if (!modelId) continue;
      const fullId = `${providerId}/${modelId}`;
      if (seen.has(fullId)) continue;
      seen.add(fullId);
      const description = (modelInfo && typeof modelInfo === 'object' && modelInfo.name)
        ? modelInfo.name
        : `${providerName} ${modelId}`;
      // opencode variants = 推理力度档位（按模型变化），供前端动态渲染。
      let variants;
      if (modelInfo && typeof modelInfo.variants === 'object' && modelInfo.variants !== null) {
        variants = Object.keys(modelInfo.variants).filter((key) => {
          const cfg = modelInfo.variants[key];
          return !(cfg && typeof cfg === 'object' && cfg.disabled);
        });
        if (variants.length === 0) variants = undefined;
      }
      models.push({ id: fullId, label: formatLabel(fullId), description, ...(variants ? { variants } : {}) });
    }
  }
  return models;
}

/**
 * Ensure the persistent `opencode serve` is running and the SDK client is
 * bound to its URL. Shared by every SDK-backed command that doesn't go
 * through opencode-daemon-service's private `_ensureReady`.
 */
export async function ensureServerReady() {
  await serveManager.start(DEFAULT_PORT);
  sdk.setBaseUrl(serveManager.getServerUrl() || `http://localhost:${DEFAULT_PORT}`);
}

/**
 * List models available via the local opencode server.
 * Prints a single JSON object to stdout (for channel-manager listModels).
 */
export async function listModels() {
  const directory = selectWorkingDirectory(null);

  // Prefer the persistent server + SDK path.
  try {
    await ensureServerReady();
    const models = await listModelsFromSdk(directory);
    if (models.length > 0) {
      console.log(JSON.stringify({ success: true, provider: 'opencode', models }));
      return;
    }
  } catch (err) {
    // fall through to the spawnSync path below
    console.error('[DEBUG][OpenCodeModels] SDK provider list failed:', err?.message || err);
  }

  // Legacy fallback: `opencode models`
  let bin;
  try {
    bin = resolveOpenCodeCliPath();
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err?.message || String(err), models: [] }));
    return;
  }
  const env = { ...process.env };
  enrichPathWithBinDirs(env, commonCliBinDirs(homedir()));

  let result;
  try {
    result = spawnSync(bin, ['models'], {
      encoding: 'utf8',
      env,
      timeout: 45_000,
      maxBuffer: 8 * 1024 * 1024,
      // Windows npm `.cmd` shims require a shell to spawn.
      shell: isWindowsCmdShim(bin),
    });
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error?.message || String(error), models: [] }));
    return;
  }

  if (result.error) {
    const hint = result.error.code === 'ENOENT'
      ? 'OpenCode CLI not found. Install it and ensure `opencode` is on PATH (or set OPENCODE_BIN).'
      : (result.error.message || String(result.error));
    console.log(JSON.stringify({ success: false, error: hint, models: [] }));
    return;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().slice(-800);
    console.log(JSON.stringify({
      success: false,
      error: `opencode models failed (code ${result.status})${stderr ? `: ${stderr}` : ''}`,
      models: [],
    }));
    return;
  }

  const models = parseOpenCodeModelsOutput(result.stdout || '');
  // Keep a default entry so UI always has a selectable fallback.
  if (models.length === 0) {
    models.push({
      id: 'opencode-default',
      label: 'OpenCode Default',
      description: 'Use OpenCode CLI default model',
    });
  }

  console.log(JSON.stringify({ success: true, provider: 'opencode', models }));
}
