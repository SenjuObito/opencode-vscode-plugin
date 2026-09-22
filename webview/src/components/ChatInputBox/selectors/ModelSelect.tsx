import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OPENCODE_MODELS } from '../types';
import type { ModelInfo } from '../types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import {
  buildModelDropdownSections,
  MAX_VISIBLE_MODEL_OPTIONS,
  PINNED_GROUP_ID,
  readPinnedModelIds,
  shouldShowModelSearch,
  togglePinnedModelId,
} from '../modelSelectUtils';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
  overflowX: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};
const MODEL_OPTION_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' };
const MODEL_TEXT_STYLE: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const DROPDOWN_LIST_STYLE: React.CSSProperties = { overflowY: 'auto', flex: 1, minHeight: 0 };
/** Cap model dropdown height so long lists scroll instead of filling the panel. */
const DROPDOWN_MAX_HEIGHT_PX = 300;

interface ModelSelectProps {
  value: string;
  onChange: (modelId: string) => void;
  models?: ModelInfo[];
  currentProvider?: string;
  /** True while CLI providers (OpenCode) are still fetching model catalogs. */
  loading?: boolean;
  /** Set when the CLI model catalog fetch failed (or timed out); row offers retry. */
  error?: string | null;
  /** Retries the CLI model catalog fetch for the current provider. */
  onRetry?: () => void;
  /** Refreshes the model catalog. */
  onRefresh?: () => void;
  onAddModel?: () => void;
}

const LOADING_OPTION_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'default',
};

/**
 * ModelSelect - Model selector component for OpenCode models
 */
type RefreshFeedbackState = 'idle' | 'loading' | 'success' | 'error';

