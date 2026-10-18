import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { SessionTabData } from './types';
import { SessionTabContextMenu } from './SessionTabContextMenu';

export interface SessionTabBarProps {
  tabs: SessionTabData[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, newTitle: string) => void;
  onForkTab: (tab: SessionTabData) => void;
  onExportTab: (tab: SessionTabData) => void;
  onShareTab: (tab: SessionTabData) => void;
  onCopyShareLinkTab: (tab: SessionTabData) => void;
  onUnshareTab: (tab: SessionTabData) => void;
  onReorderTabs?: (sourceIndex: number, targetIndex: number) => void;
  t: TFunction;
}

interface ContextMenuState {
  x: number;
  y: number;
  tab: SessionTabData;
}

export const SessionTabBar: React.FC<SessionTabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onRenameTab,
  onForkTab,
  onExportTab,
  onShareTab,
  onCopyShareLinkTab,
  onUnshareTab,
  onReorderTabs,
  t,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState<number>(tabs.length);
  const editInputRef = useRef<HTMLInputElement>(null);
  const tabWidthsRef = useRef<Record<string, number>>({});

  // ── Drag to reorder tabs (no long-press wait) ──
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(null);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingActiveRef = useRef<boolean>(false);
  const draggingTabIdRef = useRef<string | null>(null);
  const dropIndicatorIndexRef = useRef<number | null>(null);
  const tabElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const justFinishedDragRef = useRef<boolean>(false);
  // 正在随鼠标跟随的 DOM 元素及鼠标相对该元素左上角的偏移量
  const draggingElementRef = useRef<HTMLDivElement | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    draggingTabIdRef.current = draggingTabId;
  }, [draggingTabId]);

  useEffect(() => {
    dropIndicatorIndexRef.current = dropIndicatorIndex;
  }, [dropIndicatorIndex]);

  // Enable horizontal scrolling with mouse wheel if needed
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (containerRef.current && e.deltaY !== 0) {
      containerRef.current.scrollLeft += e.deltaY;
    }
  }, []);

  // Calculate visible tabs based on container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const calculateVisibleTabs = () => {
      const containerW = el.clientWidth;
      if (containerW <= 0) return;
      const GAP = 4;
      const OVERFLOW_BTN_W = 32;

      let total = 0;
      for (let i = 0; i < tabs.length; i++) {
        const w = tabWidthsRef.current[tabs[i].id] || 110;
        total += (i > 0 ? GAP : 0) + w;
      }

      if (total <= containerW) {
        setVisibleCount(tabs.length);
        return;
      }

      const available = Math.max(60, containerW - OVERFLOW_BTN_W - GAP);
      let used = 0;
      let count = 0;
      for (let i = 0; i < tabs.length; i++) {
        const w = tabWidthsRef.current[tabs[i].id] || 110;
        if (used + (count > 0 ? GAP : 0) + w <= available) {
          used += (count > 0 ? GAP : 0) + w;
          count++;
        } else {
          break;
        }
      }
      setVisibleCount(Math.max(1, count));
    };

    calculateVisibleTabs();

    const ro = new ResizeObserver(() => {
      calculateVisibleTabs();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs]);

  // Close overflow menu on outside click or escape
  useEffect(() => {
    if (!overflowOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        overflowMenuRef.current &&
        !overflowMenuRef.current.contains(target) &&
        overflowBtnRef.current &&
        !overflowBtnRef.current.contains(target)
      ) {
        setOverflowOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [overflowOpen]);

  // Compute visibleTabs and overflowTabs, ensuring active tab is visible if possible
  let visibleTabs: SessionTabData[] = tabs.slice(0, visibleCount);
  let overflowTabs: SessionTabData[] = tabs.slice(visibleCount);

  const activeInOverflowIdx = overflowTabs.findIndex((t) => t.id === activeTabId);
  if (activeInOverflowIdx >= 0 && visibleTabs.length > 0) {
    const activeTab = overflowTabs[activeInOverflowIdx];
    visibleTabs = [...visibleTabs.slice(0, visibleTabs.length - 1), activeTab];
    overflowTabs = tabs.filter((t) => !visibleTabs.some((vt) => vt.id === t.id));
  }

  const hasOverflow = overflowTabs.length > 0;
  const isAnyOverflowBusy = overflowTabs.some((t) => t.streamingActive || t.loading);
  const isAnyOverflowAttention = overflowTabs.some(
    (t) => (t.pendingPermissions?.length ?? 0) > 0 || (t.pendingQuestions?.length ?? 0) > 0
  );

  const startEditing = useCallback((tab: SessionTabData) => {
    setEditingTabId(tab.id);
    setEditTitle(tab.title);
    setTimeout(() => {
      if (editInputRef.current) {
        editInputRef.current.focus();
        editInputRef.current.select();
      }
    }, 20);
  }, []);

  const commitEditing = useCallback(
    (tabId: string) => {
      const trimmed = editTitle.trim();
      if (trimmed) {
        onRenameTab(tabId, trimmed);
      }
      setEditingTabId(null);
    },
    [editTitle, onRenameTab]
  );

  const cancelEditing = useCallback(() => {
    setEditingTabId(null);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, tab: SessionTabData) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      tab,
    });
  }, []);

  // ── Drag and Reorder listeners ──
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDraggingActiveRef.current || !dragStartPosRef.current) return;

      const dist = Math.hypot(e.clientX - dragStartPosRef.current.x, e.clientY - dragStartPosRef.current.y);

      // Not yet a real drag: wait until the mouse moves beyond a small threshold
      // so a plain click still selects the tab without any drag visual flicker.
      if (dist <= 5) return;

      // Enter drag visual state once we move beyond the threshold.
      const targetTabId = draggingTabIdRef.current;
      if (targetTabId) {
        setDraggingTabId(targetTabId);
        setDropIndicatorIndex(dropIndicatorIndexRef.current);
      }

      // 让被拖拽的 tab 标题固定定位并跟随鼠标移动（脱离文档流，其余 tab 自动让路）
      const followEl = draggingElementRef.current;
      if (followEl) {
        followEl.classList.add('session-tab-item-following');
        followEl.style.position = 'fixed';
        followEl.style.left = `${e.clientX - (dragOffsetRef.current?.x ?? 0)}px`;
        followEl.style.top = `${e.clientY - (dragOffsetRef.current?.y ?? 0)}px`;
        followEl.style.zIndex = '9999';
        followEl.style.pointerEvents = 'none';
        followEl.style.transition = 'none';
        followEl.style.width = `${followEl.offsetWidth}px`;
      }

      // 计算 drop 插入索引：基于鼠标 X 与各 tab 中点比较（跳过已脱离流的拖拽元素）
      const mouseX = e.clientX;
      let targetIndex = visibleTabs.length;

      for (let i = 0; i < visibleTabs.length; i++) {
        const tabItem = visibleTabs[i];
        const el = tabElementsRef.current.get(tabItem.id);
        if (el && el !== followEl) {
          const rect = el.getBoundingClientRect();
          const midX = rect.left + rect.width / 2;
          if (mouseX < midX) {
            targetIndex = i;
            break;
          }
        }
      }

      dropIndicatorIndexRef.current = targetIndex;
      setDropIndicatorIndex(targetIndex);
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (!isDraggingActiveRef.current) return;

      isDraggingActiveRef.current = false;

      const startPos = dragStartPosRef.current;
      dragStartPosRef.current = null;

      const currentDraggingId = draggingTabIdRef.current;
      const currentDropIndex = dropIndicatorIndexRef.current;

      // 清理被拖拽元素的 fixed 跟随样式，恢复正常文档流布局
      const followEl = draggingElementRef.current;
      if (followEl) {
        followEl.classList.remove('session-tab-item-following');
        followEl.style.position = '';
        followEl.style.left = '';
        followEl.style.top = '';
        followEl.style.zIndex = '';
        followEl.style.pointerEvents = '';
        followEl.style.transition = '';
        followEl.style.width = '';
      }
      draggingElementRef.current = null;
      dragOffsetRef.current = null;

      draggingTabIdRef.current = null;
      dropIndicatorIndexRef.current = null;
      setDraggingTabId(null);
      setDropIndicatorIndex(null);

      // 短按（几乎未移动）：视为普通点击，由 onClick 负责选中标签，不重排
      // 拖拽（移动超过阈值）：执行顺序调整，并 120ms 内抑制 onClick 误触
      const isShortPress = startPos
        ? Math.hypot(e.clientX - startPos.x, e.clientY - startPos.y) <= 5
        : true;

      if (!isShortPress && currentDraggingId && currentDropIndex != null) {
        const sourceGlobalIndex = tabs.findIndex((t) => t.id === currentDraggingId);
        if (sourceGlobalIndex >= 0) {
          let targetGlobalIndex: number;
          if (currentDropIndex < visibleTabs.length) {
            const targetTab = visibleTabs[currentDropIndex];
            targetGlobalIndex = tabs.findIndex((t) => t.id === targetTab.id);
          } else {
            const lastVisible = visibleTabs[visibleTabs.length - 1];
            targetGlobalIndex = lastVisible ? tabs.findIndex((t) => t.id === lastVisible.id) : sourceGlobalIndex;
          }

          if (targetGlobalIndex >= 0 && sourceGlobalIndex !== targetGlobalIndex) {
            onReorderTabs?.(sourceGlobalIndex, targetGlobalIndex);
          }
        }
      }

      if (!isShortPress) {
        justFinishedDragRef.current = true;
        setTimeout(() => {
          justFinishedDragRef.current = false;
        }, 120);
      }
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [visibleTabs, tabs, onReorderTabs]);

  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, tab: SessionTabData, visibleIndex: number) => {
      if (e.button !== 0) return; // Only primary button
      if (e.detail > 1) return;   // Ignore multi-clicks (double-click opens rename)
      if (editingTabId === tab.id) return;

      dragStartPosRef.current = { x: e.clientX, y: e.clientY };
      draggingTabIdRef.current = tab.id;
      dropIndicatorIndexRef.current = visibleIndex;

      // 记录被按下的 tab 元素，以及鼠标相对该元素左上角的偏移量，
      // 用于拖拽时让标题精准跟随鼠标。
      const el = e.currentTarget as HTMLDivElement;
      draggingElementRef.current = el;
      const rect = el.getBoundingClientRect();
      dragOffsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      // Enter "may-drag" mode immediately on press — no long-press wait.
      // The actual drag visual starts once the mouse moves beyond a small threshold
      // (see handleGlobalMouseMove), so a plain click still selects the tab cleanly.
      isDraggingActiveRef.current = true;
    },
    [editingTabId]
  );

  return (
    <>
      <div
        className={`session-tabs-container ${draggingTabId ? 'is-reordering' : ''}`}
        ref={containerRef}
        onWheel={handleWheel}
      >
        {visibleTabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          const isEditing = editingTabId === tab.id;
          const isBusy = tab.streamingActive || tab.loading;
          const isDragging = tab.id === draggingTabId;
          const hasPendingAction =
            (tab.pendingPermissions?.length ?? 0) > 0 || (tab.pendingQuestions?.length ?? 0) > 0;

          const showDropBefore = draggingTabId !== null && dropIndicatorIndex === idx;
          const showDropAfter =
            draggingTabId !== null &&
            dropIndicatorIndex === visibleTabs.length &&
            idx === visibleTabs.length - 1;

          return (
            <React.Fragment key={tab.id}>
              {showDropBefore && <div className="session-tab-drop-indicator" />}
              <div
                ref={(el) => {
                  if (el) {
                    // 拖拽跟随期间，该元素已脱离文档流并由 JS 直接操作位置，
                    // 避免 React 重渲染时丢失或覆盖该引用。
                    if (draggingElementRef.current === el) return;
                    tabElementsRef.current.set(tab.id, el);
                    const w = el.getBoundingClientRect().width;
                    if (w > 0 && tabWidthsRef.current[tab.id] !== w) {
                      tabWidthsRef.current[tab.id] = w;
                    }
                  } else {
                    if (draggingElementRef.current === el) return;
                    tabElementsRef.current.delete(tab.id);
                  }
                }}
                className={`session-tab-item ${isActive ? 'active' : ''} ${hasPendingAction ? 'has-attention' : ''} ${isDragging ? 'is-dragging' : ''}`}
                onMouseDown={(e) => handleTabMouseDown(e, tab, idx)}
                onClick={() => {
                  if (justFinishedDragRef.current) return;
                  onSelectTab(tab.id);
                }}
                onContextMenu={(e) => handleContextMenu(e, tab)}
                title={hasPendingAction ? `${tab.title} (${t('common.pendingApproval', { defaultValue: '等待操作' })})` : tab.title}
              >
              <div className="session-tab-icon">
                {hasPendingAction ? (
                  <span
                    className="codicon codicon-warning session-tab-attention-icon"
                    title={t('common.pendingApproval', { defaultValue: '等待操作' })}
                  />
                ) : isBusy ? (
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                ) : (
                  <span className="codicon codicon-comment-discussion" />
                )}
              </div>

              {isEditing ? (
                <input
                  ref={editInputRef}
                  className="session-tab-inline-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitEditing(tab.id);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEditing();
                    }
                  }}
                  onBlur={() => commitEditing(tab.id)}
                  onClick={(e) => e.stopPropagation()}
                  maxLength={50}
                  spellCheck={false}
                />
              ) : (
                <span
                  className="session-tab-title"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startEditing(tab);
                  }}
                >
                  {tab.title}
                </span>
              )}

              <button
                className="session-tab-close-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title={t('common.close', { defaultValue: 'Close' })}
                aria-label={t('common.close', { defaultValue: 'Close' })}
              >
                <span className="codicon codicon-close" />
              </button>
            </div>
            {showDropAfter && <div className="session-tab-drop-indicator" />}
          </React.Fragment>
        );
      })}

        {hasOverflow && (
          <div className="session-tab-overflow-wrapper">
            <button
              ref={overflowBtnRef}
              className={`session-tab-overflow-btn ${overflowOpen ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (!overflowOpen && overflowBtnRef.current) {
                  const rect = overflowBtnRef.current.getBoundingClientRect();
                  setMenuPos({ x: rect.left, y: rect.bottom + 4 });
                }
                setOverflowOpen((prev) => !prev);
              }}
              title={t('common.moreSessions', { defaultValue: '更多会话' })}
              aria-label={t('common.moreSessions', { defaultValue: '更多会话' })}
              aria-expanded={overflowOpen}
            >
              <span className="codicon codicon-ellipsis" />
              {isAnyOverflowAttention ? (
                <span className="session-tab-attention-dot" />
              ) : isAnyOverflowBusy ? (
                <span className="session-tab-busy-dot" />
              ) : null}
            </button>

            {overflowOpen && menuPos && (
              <div
                ref={overflowMenuRef}
                className="session-tab-overflow-menu"
                style={{
                  position: 'fixed',
                  left: `${Math.max(8, Math.min(menuPos.x, window.innerWidth - 220))}px`,
                  top: `${menuPos.y}px`,
                  zIndex: 10000,
                }}
                role="menu"
              >
                {overflowTabs.map((tab) => {
                  const isActive = tab.id === activeTabId;
                  const isBusy = tab.streamingActive || tab.loading;
                  const hasPendingAction =
                    (tab.pendingPermissions?.length ?? 0) > 0 || (tab.pendingQuestions?.length ?? 0) > 0;

                  return (
                    <div
                      key={tab.id}
                      className={`session-tab-overflow-item ${isActive ? 'active' : ''} ${hasPendingAction ? 'has-attention' : ''}`}
                      onClick={() => {
                        setOverflowOpen(false);
                        onSelectTab(tab.id);
                      }}
                      onContextMenu={(e) => {
                        setOverflowOpen(false);
                        handleContextMenu(e, tab);
                      }}
                      title={hasPendingAction ? `${tab.title} (${t('common.pendingApproval', { defaultValue: '等待操作' })})` : tab.title}
                      role="menuitem"
                    >
                      <div className="session-tab-icon">
                        {hasPendingAction ? (
                          <span
                            className="codicon codicon-warning session-tab-attention-icon"
                            title={t('common.pendingApproval', { defaultValue: '等待操作' })}
                          />
                        ) : isBusy ? (
                          <span className="codicon codicon-loading codicon-modifier-spin" />
                        ) : (
                          <span className="codicon codicon-comment-discussion" />
                        )}
                      </div>
                      <span className="session-tab-overflow-title">{tab.title}</span>
                      <button
                        className="session-tab-overflow-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                        title={t('common.close', { defaultValue: 'Close' })}
                        aria-label={t('common.close', { defaultValue: 'Close' })}
                      >
                        <span className="codicon codicon-close" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {contextMenu && (
        <SessionTabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          tab={contextMenu.tab}
          onClose={() => setContextMenu(null)}
          onRename={() => startEditing(contextMenu.tab)}
          onFork={() => onForkTab(contextMenu.tab)}
          onExport={() => onExportTab(contextMenu.tab)}
          onShare={() => onShareTab(contextMenu.tab)}
          onCopyShareLink={() => onCopyShareLinkTab(contextMenu.tab)}
          onUnshare={() => onUnshareTab(contextMenu.tab)}
          t={t}
        />
      )}
    </>
  );
};
