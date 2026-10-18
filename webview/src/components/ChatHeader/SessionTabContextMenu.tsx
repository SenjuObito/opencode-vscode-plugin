import React, { useEffect, useRef } from 'react';
import type { TFunction } from 'i18next';
import type { SessionTabData } from './types';

export interface SessionTabContextMenuProps {
  x: number;
  y: number;
  tab: SessionTabData;
  onClose: () => void;
  onRename: () => void;
  onFork: () => void;
  onExport: () => void;
  onShare: () => void;
  onCopyShareLink: () => void;
  onUnshare: () => void;
  t: TFunction;
}

export const SessionTabContextMenu: React.FC<SessionTabContextMenuProps> = ({
  x,
  y,
  tab,
  onClose,
  onRename,
  onFork,
  onExport,
  onShare,
  onCopyShareLink,
  onUnshare,
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

  // Adjust position if close to edge
  const adjustedX = Math.min(x, window.innerWidth - 180);
  const adjustedY = Math.min(y, window.innerHeight - 150);

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
          onClick={() => {
            onClose();
            onShare();
          }}
        >
          <span className="codicon codicon-share" />
          <span>{t('chat.shareSession', { defaultValue: '分享会话' })}</span>
        </button>
      )}
    </div>
  );
};
