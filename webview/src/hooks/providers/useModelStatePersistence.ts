import { useEffect } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import {
  OPENCODE_DEFAULT_MODEL_ID,
} from '../../components/ChatInputBox/types';
import type {
  PermissionMode,
  ReasoningEffort,
} from '../../components/ChatInputBox/types';
import { readPinnedModelIds } from '../../components/ChatInputBox/modelSelectUtils';

const STORAGE_KEY = 'model-selection-state';
const REASONING_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_VALUES as readonly string[]).includes(value);

export interface UseModelStatePersistenceOptions {
  // Cross-slice load setters (run once on mount)
  setCurrentProvider: (value: string) => void;
  setSelectedOpenCodeModel: (value: string) => void;
  setOpenCodePermissionMode: (value: PermissionMode) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setReasoningEffort: (value: ReasoningEffort) => void;
  // Cross-slice save deps (re-saves on any change)
  currentProvider: string;
  selectedOpenCodeModel: string;
  openCodePermissionMode: PermissionMode;
  reasoningEffort: ReasoningEffort;
}

/**
 * Persisting provider/model state to localStorage for OpenCode
 */
export function useModelStatePersistence(options: UseModelStatePersistenceOptions) {
  const {
    setCurrentProvider,
    setSelectedOpenCodeModel,
    setOpenCodePermissionMode,
    setPermissionMode,
    setReasoningEffort,
    currentProvider,
    selectedOpenCodeModel,
    openCodePermissionMode,
    reasoningEffort,
  } = options;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const initialTabProvider = typeof window.__INITIAL_TAB_PROVIDER__ === 'string'
        ? window.__INITIAL_TAB_PROVIDER__.trim()
        : '';
      const initialTabModel = typeof window.__INITIAL_TAB_MODEL__ === 'string'
        && (!initialTabProvider || initialTabProvider === 'opencode')
        ? window.__INITIAL_TAB_MODEL__.trim()
        : '';
      const pinned = readPinnedModelIds('opencode');
      const firstPinned = pinned.length > 0 ? pinned[0] : null;

      let restoredOpenCodeModel = firstPinned || OPENCODE_DEFAULT_MODEL_ID;
      let restoredOpenCodePermissionMode: PermissionMode = 'build';

      const applyOpenCodeModel = (modelId: unknown) => {
        if (typeof modelId === 'string' && modelId.trim().length > 0) {
          restoredOpenCodeModel = modelId;
          setSelectedOpenCodeModel(modelId);
        }
      };

      setCurrentProvider('opencode');

      if (saved) {
        const state = JSON.parse(saved);
        if (typeof state.openCodePermissionMode === 'string' && state.openCodePermissionMode.length > 0) {
          restoredOpenCodePermissionMode = state.openCodePermissionMode === 'default'
            ? 'build'
            : state.openCodePermissionMode;
        }

        if (isReasoningEffort(state.reasoningEffort)) {
          setReasoningEffort(state.reasoningEffort);
        }

        const openCodeModelCandidate = initialTabModel.length > 0
          ? initialTabModel
          : (firstPinned || state.openCodeModel);
        applyOpenCodeModel(openCodeModelCandidate);
      } else if (initialTabModel.length > 0) {
        applyOpenCodeModel(initialTabModel);
      } else if (firstPinned) {
        applyOpenCodeModel(firstPinned);
      }

      setOpenCodePermissionMode(restoredOpenCodePermissionMode);
      setPermissionMode(restoredOpenCodePermissionMode);

      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30;

      const syncToBackend = () => {
        if (window.sendToJava) {
          if (window.__CCGUI_RECOVERY_RELOAD__ === true) {
            return;
          }
          sendBridgeEvent('set_provider', 'opencode');
          sendBridgeEvent('set_model', restoredOpenCodeModel);
        } else {
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          }
        }
      };
      setTimeout(syncToBackend, 200);
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    let retryTimer: number | undefined;
    let retryCount = 0;

    const persistWhenPageContextIsReady = () => {
      const pageContextPending = window.__CCGUI_PAGE_CONTEXT_READY__ !== true;
      const recoveryStatePending = window.__CCGUI_RECOVERY_RELOAD__ === true
        && window.__CCGUI_RECOVERY_STATE_APPLIED__ !== true;

      if (pageContextPending || recoveryStatePending) {
        retryCount += 1;
        retryTimer = window.setTimeout(
          persistWhenPageContextIsReady,
          retryCount < 50 ? 100 : 1000,
        );
        return;
      }

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          provider: 'opencode',
          openCodeModel: selectedOpenCodeModel,
          openCodePermissionMode,
          reasoningEffort,
        }));
      } catch {
        // Failed to save model selection state — non-fatal.
      }
    };

    persistWhenPageContextIsReady();
    return () => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [
    currentProvider,
    selectedOpenCodeModel,
    openCodePermissionMode,
    reasoningEffort,
  ]);
}