export const ModelSelect = ({
  value,
  onChange,
  models = OPENCODE_MODELS,
  currentProvider = 'opencode',
  loading = false,
  error = null,
  onRetry,
  onRefresh,
  onAddModel,
}: ModelSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => readPinnedModelIds(currentProvider));
  const [refreshState, setRefreshState] = useState<RefreshFeedbackState>('idle');
  const refreshStartTimeRef = useRef<number>(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLoadingRef = useRef(loading);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, maxHeight, recalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
  });

  const currentModel = models.find((m) => m.id === value)
    || (value ? ({ id: value, label: value } as ModelInfo) : models[0]);

  useEffect(() => {
    setPinnedIds(readPinnedModelIds(currentProvider));
  }, [currentProvider]);

  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      if (refreshState === 'loading') {
        const elapsed = Date.now() - refreshStartTimeRef.current;
        const minSpinMs = 600;
        const remaining = Math.max(0, minSpinMs - elapsed);

        const finishTimer = setTimeout(() => {
          const nextState: RefreshFeedbackState = error ? 'error' : 'success';
          setRefreshState(nextState);

          const resetDelay = nextState === 'error' ? 1500 : 1200;
          resetTimerRef.current = setTimeout(() => {
            setRefreshState('idle');
            resetTimerRef.current = null;
          }, resetDelay);
        }, remaining);

        return () => {
          clearTimeout(finishTimer);
        };
      }
    }
    prevLoadingRef.current = loading;
  }, [loading, error, refreshState]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const isSelectedModel = (modelId: string): boolean => modelId === value;

  const getModelLabel = (model: ModelInfo): string => {
    return model?.label || model?.id || '';
  };

  const getModelDescription = (model: ModelInfo): string | undefined => {
    return model?.description;
  };

  const normalizedSearchQuery = deferredSearchQuery.trim().toLowerCase();
  const filteredModels = normalizedSearchQuery
    ? models.filter((model) => {
        const label = getModelLabel(model);
        const description = getModelDescription(model) ?? '';
        return [model.id, label, description].some((text) => text.toLowerCase().includes(normalizedSearchQuery));
      })
    : models;

  const { sections, hiddenCount: hiddenModelCount } = buildModelDropdownSections(filteredModels, pinnedIds, {
    visibleLimit: MAX_VISIBLE_MODEL_OPTIONS,
  });
  const visibleModelCount = sections.reduce((n, s) => n + s.models.length, 0);
  const showSearch = shouldShowModelSearch(models.length, searchQuery);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery('');
    }
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  /**
   * Select model
   */
  const handleSelect = useCallback((modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
    setSearchQuery('');
  }, [onChange]);

  const handleTogglePin = useCallback((e: React.MouseEvent, modelId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setPinnedIds(togglePinnedModelId(currentProvider, modelId));
  }, [currentProvider]);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };

    // Delay adding event listener to prevent immediate trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (isOpen) {
      recalculate();
    }
  }, [isOpen, filteredModels.length, pinnedIds.length, loading, recalculate]);

  const renderSectionLabel = (sectionId: string, sectionLabel: string): string => {
    if (sectionId === PINNED_GROUP_ID) {
      return t('models.pinned', { defaultValue: 'Pinned' });
    }
    return sectionLabel;
  };

  const handleRefreshClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshState === 'loading' || loading) {
      return;
    }
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setRefreshState('loading');
    refreshStartTimeRef.current = Date.now();
    if (onRefresh) {
      onRefresh();
    } else if (onRetry) {
      onRetry();
    }
  }, [refreshState, loading, onRefresh, onRetry]);

  const isRefreshing = loading || refreshState === 'loading';
  const refreshButtonClass = [
    'selector-refresh-btn',
    isRefreshing ? 'is-loading' : '',
    refreshState === 'success' ? 'is-success' : '',
    refreshState === 'error' ? 'is-error' : '',
  ].filter(Boolean).join(' ');

  let refreshTooltip = t('models.refresh', { defaultValue: 'Refresh models' });
  let refreshIconClass = 'codicon-refresh';

  if (isRefreshing) {
    refreshTooltip = t('models.refreshing', { defaultValue: 'Refreshing...' });
    refreshIconClass = 'codicon-loading codicon-modifier-spin';
  } else if (refreshState === 'success') {
    refreshTooltip = t('models.refreshSuccess', { defaultValue: 'Refresh succeeded' });
    refreshIconClass = 'codicon-check';
  } else if (refreshState === 'error') {
    refreshTooltip = t('models.refreshFailed', { defaultValue: 'Refresh failed' });
    refreshIconClass = 'codicon-error';
  }

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        title={t('chat.currentModel', { model: getModelLabel(currentModel) })}
      >
        <ProviderModelIcon
          providerId={currentProvider}
          modelId={currentModel.id}
          size={12}
          colored
        />
        <span className="selector-button-text">{getModelLabel(currentModel)}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown model-selector-dropdown"
          style={{
            ...DROPDOWN_STYLE,
            ...positionedStyle,
            maxHeight: maxHeight
              ? `${Math.min(DROPDOWN_MAX_HEIGHT_PX, maxHeight)}px`
              : `${DROPDOWN_MAX_HEIGHT_PX}px`,
          }}
        >
          {(showSearch || onRefresh || onRetry) && (
            <div className="selector-search-row selector-search-row--sticky">
              <input
                className="selector-search-input"
                data-testid="model-search-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('models.searchPlaceholder', { defaultValue: 'Search models' })}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
              {(onRefresh || onRetry) && (
                <button
                  type="button"
                  className={refreshButtonClass}
                  data-testid="model-refresh-button"
                  onClick={handleRefreshClick}
                  title={refreshTooltip}
                  disabled={isRefreshing}
                  aria-label={refreshTooltip}
                >
                  <span className={`codicon ${refreshIconClass}`} />
                </button>
              )}
            </div>
          )}
          <div className="model-selector-list" style={DROPDOWN_LIST_STYLE}>
            {loading && models.length === 0 && (
              <div
                className="selector-option selector-option-status"
                data-testid="model-loading"
                style={LOADING_OPTION_STYLE}
              >
                <span className="codicon codicon-loading codicon-modifier-spin" />
                <span>{t('chat.loadingDropdown')}</span>
              </div>
            )}
            {!loading && error && (
              <div
                className="selector-option selector-option-status"
                data-testid="model-load-error"
                style={{ ...LOADING_OPTION_STYLE, cursor: onRetry ? 'pointer' : 'default' }}
                title={error}
                onClick={() => onRetry?.()}
              >
                <span className="codicon codicon-warning" />
                <span style={{ flex: 1, minWidth: 0 }}>{t('chat.modelsLoadFailed')}</span>
                <span className="codicon codicon-refresh" />
              </div>
            )}
            {sections.map((section) => (
              <div key={section.id} className="model-selector-section" data-testid={`model-section-${section.id}`}>
                {section.label !== '' || section.id === PINNED_GROUP_ID ? (
                  <div className="model-selector-group-header" data-testid={`model-group-${section.id}`}>
                    {section.id === PINNED_GROUP_ID && (
                      <span className="codicon codicon-pinned model-selector-group-icon" />
                    )}
                    <span>{renderSectionLabel(section.id, section.label)}</span>
                  </div>
                ) : null}
                {section.models.map((model) => {
                  const isPinned = pinnedSet.has(model.id);
                  return (
                    <div
                      key={model.id}
                      className={`selector-option ${isSelectedModel(model.id) ? 'selected' : ''}`}
                      onClick={() => handleSelect(model.id)}
                      data-testid={`model-option-${model.id}`}
                    >
                      <ProviderModelIcon
                        providerId={currentProvider}
                        modelId={model.id}
                        size={16}
                        colored
                      />
                      <div style={MODEL_OPTION_INFO_STYLE}>
                        <span style={MODEL_TEXT_STYLE}>{getModelLabel(model)}</span>
                        {getModelDescription(model) && (
                          <span className="model-description" style={MODEL_TEXT_STYLE}>{getModelDescription(model)}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className={`model-pin-button ${isPinned ? 'is-pinned' : ''}`}
                        data-testid={`model-pin-${model.id}`}
                        title={isPinned
                          ? t('models.unpin', { defaultValue: 'Unpin' })
                          : t('models.pin', { defaultValue: 'Pin' })}
                        aria-label={isPinned
                          ? t('models.unpin', { defaultValue: 'Unpin' })
                          : t('models.pin', { defaultValue: 'Pin' })}
                        onClick={(e) => handleTogglePin(e, model.id)}
                      >
                        <span className={`codicon ${isPinned ? 'codicon-pinned' : 'codicon-pin'}`} />
                      </button>
                      {isSelectedModel(model.id) && (
                        <span className="codicon codicon-check check-mark" />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {visibleModelCount === 0 && !loading && (
              <div className="selector-option selector-option-status">
                {t('models.noModelsFound', { defaultValue: 'No models found' })}
              </div>
            )}
            {hiddenModelCount > 0 && (
              <div className="selector-option selector-option-status" data-testid="model-hidden-count">
                {t('models.hiddenModelCount', {
                  count: hiddenModelCount,
                  defaultValue: `+ ${hiddenModelCount} more models. Type to search.`,
                })}
              </div>
            )}
            {onAddModel && (
              <div className="selector-divider" />
            )}
            {onAddModel && (
              <div
                className="selector-option selector-option-add"
                onClick={() => { onAddModel(); setIsOpen(false); setSearchQuery(''); }}
              >
                <span className="codicon codicon-add selector-add-icon" />
                <span>{t('models.addModel')}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelSelect;
