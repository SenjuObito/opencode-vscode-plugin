import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import type { ModelInfo } from '../../components/ChatInputBox/types';
import { OPENCODE_MODELS, isKnownNonReasoningModel } from '../../components/ChatInputBox/types';

type CliModelsByProvider = Record<string, ModelInfo[]>;

interface CliModelsState {
  modelsByProvider: CliModelsByProvider;
  defaultModelByProvider: Record<string, string>;
  catalogHasEntriesByProvider: Record<string, boolean>;
  loadingProvider: string | null;
  errorByProvider: Record<string, string>;
}

/** Java/Host may never answer get_cli_models — don't leave the spinner on forever. */
const CLI_MODELS_TIMEOUT_MS = 15_000;

let state: CliModelsState = {
  modelsByProvider: {},
  defaultModelByProvider: {},
  catalogHasEntriesByProvider: {},
  loadingProvider: null,
  errorByProvider: {},
};

const listeners = new Set<() => void>();
let pendingLoadTimer: { provider: string; timer: ReturnType<typeof setTimeout> } | null = null;
let hasPluginInitFetched = false;

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

function clearPendingLoad() {
  if (pendingLoadTimer) {
    clearTimeout(pendingLoadTimer.timer);
    pendingLoadTimer = null;
  }
}

/** Test-only: clear module caches between cases. */
export function __resetCliModelsCacheForTests() {
  state = {
    modelsByProvider: {},
    defaultModelByProvider: {},
    catalogHasEntriesByProvider: {},
    loadingProvider: null,
    errorByProvider: {},
  };
  clearPendingLoad();
  hasPluginInitFetched = false;
  if (typeof window !== 'undefined') {
    window.setCliModels = handleIncomingCliModels;
  }
  notifyListeners();
}

function fallbackModels(providerId: string): ModelInfo[] {
  if (providerId === 'opencode') return OPENCODE_MODELS;
  return [];
}

function normalizeModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  // variants 的三态必须一路保留到 UI（与 idea 完全一致）：
  //   ['low','high']  该模型显式声明了档位
  //   []              该模型**没有**档位（opencode v2 会返回空数组/空对象）
  //   undefined       v1 目录根本没有这个字段 —— 未知
  // 把 `[]` 折成 `undefined`（本仓此前的简化）会让「没有档位」和「不知道档位」
  // 在 UI 里长得一样：选择器给无档位模型列出了全档位，用户一选就发出一个服务端
  // 不认识的 variant，每次发送都以 `Variant unavailable` 失败。
  const catalogHasVariantsSupport = raw.some(
    (item) => item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).variants),
  );

  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.label === 'string' && row.label.trim()
      ? row.label.trim()
      : id;
    const description = typeof row.description === 'string' ? row.description : undefined;

    const rawVariants = Array.isArray(row.variants) ? row.variants : undefined;
    const parsedVariants = rawVariants
      ? rawVariants.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      : undefined;
    const hasExplicitVariants = rawVariants !== undefined;

    let variants: string[] | undefined;
    if (hasExplicitVariants) {
      variants = parsedVariants;
    } else if (catalogHasVariantsSupport || isKnownNonReasoningModel(id)) {
      variants = [];
    } else {
      // 纯 v1 目录：这个字段不可知，保留 undefined 让 UI 走 legacy 档位。
      variants = undefined;
    }

    const rawContextWindow = Number(row.contextWindow);
    const contextWindow = Number.isInteger(rawContextWindow) && rawContextWindow > 0
      ? rawContextWindow
      : undefined;
    out.push({
      id,
      label,
      description,
      ...(variants !== undefined ? { variants } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return out;
}

export function handleIncomingCliModels(
  dataOrStr: string | { provider?: string; models?: unknown; success?: boolean; error?: string; defaultModel?: unknown }
) {
  let payload: { provider?: string; models?: unknown; success?: boolean; error?: string; defaultModel?: unknown } | null = null;
  if (typeof dataOrStr === 'string') {
    try {
      payload = JSON.parse(dataOrStr);
    } catch {
      return;
    }
  } else if (dataOrStr && typeof dataOrStr === 'object') {
    payload = dataOrStr;
  }
  if (!payload?.provider) return;
  const provider = payload.provider;
  const models = normalizeModels(payload.models);
  const resolvedModels = models.length > 0 ? models : fallbackModels(provider);

  const defaultModel = typeof payload.defaultModel === 'string' && payload.defaultModel.trim()
    ? payload.defaultModel.trim()
    : null;
  const nextDefaults = { ...state.defaultModelByProvider };
  if (defaultModel) {
    nextDefaults[provider] = defaultModel;
  } else {
    delete nextDefaults[provider];
  }

  const nextErrors = { ...state.errorByProvider };
  if (payload.success === false) {
    const message = typeof payload.error === 'string' && payload.error.trim()
      ? payload.error.trim()
      : 'unknown error';
    nextErrors[provider] = message;
  } else {
    delete nextErrors[provider];
  }

  if (pendingLoadTimer?.provider === provider) {
    clearPendingLoad();
  }

  state = {
    ...state,
    modelsByProvider: {
      ...state.modelsByProvider,
      [provider]: resolvedModels,
    },
    catalogHasEntriesByProvider: {
      ...state.catalogHasEntriesByProvider,
      [provider]: models.length > 0,
    },
    defaultModelByProvider: nextDefaults,
    errorByProvider: nextErrors,
    loadingProvider: state.loadingProvider === provider ? null : state.loadingProvider,
  };

  notifyListeners();
}

function beginLoad(providerId: string) {
  clearPendingLoad();
  const nextErrors = { ...state.errorByProvider };
  delete nextErrors[providerId];

  state = {
    ...state,
    loadingProvider: providerId,
    errorByProvider: nextErrors,
  };
  notifyListeners();

  sendBridgeEvent('get_cli_models', providerId);

  pendingLoadTimer = {
    provider: providerId,
    timer: setTimeout(() => {
      pendingLoadTimer = null;
      state = {
        ...state,
        loadingProvider: state.loadingProvider === providerId ? null : state.loadingProvider,
        errorByProvider: {
          ...state.errorByProvider,
          [providerId]: 'timeout',
        },
      };
      notifyListeners();
    }, CLI_MODELS_TIMEOUT_MS),
  };
}

// Global window registration
if (typeof window !== 'undefined') {
  window.setCliModels = handleIncomingCliModels;
  if (window.__pendingCliModels) {
    const pending = window.__pendingCliModels;
    delete window.__pendingCliModels;
    handleIncomingCliModels(pending as any);
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => state;

/**
 * Loads model catalogs for OpenCode via channel-manager listModels.
 */
export function useCliModels(currentProvider: string = 'opencode') {
  if (typeof window !== 'undefined' && window.__pendingCliModels) {
    const pending = window.__pendingCliModels;
    delete window.__pendingCliModels;
    handleIncomingCliModels(pending as any);
  }

  const currentSnapshot = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!hasPluginInitFetched) {
      hasPluginInitFetched = true;
      if (!currentSnapshot.modelsByProvider[currentProvider]?.length) {
        beginLoad(currentProvider);
      } else {
        sendBridgeEvent('get_cli_models', currentProvider);
      }
      return;
    }

    if (currentSnapshot.modelsByProvider[currentProvider]?.length) return;
    beginLoad(currentProvider);
  }, [currentProvider, currentSnapshot.modelsByProvider]);

  const refreshCliModels = useCallback((providerId: string) => {
    beginLoad(providerId);
  }, []);

  const cliModels = currentSnapshot.modelsByProvider[currentProvider]?.length
    ? currentSnapshot.modelsByProvider[currentProvider]
    : fallbackModels(currentProvider);

  return {
    cliModels,
    cliModelsLoading: currentSnapshot.loadingProvider === currentProvider,
    cliModelsError: currentSnapshot.errorByProvider[currentProvider] ?? null,
    cliDefaultModel: currentSnapshot.defaultModelByProvider[currentProvider] ?? null,
    cliCatalogHasEntries: currentSnapshot.catalogHasEntriesByProvider[currentProvider] ?? false,
    refreshCliModels,
    modelsByProvider: currentSnapshot.modelsByProvider,
  };
}

export type UseCliModelsReturn = ReturnType<typeof useCliModels>;


