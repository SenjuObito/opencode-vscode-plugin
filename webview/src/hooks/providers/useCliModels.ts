import { useCallback, useEffect, useRef, useState } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import type { ModelInfo } from '../../components/ChatInputBox/types';
import { OPENCODE_MODELS } from '../../components/ChatInputBox/types';

type CliModelsByProvider = Record<string, ModelInfo[]>;

/** Java/Host may never answer get_cli_models — don't leave the spinner on forever. */
const CLI_MODELS_TIMEOUT_MS = 15_000;

const modelsCache: CliModelsByProvider = {};
const defaultModelCache: Record<string, string> = {};
const catalogHasEntriesCache: Record<string, boolean> = {};

/** Test-only: clear module caches between cases. */
export function __resetCliModelsCacheForTests() {
  for (const key of Object.keys(modelsCache)) delete modelsCache[key];
  for (const key of Object.keys(defaultModelCache)) delete defaultModelCache[key];
  for (const key of Object.keys(catalogHasEntriesCache)) delete catalogHasEntriesCache[key];
}

function fallbackModels(providerId: string): ModelInfo[] {
  if (providerId === 'opencode') return OPENCODE_MODELS;
  return [];
}

function normalizeModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
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
    const variants = Array.isArray(row.variants)
      ? row.variants.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      : undefined;
    // 上下文额度必须透传：daemon 目录是它唯一的来源，丢掉就只能退回 host 硬编码表。
    // 额度是正整数，非整数一律当脏数据丢掉，不做四舍五入。
    const rawContextWindow = Number(row.contextWindow);
    const contextWindow = Number.isInteger(rawContextWindow) && rawContextWindow > 0
      ? rawContextWindow
      : undefined;
    out.push({
      id,
      label,
      description,
      ...(variants && variants.length > 0 ? { variants } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return out;
}

/**
 * Loads model catalogs for OpenCode via channel-manager listModels.
 */
export function useCliModels(currentProvider: string = 'opencode') {
  const [modelsByProvider, setModelsByProvider] = useState<CliModelsByProvider>(() => ({ ...modelsCache }));
  const [defaultModelByProvider, setDefaultModelByProvider] = useState<Record<string, string>>(
    () => ({ ...defaultModelCache }),
  );
  const [catalogHasEntriesByProvider, setCatalogHasEntriesByProvider] = useState<Record<string, boolean>>(
    () => ({ ...catalogHasEntriesCache }),
  );
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [errorByProvider, setErrorByProvider] = useState<Record<string, string>>({});
  const pendingLoadRef = useRef<{ provider: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const clearPendingLoad = useCallback(() => {
    if (pendingLoadRef.current) {
      clearTimeout(pendingLoadRef.current.timer);
      pendingLoadRef.current = null;
    }
  }, []);

  const beginLoad = useCallback((providerId: string) => {
    clearPendingLoad();
    setLoadingProvider(providerId);
    setErrorByProvider((prev) => {
      if (!(providerId in prev)) return prev;
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
    sendBridgeEvent('get_cli_models', providerId);
    pendingLoadRef.current = {
      provider: providerId,
      timer: setTimeout(() => {
        pendingLoadRef.current = null;
        setLoadingProvider((current) => (current === providerId ? null : current));
        setErrorByProvider((prev) => ({ ...prev, [providerId]: 'timeout' }));
      }, CLI_MODELS_TIMEOUT_MS),
    };
  }, [clearPendingLoad]);

  useEffect(() => {
    const handler = (dataOrStr: string | { provider?: string; models?: unknown; success?: boolean; error?: string; defaultModel?: unknown }) => {
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
      modelsCache[provider] = resolvedModels;
      catalogHasEntriesCache[provider] = models.length > 0;
      setModelsByProvider((prev) => ({
        ...prev,
        [provider]: resolvedModels,
      }));
      setCatalogHasEntriesByProvider((prev) => ({ ...prev, [provider]: models.length > 0 }));
      const defaultModel = typeof payload.defaultModel === 'string' && payload.defaultModel.trim()
        ? payload.defaultModel.trim()
        : null;
      if (defaultModel) {
        defaultModelCache[provider] = defaultModel;
      } else {
        delete defaultModelCache[provider];
      }
      setDefaultModelByProvider((prev) => {
        const next = { ...prev };
        if (defaultModel) {
          next[provider] = defaultModel;
        } else {
          delete next[provider];
        }
        return next;
      });
      if (payload.success === false) {
        const message = typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : 'unknown error';
        setErrorByProvider((prev) => ({ ...prev, [provider]: message }));
      } else {
        setErrorByProvider((prev) => {
          if (!(provider in prev)) return prev;
          const next = { ...prev };
          delete next[provider];
          return next;
        });
      }
      if (pendingLoadRef.current?.provider === provider) {
        clearPendingLoad();
      }
      setLoadingProvider((current) => (current === provider ? null : current));
    };

    window.setCliModels = handler;
    return () => {
      if (window.setCliModels === handler) {
        delete window.setCliModels;
      }
      clearPendingLoad();
    };
  }, [clearPendingLoad]);

  useEffect(() => {
    if (modelsByProvider[currentProvider]?.length) return;
    beginLoad(currentProvider);
  }, [currentProvider, modelsByProvider, beginLoad]);

  const refreshCliModels = useCallback((providerId: string) => {
    beginLoad(providerId);
  }, [beginLoad]);

  const cliModels = modelsByProvider[currentProvider]?.length
    ? modelsByProvider[currentProvider]
    : fallbackModels(currentProvider);

  return {
    cliModels,
    cliModelsLoading: loadingProvider === currentProvider,
    cliModelsError: errorByProvider[currentProvider] ?? null,
    cliDefaultModel: defaultModelByProvider[currentProvider] ?? null,
    cliCatalogHasEntries: catalogHasEntriesByProvider[currentProvider] ?? false,
    refreshCliModels,
    modelsByProvider,
  };
}

export type UseCliModelsReturn = ReturnType<typeof useCliModels>;

