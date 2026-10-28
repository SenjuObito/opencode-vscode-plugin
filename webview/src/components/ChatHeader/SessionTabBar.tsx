import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { SessionTabData } from './types';
import { isTabTurnActive } from '../../store/tabRuntime';
import { SessionTabContextMenu } from './SessionTabContextMenu';
import {
  calculateVisibleCount,
  partitionTabs,
  SESSION_TAB_FALLBACK_WIDTH,
  SESSION_TAB_GAP,
  SESSION_TAB_OVERFLOW_RESERVE,
} from '../../utils/tabPartition';

export interface SessionTabBarProps {
  tabs: SessionTabData[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs?: (tabId: string) => void;
  onCloseTabsToLeft?: (tabId: string) => void;
  onCloseTabsToRight?: (tabId: string) => void;
  onCloseAllTabs?: () => void;
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
  onCloseOtherTabs,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseAllTabs,
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
  /**
   * Tab the user just dragged out of the overflow menu. It is forced into the
   * rendered prefix until it is closed or dropped back into the menu, so the
   * drop never gets undone by the width-based recalculation (a long title is
   * wide enough to make the prefix one tab shorter, which used to send it
   * straight back into "…").
   */
  const [pinnedTabId, setPinnedTabId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  // Measured width per tab, kept in state so a fresh measurement re-runs the
  // capacity math and the partition in the same commit cycle.
  const [tabWidths, setTabWidths] = useState<Record<string, number>>({});
  const availableWidthRef = useRef<number>(Number.POSITIVE_INFINITY);

  // ── Drag to reorder tabs (no long-press wait) ──
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(null);
  const [dropOverflowIndex, setDropOverflowIndex] = useState<number | null>(null);
  const [dropTargetArea, setDropTargetArea] = useState<'visible' | 'overflow' | null>(null);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingActiveRef = useRef<boolean>(false);
  const draggingTabIdRef = useRef<string | null>(null);
  const dropIndicatorIndexRef = useRef<number | null>(null);
  const dropOverflowIndexRef = useRef<number | null>(null);
  const dropTargetAreaRef = useRef<'visible' | 'overflow' | null>(null);
  const tabElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const overflowTabElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const justFinishedDragRef = useRef<boolean>(false);
  // 正在随鼠标跟随的 DOM 元素及鼠标相对该元素左上角的偏移量
  const draggingElementRef = useRef<HTMLDivElement | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const dragVisualWidthRef = useRef<number | null>(null);

  useEffect(() => {
    draggingTabIdRef.current = draggingTabId;
  }, [draggingTabId]);

  useEffect(() => {
    dropIndicatorIndexRef.current = dropIndicatorIndex;
  }, [dropIndicatorIndex]);

  useEffect(() => {
    dropOverflowIndexRef.current = dropOverflowIndex;
  }, [dropOverflowIndex]);

  useEffect(() => {
    dropTargetAreaRef.current = dropTargetArea;
  }, [dropTargetArea]);

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

      const widths = tabs.map((tab) => tabWidths[tab.id] ?? SESSION_TAB_FALLBACK_WIDTH);

      let total = 0;
      widths.forEach((width, index) => {
        total += (index > 0 ? SESSION_TAB_GAP : 0) + width;
      });

      if (total <= containerW) {
        // Everything fits, so there is no overflow button to reserve space for.
        availableWidthRef.current = Number.POSITIVE_INFINITY;
        setVisibleCount(tabs.length);
        return;
      }

      const available = Math.max(60, containerW - SESSION_TAB_OVERFLOW_RESERVE);
      availableWidthRef.current = available;
      setVisibleCount(calculateVisibleCount(widths, available));
    };

    calculateVisibleTabs();

    const ro = new ResizeObserver(() => {
      calculateVisibleTabs();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs, tabWidths]);

  // Drop the pin when its tab is gone, so a closed tab cannot keep occupying a
  // forced visible slot forever.
  useEffect(() => {
    if (pinnedTabId && !tabs.some((tab) => tab.id === pinnedTabId)) {
      setPinnedTabId(null);
    }
  }, [pinnedTabId, tabs]);

  // Reveal a freshly pinned tab if the strip is horizontally scrolled. The
  // width-aware partition normally keeps everything inside the bar, but a
  // single tab wider than the container can still need scrolling.
  useEffect(() => {
    if (!pinnedTabId) return undefined;
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current;
      const element = tabElementsRef.current.get(pinnedTabId);
      if (!container || !element) return;
      const containerRect = container.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      if (elementRect.left < containerRect.left) {
        container.scrollLeft -= containerRect.left - elementRect.left;
      } else if (elementRect.right > containerRect.right) {
        container.scrollLeft += elementRect.right - containerRect.right;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pinnedTabId, tabs]);

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

  // The active session and the tab the user just dragged out of the overflow
  // menu must stay rendered; everything else follows the width-based prefix.
  const forcedTabIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeTabId) ids.add(activeTabId);
    if (pinnedTabId) ids.add(pinnedTabId);
    return ids;
  }, [activeTabId, pinnedTabId]);

  // Single source of truth for the visible/overflow split: the two lists are a
  // partition of `tabs` (no tab can be lost) and the forced tabs are promoted
  // by evicting trailing ones instead of by rebuilding either list.
  const { visibleTabs, overflowTabs } = useMemo(
    () => partitionTabs(
      tabs,
      visibleCount,
      forcedTabIds,
      (id) => tabWidths[id] ?? SESSION_TAB_FALLBACK_WIDTH,
      availableWidthRef.current,
    ),
    [tabs, visibleCount, forcedTabIds, tabWidths],
  );

  const hasOverflow = overflowTabs.length > 0;
  const isAnyOverflowBusy = overflowTabs.some(isTabTurnActive);
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
      }

      // 让被拖拽的 tab 标题固定定位并跟随鼠标移动（脱离文档流，其余 tab 自动让路）
      const followEl = draggingElementRef.current;
      if (followEl) {
        followEl.classList.add('session-tab-item-following');
        followEl.style.position = 'fixed';
        followEl.style.left = `${e.clientX - (dragOffsetRef.current?.x ?? 0)}px`;
        followEl.style.top = `${e.clientY - (dragOffsetRef.current?.y ?? 0)}px`;
        followEl.style.zIndex = '10001';
        followEl.style.pointerEvents = 'none';
        followEl.style.transition = 'none';
        const targetWidth = dragVisualWidthRef.current ?? followEl.offsetWidth;
        followEl.style.width = `${targetWidth}px`;
        followEl.style.maxWidth = 'none';
      }

      // 检查鼠标是否在二级菜单（overflowMenu）内部
      const overflowEl = overflowMenuRef.current;
      const overflowRect = overflowEl ? overflowEl.getBoundingClientRect() : null;
      const isOverOverflow =
        overflowOpen &&
        overflowRect &&
        e.clientX >= overflowRect.left - 15 &&
        e.clientX <= overflowRect.right + 15 &&
        e.clientY >= overflowRect.top - 10 &&
        e.clientY <= overflowRect.bottom + 10;

      if (isOverOverflow && overflowTabs.length > 0) {
        // 鼠标在二级菜单内：按垂直 Y 坐标计算 dropOverflowIndex
        const mouseY = e.clientY;
        let targetIndex = overflowTabs.length;

        for (let i = 0; i < overflowTabs.length; i++) {
          const tabItem = overflowTabs[i];
          const el = overflowTabElementsRef.current.get(tabItem.id);
          if (el && el !== followEl) {
            const rect = el.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (mouseY < midY) {
              targetIndex = i;
              break;
            }
          }
        }

        dropTargetAreaRef.current = 'overflow';
        setDropTargetArea('overflow');
        dropOverflowIndexRef.current = targetIndex;
        setDropOverflowIndex(targetIndex);
        dropIndicatorIndexRef.current = null;
        setDropIndicatorIndex(null);
      } else {
        // 鼠标在顶部可见栏或外部：按水平 X 坐标计算 visibleTabs 中的插入索引
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

        dropTargetAreaRef.current = 'visible';
        setDropTargetArea('visible');
        dropIndicatorIndexRef.current = targetIndex;
        setDropIndicatorIndex(targetIndex);
        dropOverflowIndexRef.current = null;
        setDropOverflowIndex(null);
      }
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (!isDraggingActiveRef.current) return;

      isDraggingActiveRef.current = false;

      const startPos = dragStartPosRef.current;
      dragStartPosRef.current = null;

      const currentDraggingId = draggingTabIdRef.current;
      const currentTargetArea = dropTargetAreaRef.current;
      const currentDropIndex = dropIndicatorIndexRef.current;
      const currentDropOverflowIndex = dropOverflowIndexRef.current;

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
        followEl.style.maxWidth = '';
      }
      draggingElementRef.current = null;
      dragOffsetRef.current = null;
      dragVisualWidthRef.current = null;

      draggingTabIdRef.current = null;
      dropIndicatorIndexRef.current = null;
      dropOverflowIndexRef.current = null;
      dropTargetAreaRef.current = null;
      setDraggingTabId(null);
      setDropIndicatorIndex(null);
      setDropOverflowIndex(null);
      setDropTargetArea(null);

      // 短按（几乎未移动）：视为普通点击，由 onClick 负责选中标签，不重排
      // 拖拽（移动超过阈值）：执行顺序调整，并 120ms 内抑制 onClick 误触
      const isShortPress = startPos
        ? Math.hypot(e.clientX - startPos.x, e.clientY - startPos.y) <= 5
        : true;

      if (!isShortPress && currentDraggingId) {
        const sourceGlobalIndex = tabs.findIndex((t) => t.id === currentDraggingId);
        if (sourceGlobalIndex >= 0) {
          let targetGlobalIndex = -1;

          if (currentTargetArea === 'overflow' && currentDropOverflowIndex != null) {
            if (currentDropOverflowIndex < overflowTabs.length) {
              const targetTab = overflowTabs[currentDropOverflowIndex];
              targetGlobalIndex = tabs.findIndex((t) => t.id === targetTab.id);
            } else {
              const lastOverflow = overflowTabs[overflowTabs.length - 1];
              targetGlobalIndex = lastOverflow ? tabs.findIndex((t) => t.id === lastOverflow.id) : sourceGlobalIndex;
            }
          } else if (currentDropIndex != null) {
            if (currentDropIndex < visibleTabs.length) {
              const targetTab = visibleTabs[currentDropIndex];
              targetGlobalIndex = tabs.findIndex((t) => t.id === targetTab.id);
            } else {
              const lastVisible = visibleTabs[visibleTabs.length - 1];
              targetGlobalIndex = lastVisible ? tabs.findIndex((t) => t.id === lastVisible.id) : sourceGlobalIndex;
            }
          }

          if (targetGlobalIndex >= 0 && sourceGlobalIndex !== targetGlobalIndex) {
            onReorderTabs?.(sourceGlobalIndex, targetGlobalIndex);
          }
          // Pulling a tab out of the overflow menu onto the bar is a request to
          // keep it there. Pin it so the post-reorder width recalculation (a
          // long title makes the prefix one tab shorter) cannot collapse it
          // back into "…" — the reported "it returns to the collapsed menu".
          // Dropping any tab into the menu is the opposite request, so the pin
          // is released.
          if (currentTargetArea === 'visible') {
            if (overflowTabs.some((t) => t.id === currentDraggingId)) {
              setPinnedTabId(currentDraggingId);
            }
          } else if (currentTargetArea === 'overflow') {
            setPinnedTabId(null);
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
  }, [visibleTabs, overflowTabs, overflowOpen, tabs, onReorderTabs]);

  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, tab: SessionTabData, visibleIndex: number) => {
      if (e.button !== 0) return; // Only primary button
      if (e.detail > 1) return;   // Ignore multi-clicks (double-click opens rename)
      if (editingTabId === tab.id) return;

      dragStartPosRef.current = { x: e.clientX, y: e.clientY };
      draggingTabIdRef.current = tab.id;
      dropTargetAreaRef.current = 'visible';
      dropIndicatorIndexRef.current = visibleIndex;

      // 记录被按下的 tab 元素，以及鼠标相对该元素左上角的偏移量，
      // 用于拖拽时让标题精准跟随鼠标。
      const el = e.currentTarget as HTMLDivElement;
      draggingElementRef.current = el;
      // 获取用户视觉上看到的内层卡片（如果处于 hover 展开状态，记录展开后的视觉宽度与精准偏移）
      const innerEl = el.querySelector('.session-tab-inner') as HTMLElement | null;
      const visualRect = innerEl ? innerEl.getBoundingClientRect() : el.getBoundingClientRect();
      dragVisualWidthRef.current = visualRect.width;

      dragOffsetRef.current = {
        x: Math.max(0, Math.min(e.clientX - visualRect.left, visualRect.width)),
        y: Math.max(0, Math.min(e.clientY - visualRect.top, visualRect.height)),
      };

      // Enter "may-drag" mode immediately on press — no long-press wait.
      // The actual drag visual starts once the mouse moves beyond a small threshold
      // (see handleGlobalMouseMove), so a plain click still selects the tab cleanly.
      isDraggingActiveRef.current = true;
    },
    [editingTabId]
  );

  const handleOverflowTabMouseDown = useCallback(
    (e: React.MouseEvent, tab: SessionTabData, overflowIndex: number) => {
      if (e.button !== 0) return; // Only primary button
      if (e.detail > 1) return;   // Ignore multi-clicks

      dragStartPosRef.current = { x: e.clientX, y: e.clientY };
      draggingTabIdRef.current = tab.id;
      dropTargetAreaRef.current = 'overflow';
      dropOverflowIndexRef.current = overflowIndex;

      const el = e.currentTarget as HTMLDivElement;
      draggingElementRef.current = el;
      // 获取用户视觉上看到的内层卡片（如果处于 hover 展开状态，记录展开后的视觉宽度与精准偏移）
      const innerEl = el.querySelector('.session-tab-inner') as HTMLElement | null;
      const visualRect = innerEl ? innerEl.getBoundingClientRect() : el.getBoundingClientRect();
      dragVisualWidthRef.current = visualRect.width;

      dragOffsetRef.current = {
        x: Math.max(0, Math.min(e.clientX - visualRect.left, visualRect.width)),
        y: Math.max(0, Math.min(e.clientY - visualRect.top, visualRect.height)),
      };

      isDraggingActiveRef.current = true;
    },
    []
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
          const isBusy = isTabTurnActive(tab);
          const isDragging = tab.id === draggingTabId;
          const hasPendingAction =
            (tab.pendingPermissions?.length ?? 0) > 0 || (tab.pendingQuestions?.length ?? 0) > 0;

          const showDropBefore =
            dropTargetArea === 'visible' && draggingTabId !== null && dropIndicatorIndex === idx;
          const showDropAfter =
            dropTargetArea === 'visible' &&
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
                    if (w > 0) {
                      setTabWidths((prev) => (
                        Math.abs((prev[tab.id] ?? -1) - w) > 0.5 ? { ...prev, [tab.id]: w } : prev
                      ));
                    }
                  } else {
                    if (draggingElementRef.current === el) return;
                    tabElementsRef.current.delete(tab.id);
                  }
                }}
                className={`session-tab-item ${isActive ? 'active' : ''} ${hasPendingAction ? 'has-attention' : ''} ${isDragging ? 'is-dragging' : ''} ${isEditing ? 'is-editing' : ''}`}
                onMouseDown={(e) => handleTabMouseDown(e, tab, idx)}
                onClick={() => {
                  if (justFinishedDragRef.current) return;
                  onSelectTab(tab.id);
                }}
                onContextMenu={(e) => handleContextMenu(e, tab)}
                title={hasPendingAction ? `${tab.title} (${t('common.pendingApproval', { defaultValue: '等待操作' })})` : tab.title}
              >
                <div className="session-tab-inner">
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
                  ...(menuPos.x > window.innerWidth - 280
                    ? { right: `${Math.max(8, window.innerWidth - (menuPos.x + 32))}px`, left: 'auto' }
                    : { left: `${Math.max(8, menuPos.x)}px` }),
                  top: `${menuPos.y}px`,
                  zIndex: 10000,
                  maxWidth: 'calc(100vw - 16px)',
                }}
                role="menu"
              >
                {overflowTabs.map((tab, idx) => {
                  const isActive = tab.id === activeTabId;
                  const isBusy = isTabTurnActive(tab);
                  const isDragging = tab.id === draggingTabId;
                  const hasPendingAction =
                    (tab.pendingPermissions?.length ?? 0) > 0 || (tab.pendingQuestions?.length ?? 0) > 0;

                  const showDropBefore =
                    dropTargetArea === 'overflow' &&
                    draggingTabId !== null &&
                    dropOverflowIndex === idx;
                  const showDropAfter =
                    dropTargetArea === 'overflow' &&
                    draggingTabId !== null &&
                    dropOverflowIndex === overflowTabs.length &&
                    idx === overflowTabs.length - 1;

                  return (
                    <React.Fragment key={tab.id}>
                      {showDropBefore && <div className="session-tab-overflow-drop-indicator" />}
                      <div
                        key={tab.id}
                        ref={(el) => {
                          if (el) {
                            if (draggingElementRef.current === el) return;
                            overflowTabElementsRef.current.set(tab.id, el);
                          } else {
                            if (draggingElementRef.current === el) return;
                            overflowTabElementsRef.current.delete(tab.id);
                          }
                        }}
                        className={`session-tab-overflow-item ${isActive ? 'active' : ''} ${hasPendingAction ? 'has-attention' : ''} ${isDragging ? 'is-dragging' : ''}`}
                        onMouseDown={(e) => handleOverflowTabMouseDown(e, tab, idx)}
                        onClick={() => {
                          if (justFinishedDragRef.current) return;
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
                      {showDropAfter && <div className="session-tab-overflow-drop-indicator" />}
                    </React.Fragment>
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
          tabs={tabs}
          onClose={() => setContextMenu(null)}
          onRename={() => startEditing(contextMenu.tab)}
          onFork={() => onForkTab(contextMenu.tab)}
          onExport={() => onExportTab(contextMenu.tab)}
          onShare={() => onShareTab(contextMenu.tab)}
          onCopyShareLink={() => onCopyShareLinkTab(contextMenu.tab)}
          onUnshare={() => onUnshareTab(contextMenu.tab)}
          onCloseOthers={() => onCloseOtherTabs?.(contextMenu.tab.id)}
          onCloseToLeft={() => onCloseTabsToLeft?.(contextMenu.tab.id)}
          onCloseToRight={() => onCloseTabsToRight?.(contextMenu.tab.id)}
          onCloseAll={() => onCloseAllTabs?.()}
          t={t}
        />
      )}
    </>
  );
};
