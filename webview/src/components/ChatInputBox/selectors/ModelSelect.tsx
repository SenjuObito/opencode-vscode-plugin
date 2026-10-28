import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  writePinnedModelIds,
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
    if (justFinishedDragRef.current || isDraggingActiveRef.current) {
      return;
    }
    onChange(modelId);
    setIsOpen(false);
    setSearchQuery('');
  }, [onChange]);

  const handleTogglePin = useCallback((e: React.MouseEvent, modelId: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (isDraggingActiveRef.current) return;
    setPinnedIds(togglePinnedModelId(currentProvider, modelId));
  }, [currentProvider]);

  // ── Pinned models drag-to-reorder (Apple Dock fluid style) ──
  const [draggingModelId, setDraggingModelId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragSourceIndexRef = useRef<number | null>(null);
  const dragOverIndexRef = useRef<number | null>(null);
  const draggingModelIdRef = useRef<string | null>(null);
  const isDraggingActiveRef = useRef<boolean>(false);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justFinishedDragRef = useRef<boolean>(false);
  const floatingPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const itemHeightRef = useRef<number>(36);
  const itemWidthRef = useRef<number>(200);
  const pinnedItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pinnedBoundariesRef = useRef<number[]>([]);
  const floatingElRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    draggingModelIdRef.current = draggingModelId;
  }, [draggingModelId]);

  useEffect(() => {
    dragOverIndexRef.current = dragOverIndex;
  }, [dragOverIndex]);

  const pinnedSection = sections.find((s) => s.id === PINNED_GROUP_ID);
  const pinnedModels = pinnedSection ? pinnedSection.models : [];

  const handlePinnedItemMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>, model: ModelInfo, index: number) => {
    if (e.button !== 0 || searchQuery.trim().length > 0) return;
    if (pinnedModels.length <= 1) return;

    // 阻止浏览器默认文本选中，防止触发原生选区和拖拽冲突
    e.preventDefault();
    e.stopPropagation();

    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    dragOffsetRef.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
    itemHeightRef.current = rect.height;
    itemWidthRef.current = rect.width;
    dragStartPosRef.current = { x: e.clientX, y: e.clientY };
    dragSourceIndexRef.current = index;
    dragOverIndexRef.current = index;
    draggingModelIdRef.current = model.id;
    isDraggingActiveRef.current = true;

    // 启动 180ms 长按触发定时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }
    longPressTimerRef.current = setTimeout(() => {
      if (isDraggingActiveRef.current && draggingModelIdRef.current) {
        setDraggingModelId(draggingModelIdRef.current);
        setDragOverIndex(dragSourceIndexRef.current);

        const bounds: number[] = [];
        const count = pinnedModels.length;
        for (let i = 0; i < count - 1; i++) {
          const curr = pinnedItemRefs.current.get(pinnedModels[i]?.id)?.getBoundingClientRect();
          const next = pinnedItemRefs.current.get(pinnedModels[i + 1]?.id)?.getBoundingClientRect();
          if (curr && next) {
            bounds.push((curr.bottom + next.top) / 2);
          } else if (curr) {
            bounds.push(curr.bottom);
          }
        }
        pinnedBoundariesRef.current = bounds;

        floatingPosRef.current = {
          x: e.clientX - dragOffsetRef.current.x,
          y: e.clientY - dragOffsetRef.current.y,
        };
      }
    }, 180);
  }, [searchQuery, pinnedModels]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDraggingActiveRef.current || !dragStartPosRef.current) return;

      const dist = Math.hypot(
        e.clientX - dragStartPosRef.current.x,
        e.clientY - dragStartPosRef.current.y,
      );

      // 短按微动阈值 4px，超过即激活视觉拖拽态
      if (dist > 4) {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }

        if (draggingModelIdRef.current && draggingModelIdRef.current !== draggingModelId) {
          setDraggingModelId(draggingModelIdRef.current);
          setDragOverIndex(dragSourceIndexRef.current);

          const bounds: number[] = [];
          const count = pinnedModels.length;
          for (let i = 0; i < count - 1; i++) {
            const curr = pinnedItemRefs.current.get(pinnedModels[i]?.id)?.getBoundingClientRect();
            const next = pinnedItemRefs.current.get(pinnedModels[i + 1]?.id)?.getBoundingClientRect();
            if (curr && next) {
              bounds.push((curr.bottom + next.top) / 2);
            } else if (curr) {
              bounds.push(curr.bottom);
            }
          }
          pinnedBoundariesRef.current = bounds;

          floatingPosRef.current = {
            x: e.clientX - dragOffsetRef.current.x,
            y: e.clientY - dragOffsetRef.current.y,
          };
        }
      }

      // 实时更新浮动卡片位置
      if (floatingElRef.current) {
        floatingElRef.current.style.left = `${e.clientX - dragOffsetRef.current.x}px`;
        floatingElRef.current.style.top = `${e.clientY - dragOffsetRef.current.y}px`;
      }

      // 如果已经处于拖拽态，实时计算目标插槽
      if (draggingModelIdRef.current && dist > 4) {
        const bounds = pinnedBoundariesRef.current;
        let target = 0;
        for (let i = 0; i < bounds.length; i++) {
          if (e.clientY > bounds[i]) {
            target = i + 1;
          }
        }
        target = Math.max(0, Math.min(pinnedModels.length - 1, target));
        if (target !== dragOverIndexRef.current) {
          dragOverIndexRef.current = target;
          setDragOverIndex(target);
        }
      }
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      if (!isDraggingActiveRef.current) return;

      isDraggingActiveRef.current = false;
      const startPos = dragStartPosRef.current;
      dragStartPosRef.current = null;

      const sourceIdx = dragSourceIndexRef.current;
      const targetIdx = dragOverIndexRef.current;
      const activeDraggingId = draggingModelIdRef.current;
      const wasDragging = draggingModelId !== null;

      draggingModelIdRef.current = null;
      dragSourceIndexRef.current = null;
      dragOverIndexRef.current = null;
      setDraggingModelId(null);
      setDragOverIndex(null);

      const dist = startPos ? Math.hypot(e.clientX - startPos.x, e.clientY - startPos.y) : 0;
      if (dist <= 4 && !wasDragging) {
        // 短按点击，直接选中该模型并关闭下拉框
        if (activeDraggingId) {
          handleSelect(activeDraggingId);
        }
        return;
      }

      // 真正拖拽完成，拦截后续事件
      justFinishedDragRef.current = true;
      setTimeout(() => {
        justFinishedDragRef.current = false;
      }, 150);

      if (
        sourceIdx !== null &&
        targetIdx !== null &&
        sourceIdx !== targetIdx &&
        activeDraggingId
      ) {
        const currentPinnedOrder = [...pinnedIds];
        const sourceModelId = pinnedSection?.models[sourceIdx]?.id;
        const targetModelId = pinnedSection?.models[targetIdx]?.id;

        if (sourceModelId && targetModelId) {
          const fromIdx = currentPinnedOrder.indexOf(sourceModelId);
          const toIdx = currentPinnedOrder.indexOf(targetModelId);

          if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
            const nextPinnedIds = [...currentPinnedOrder];
            const [removed] = nextPinnedIds.splice(fromIdx, 1);
            nextPinnedIds.splice(toIdx, 0, removed);

            setPinnedIds(nextPinnedIds);
            writePinnedModelIds(currentProvider, nextPinnedIds);
          }
        }
      }
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [pinnedIds, pinnedSection, currentProvider, draggingModelId, pinnedModels, handleSelect]);

  useEffect(() => {
    if (!isOpen) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      isDraggingActiveRef.current = false;
      setDraggingModelId(null);
      setDragOverIndex(null);
      dragStartPosRef.current = null;
      draggingModelIdRef.current = null;
    }
  }, [isOpen]);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (isDraggingActiveRef.current || justFinishedDragRef.current || draggingModelIdRef.current) {
        return;
      }
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

  const draggingModel = draggingModelId
    ? pinnedModels.find((m) => m.id === draggingModelId)
    : null;

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
          className={`selector-dropdown model-selector-dropdown ${draggingModelId ? 'is-reordering' : ''}`}
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
                {section.models.map((model, idx) => {
                  const isPinned = pinnedSet.has(model.id);
                  const isPinnedSection = section.id === PINNED_GROUP_ID;
                  const isThisLifted = isPinnedSection && draggingModelId === model.id;

                  let transformY = 0;
                  if (
                    isPinnedSection &&
                    draggingModelId !== null &&
                    dragSourceIndexRef.current !== null &&
                    dragOverIndex !== null &&
                    !isThisLifted
                  ) {
                    const src = dragSourceIndexRef.current;
                    const tgt = dragOverIndex;
                    const itemHeight = itemHeightRef.current || 36;
                    if (src < tgt) {
                      if (idx > src && idx <= tgt) {
                        transformY = -itemHeight;
                      }
                    } else if (src > tgt) {
                      if (idx >= tgt && idx < src) {
                        transformY = itemHeight;
                      }
                    }
                  }

                  const itemStyle: React.CSSProperties = isPinnedSection
                    ? {
                        transform: transformY !== 0 ? `translateY(${transformY}px)` : undefined,
                      }
                    : {};

                  const optionClassNames = [
                    'selector-option',
                    isSelectedModel(model.id) ? 'selected' : '',
                    isPinnedSection ? 'model-option-pinned-item' : '',
                    isThisLifted ? 'model-option-slot' : '',
                  ].filter(Boolean).join(' ');

                  return (
                    <div
                      key={model.id}
                      ref={(el) => {
                        if (isPinnedSection) {
                          if (el) pinnedItemRefs.current.set(model.id, el);
                          else pinnedItemRefs.current.delete(model.id);
                        }
                      }}
                      style={itemStyle}
                      className={optionClassNames}
                      onMouseDown={isPinnedSection ? (e) => handlePinnedItemMouseDown(e, model, idx) : undefined}
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
                        onMouseDown={(e) => e.stopPropagation()}
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

      {typeof document !== 'undefined' && draggingModel && createPortal(
        <div
          ref={floatingElRef}
          className="model-option-lifted"
          data-testid="model-option-lifted"
          style={{
            position: 'fixed',
            width: `${itemWidthRef.current}px`,
            left: `${floatingPosRef.current?.x ?? 0}px`,
            top: `${floatingPosRef.current?.y ?? 0}px`,
            zIndex: 99999,
            pointerEvents: 'none',
          }}
        >
          <ProviderModelIcon
            providerId={currentProvider}
            modelId={draggingModel.id}
            size={16}
            colored
          />
          <div style={MODEL_OPTION_INFO_STYLE}>
            <span style={MODEL_TEXT_STYLE}>{getModelLabel(draggingModel)}</span>
            {getModelDescription(draggingModel) && (
              <span className="model-description" style={MODEL_TEXT_STYLE}>{getModelDescription(draggingModel)}</span>
            )}
          </div>
          <button
            type="button"
            className="model-pin-button is-pinned"
            tabIndex={-1}
          >
            <span className="codicon codicon-pinned" />
          </button>
        </div>,
        document.getElementById('app') ?? document.body,
      )}
    </div>
  );
};

export default ModelSelect;
