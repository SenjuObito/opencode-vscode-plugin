import React, { useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { SessionTabData } from './types';

/**
 * Whether the tab menu offers session sharing.
 *
 * <p>Off because the bundled opencode server (v2.1.4) removed the share
 * endpoint: the request falls through to the SPA route and returns HTTP 405.
 * Flip this back on once the engine exposes sharing again.</p>
 */
const SHARE_MENU_ENABLED = false;

export interface SessionTabContextMenuProps {
  x: number;
  y: number;
  tab: SessionTabData;
  tabs?: SessionTabData[];
  onClose: () => void;
  onRename: () => void;
  onFork: () => void;
  onExport: () => void;
  onShare: () => void;
  onCopyShareLink: () => void;
  onUnshare: () => void;
  onCloseOthers?: () => void;
  onCloseToLeft?: () => void;
  onCloseToRight?: () => void;
  onCloseAll?: () => void;
  t: TFunction;
}

export const SessionTabContextMenu: React.FC<SessionTabContextMenuProps> = ({
  x,
  y,
  tab,
  tabs = [],
  onClose,
  onRename,
  onFork,
  onExport,
  onShare,
  onCopyShareLink,
  onUnshare,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
  onCloseAll,
  t,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Adjust position if close to edge (accommodates 7 menu items plus dividers)
  const adjustedX = Math.min(x, window.innerWidth - 180);
  const adjustedY = Math.min(y, window.innerHeight - 320);

  const currentIndex = tabs.findIndex((t) => t.id === tab.id);
  const disableCloseOthers = tabs.length <= 1;
  const disableCloseToLeft = currentIndex <= 0;
  const disableCloseToRight = currentIndex < 0 || currentIndex >= tabs.length - 1;
  const disableCloseAll = tabs.length === 1 && !tabs[0].sessionId && (tabs[0].messages?.length ?? 0) === 0;

  return (
    <div
      ref={menuRef}
      className="session-context-menu"
      style={{ left: `${adjustedX}px`, top: `${adjustedY}px` }}
      role="menu"
    >
      <button
        className="context-menu-item"
        role="menuitem"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <span className="codicon codicon-edit" />
        <span>{t('chat.renameSession', { defaultValue: '编辑 (Rename)' })}</span>
      </button>

      <button
        className="context-menu-item"
        role="menuitem"
        onClick={() => {
          onClose();
          onFork();
        }}
      >
        <span className="codicon codicon-git-branch" />
        <span>{t('chat.forkSession', { defaultValue: 'Fork 会话' })}</span>
      </button>

      <button
        className="context-menu-item"
        role="menuitem"
        onClick={() => {
          onClose();
          onExport();
        }}
      >
        <span className="codicon codicon-markdown" />
        <span>{t('chat.exportMarkdown', { defaultValue: '导出会话为 Markdown' })}</span>
      </button>

      {/*
       * Session sharing is off: the current opencode server no longer exposes
       * a share endpoint (v2.1.4 removed it), so the entry only produced an
       * HTTP 405. Keep the code and the handlers for the day the engine brings
       * the capability back, but do not offer it in the menu.
       */}
      {SHARE_MENU_ENABLED && (
        <>
          <div className="context-menu-divider" />

          {tab.isShared ? (
            <>
              <button
                className="context-menu-item"
                role="menuitem"
                onClick={() => {
                  onClose();
                  onCopyShareLink();
                }}
              >
                <span className="codicon codicon-copy" />
                <span>{t('chat.copyShareLink', { defaultValue: '复制分享链接' })}</span>
              </button>
              <button
                className="context-menu-item"
                role="menuitem"
                onClick={() => {
                  onClose();
                  onUnshare();
                }}
              >
                <span className="codicon codicon-close" />
                <span>{t('chat.unshareSession', { defaultValue: '关闭分享' })}</span>
              </button>
            </>
          ) : (
            <button
              className="context-menu-item"
              role="menuitem"
              disabled={!tab.sessionId}
              title={!tab.sessionId ? t('chat.shareNeedsSession', { defaultValue: '先发送一条消息，再分享这个会话' }) : undefined}
              onClick={() => {
                onClose();
                onShare();
              }}
            >
              <span className="codicon codicon-share" />
              <span>{t('chat.shareSession', { defaultValue: '分享会话' })}</span>
            </button>
          )}
        </>
      )}

      <div className="context-menu-divider" />

      <button
        className="context-menu-item"
        role="menuitem"
        disabled={disableCloseOthers}
        onClick={() => {
          onClose();
          onCloseOthers?.();
        }}
      >
        <span className="codicon codicon-close-all" />
        <span>{t('chat.closeOtherTabs', { defaultValue: '关闭其他标签页' })}</span>
      </button>

      <button
        className="context-menu-item"
        role="menuitem"
        disabled={disableCloseToRight}
        onClick={() => {
          onClose();
          onCloseToRight?.();
        }}
      >
        <span className="codicon codicon-arrow-right" />
        <span>{t('chat.closeTabsToRight', { defaultValue: '关闭右侧标签页' })}</span>
      </button>

      <button
        className="context-menu-item"
        role="menuitem"
        disabled={disableCloseToLeft}
        onClick={() => {
          onClose();
          onCloseToLeft?.();
        }}
      >
        <span className="codicon codicon-arrow-left" />
        <span>{t('chat.closeTabsToLeft', { defaultValue: '关闭左侧标签页' })}</span>
      </button>

      <button
        className="context-menu-item"
        role="menuitem"
        disabled={disableCloseAll}
        onClick={() => {
          onClose();
          onCloseAll?.();
        }}
      >
        <span className="codicon codicon-clear-all" />
        <span>{t('chat.closeAllTabs', { defaultValue: '关闭所有标签页' })}</span>
      </button>
    </div>
  );
};
