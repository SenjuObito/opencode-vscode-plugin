import { useState, useCallback, useEffect } from 'react';
import type { CodexCustomModel } from '../../../types/provider';
import { STORAGE_KEYS, validateCodexCustomModels } from '../../../types/provider';


/**
 * Read plugin-level custom models from localStorage
 */
function stripContextWindowMetadata(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map(model => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      return model;
    }
    return Object.fromEntries(
      Object.entries(model).filter(([key]) => key !== 'contextWindowTokens'),
    );
  });
}

function validatePluginModels(storageKey: string, value: unknown): CodexCustomModel[] {
  const candidate = storageKey === STORAGE_KEYS.CLAUDE_CUSTOM_MODELS
    ? stripContextWindowMetadata(value)
    : value;
  return validateCodexCustomModels(candidate);
}

function readPluginModels(storageKey: string): CodexCustomModel[] {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return validatePluginModels(storageKey, parsed);
  } catch {
    return [];
  }
}

/**
 * Write plugin-level custom models to localStorage and notify listeners
 */
function writePluginModels(storageKey: string, models: CodexCustomModel[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(models));
    window.dispatchEvent(new CustomEvent('localStorageChange', { detail: { key: storageKey } }));
  } catch {
    // localStorage write failure (e.g. quota exceeded)
  }
}




/** Custom event detail shape for localStorageChange */
interface LocalStorageChangeDetail {
  key: string;
}

/**
 * Hook to manage plugin-level custom models with localStorage persistence.
 * Listens for both native StorageEvent (cross-tab) and custom localStorageChange (same-tab) events.
 */
export function usePluginModels(storageKey: string) {
  const [models, setModels] = useState<CodexCustomModel[]>(() => readPluginModels(storageKey));

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === storageKey) {
        setModels(readPluginModels(storageKey));
      }
    };
    const handleCustomChange = (e: Event) => {
      const detail = (e as CustomEvent<LocalStorageChangeDetail>).detail;
      if (detail?.key === storageKey) {
        setModels(readPluginModels(storageKey));
      }
    };
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('localStorageChange', handleCustomChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('localStorageChange', handleCustomChange);
    };
  }, [storageKey]);

  const updateModels = useCallback((newModels: CodexCustomModel[]) => {
    const validModels = validatePluginModels(storageKey, newModels);
    setModels(validModels);
    writePluginModels(storageKey, validModels);
  }, [storageKey]);

  return { models, updateModels };
}
