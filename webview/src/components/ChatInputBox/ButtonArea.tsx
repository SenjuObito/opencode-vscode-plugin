import { useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ButtonAreaProps, PermissionMode, ReasoningEffort } from './types';
import { OPENCODE_DEFAULT_MODEL_ID, getAvailableReasoningLevels } from './types';
import { ModelSelect, ModeSelect, ReasoningSelect } from './selectors';
import { useCliModels } from '../../hooks/providers/useCliModels';
import { useToolbarSelectorCompact } from './hooks/useToolbarSelectorCompact';
import { resolveProviderModels } from './resolveProviderModels';
import { getFirstPreferredModelId } from './modelSelectUtils';

/**
 * ButtonArea - Bottom toolbar component
 * Contains mode selector, model selector, send/stop button
 */
export const ButtonArea = ({
  disabled = false,
  hasInputContent = false,
  isLoading = false,
  selectedModel = OPENCODE_DEFAULT_MODEL_ID,
  permissionMode = 'default',
  currentProvider = 'opencode',
  reasoningEffort = 'medium',
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onReasoningChange,
  onAddModel,
}: ButtonAreaProps) => {
  const { t } = useTranslation();
  const { cliModels, cliModelsLoading, cliModelsError, cliDefaultModel, cliCatalogHasEntries, refreshCliModels } = useCliModels(currentProvider);

  const availableModels = useMemo(() => {
    return resolveProviderModels({
      provider: currentProvider,
      cliModels,
      cliCatalogHasEntries,
    });
  }, [currentProvider, cliModels, cliCatalogHasEntries]);

  // 所选模型的 opencode variants（推理力度档位）。
  const selectedModelInfo = availableModels.find((m) => m.id === selectedModel);
  const availableReasoningLevels = getAvailableReasoningLevels(
    currentProvider,
    selectedModel,
    selectedModelInfo?.variants,
  );

  // Ctrl+T 循环切换推理力度（对齐 opencode TUI `variant_cycle` 原生键位）。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key !== 't' && e.key !== 'T') return;
      const levels = availableReasoningLevels;
      if (levels.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const idx = levels.findIndex((level) => level.id === reasoningEffort);
      const next = levels[(idx + 1) % levels.length] ?? levels[0];
      onReasoningChange?.(next.id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [availableReasoningLevels, reasoningEffort, onReasoningChange]);

  // When a dynamic model catalog arrives, ensure selection is a real entry.
  // The correction is DELAYED: on cold start the catalog can be transiently
  // incomplete (daemon prewarming, provider auth not warm yet) and an
  // immediate switch would clobber the user's persisted selection restored
  // from localStorage / backend tab state. If the model reappears (catalog
  // refresh) or the user picks another one within the window, we cancel.
  const AUTO_CORRECT_DELAY_MS = 4000;
  const latestCatalogRef = useRef({ models: availableModels, selectedModel, cliDefaultModel });
  latestCatalogRef.current = { models: availableModels, selectedModel, cliDefaultModel };
  useEffect(() => {
    const isDynamicProvider = currentProvider === 'opencode' || currentProvider === 'codex';
    if (!isDynamicProvider) return;
    // Only correct once a *real* catalog arrived. Static fallback lists
    // (OPENCODE_MODELS = just "opencode-default", CODEX built-ins, …) must not
    // clobber the user's choice — especially when ChatScreen remounts after
    // leaving history and briefly shows the fallback before the cache/fetch
    // lands.
    if (!cliCatalogHasEntries) return;
    if (cliModelsLoading) return;
    if (!availableModels.length || !onModelSelect) return;
    const exists = availableModels.some((model) => model.id === selectedModel);
    if (!exists) {
      const fallbackId = getFirstPreferredModelId(currentProvider, availableModels, cliDefaultModel) ?? availableModels[0].id;
      const timer = window.setTimeout(() => {
        // Re-check against the *latest* state at fire time.
        const { models, selectedModel: currentSelection } = latestCatalogRef.current;
        const stillMissing = !models.some((model) => model.id === currentSelection);
        const stillSameSelection = currentSelection === selectedModel;
        if (stillMissing && stillSameSelection) {
          onModelSelect(fallbackId);
        }
      }, AUTO_CORRECT_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
  }, [
    availableModels,
    currentProvider,
    onModelSelect,
    selectedModel,
    cliDefaultModel,
    cliCatalogHasEntries,
    cliModelsLoading,
  ]);

  /**
   * Handle submit button click
   */
  const handleSubmitClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSubmit?.();
  }, [onSubmit]);

  /**
   * Handle stop button click
   */
  const handleStopClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStop?.();
  }, [onStop]);

  /**
   * Handle mode selection
   */
  const handleModeSelect = useCallback((mode: PermissionMode) => {
    onModeSelect?.(mode);
  }, [onModeSelect]);

  /**
   * Handle model selection
   */
  const handleModelSelect = useCallback((modelId: string) => {
    onModelSelect?.(modelId);
  }, [onModelSelect]);

  /**
   * Handle reasoning depth selection
   */
  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    onReasoningChange?.(effort);
  }, [onReasoningChange]);

  // Collapse selector labels for every CLI when left cluster is about to hit the send cluster (10px).
  const buttonAreaRef = useRef<HTMLDivElement>(null);
  const buttonAreaLeftRef = useRef<HTMLDivElement>(null);
  const buttonAreaRightRef = useRef<HTMLDivElement>(null);
  const selectorContentKey = [
    currentProvider,
    selectedModel,
    permissionMode,
    reasoningEffort,
    cliModelsLoading ? 'loading' : 'ready',
  ].join('|');
  const selectorsCompact = useToolbarSelectorCompact(
    buttonAreaRef,
    buttonAreaLeftRef,
    buttonAreaRightRef,
    selectorContentKey,
  );

  return (
    <div
      ref={buttonAreaRef}
      className={`button-area${selectorsCompact ? ' button-area--compact' : ''}`}
      data-provider={currentProvider}
    >
      {/* Left side: selectors */}
      <div ref={buttonAreaLeftRef} className="button-area-left">
        <ModeSelect value={permissionMode} onChange={handleModeSelect} provider={currentProvider} />
        <ModelSelect
          value={selectedModel}
          onChange={handleModelSelect}
          models={availableModels}
          currentProvider={currentProvider}
          loading={cliModelsLoading}
          error={cliModelsError}
          onRetry={() => refreshCliModels(currentProvider)}
          onAddModel={onAddModel}
        />
        <ReasoningSelect
          value={reasoningEffort}
          onChange={handleReasoningChange}
          selectedModel={selectedModel}
          currentProvider={currentProvider}
          modelVariants={selectedModelInfo?.variants}
        />
      </div>

      {/* Right side: tool buttons */}
      <div ref={buttonAreaRightRef} className="button-area-right">
        <div className="button-divider" />

        {/* Send/Stop button */}
        {isLoading ? (
          <button
            className="submit-button stop-button"
            onClick={handleStopClick}
            title={t('chat.stopGeneration')}
          >
            <span className="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button
            className="submit-button"
            onClick={handleSubmitClick}
            disabled={disabled || !hasInputContent}
            title={t('chat.sendMessageEnter')}
          >
            <span className="codicon codicon-send" />
          </button>
        )}
      </div>
    </div>
  );
};

export default ButtonArea;
