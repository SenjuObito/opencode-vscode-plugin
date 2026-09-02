import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { BackIcon } from '../Icons';

export interface ChatHeaderProps {
  currentView: 'chat' | 'history' | 'settings';
  sessionTitle: string;
  t: TFunction;
  onBack: () => void;
  onNewSession: () => void;
  onHistory: () => void;
  onSettings: () => void;
  /**
   * Opens the in-conversation search panel. Only rendered when provided.
   * Wired up by App.tsx via UIStateContext.setSearchOpen.
   */
  onOpenSearch?: () => void;
  onTitleChange?: (newTitle: string) => void;
  titleEditable?: boolean;
  /** Whether the session is currently shared */
  isShared?: boolean;
  /** Whether a share request is in flight (spinner state) */
  sharePending?: boolean;
  /** Hide the share controls entirely (e.g. "share": "disabled" in opencode.json) */
  shareHidden?: boolean;
  /** Copy the existing share link to the clipboard */
  onCopyShareLink?: () => void;
  /** Callback to share the session */
  onShare?: () => void;
  /** Callback to unshare the session */
  onUnshare?: () => void;
  /** Fork the entire conversation into a new session */
  onForkAll?: () => void;
}

export function ChatHeader({
  currentView,
  sessionTitle,
  t,
  onBack,
  onNewSession,
  onHistory,
  onSettings,
  onOpenSearch,
  onTitleChange,
  titleEditable = false,
  isShared = false,
  sharePending = false,
  shareHidden = false,
  onCopyShareLink,
  onShare,
  onUnshare,
  onForkAll,
}: ChatHeaderProps): React.ReactElement | null {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!titleEditable) {
      setEditing(false);
    }
  }, [titleEditable]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    if (!titleEditable || !onTitleChange) return;
    setEditValue(sessionTitle);
    setEditing(true);
  }, [titleEditable, onTitleChange, sessionTitle]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim().slice(0, 50);
    if (trimmed && trimmed !== sessionTitle && onTitleChange) {
      onTitleChange(trimmed);
    }
  }, [editValue, sessionTitle, onTitleChange]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }, [commitEdit, cancelEdit]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    // If focus moves to save/cancel button inside edit container, let that button handle it
    const editContainer = e.currentTarget.closest('.session-title-edit-mode');
    if (editContainer && editContainer.contains(e.relatedTarget as Node)) {
      return;
    }
    commitEdit();
  }, [commitEdit]);

  if (currentView === 'settings') {
    return null;
  }

  return (
    <div className="header">
      <div className="header-left">
        {currentView === 'history' ? (
          <button className="back-button" onClick={onBack} data-tooltip={t('common.back')}>
            <BackIcon /> {t('common.back')}
          </button>
        ) : editing ? (
          <div className="session-title-edit-mode" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              type="text"
              className="session-title-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              maxLength={50}
              spellCheck={false}
              aria-label="Session title"
            />
            <button className="session-title-save-btn" onClick={commitEdit} aria-label="Save title">
              <span className="codicon codicon-check" />
            </button>
            <button className="session-title-cancel-btn" onClick={cancelEdit} aria-label="Cancel editing">
              <span className="codicon codicon-close" />
            </button>
          </div>
        ) : (
          <div className="session-title-wrapper">
            <div className="session-title">
              {sessionTitle}
            </div>
            {titleEditable && (
              <button className="session-title-edit-btn" onClick={startEditing} aria-label="Edit session title">
                <span className="codicon codicon-edit" />
              </button>
            )}
            {currentView === 'chat' && onForkAll && (
              <button
                className="session-title-share-btn"
                onClick={onForkAll}
                title={t('chat.forkAllTooltip')}
                aria-label={t('chat.forkAllTooltip')}
              >
                <span className="codicon codicon-git-branch" />
              </button>
            )}
            {currentView === 'chat' && onShare && onUnshare && !shareHidden && (
              sharePending ? (
                <button
                  className="session-title-share-btn pending"
                  disabled
                  title={t('chat.sharePendingTooltip')}
                  aria-label={t('chat.sharePendingTooltip')}
                >
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                </button>
              ) : isShared ? (
                <>
                  <button
                    className="session-title-share-btn shared"
                    onClick={onCopyShareLink}
                    title={t('chat.copyShareLinkTooltip')}
                    aria-label={t('chat.copyShareLinkTooltip')}
                  >
                    <span className="codicon codicon-copy" />
                  </button>
                  <button
                    className="session-title-share-btn shared"
                    onClick={onUnshare}
                    title={t('chat.unshareTooltip')}
                    aria-label={t('chat.unshareTooltip')}
                  >
                    <span className="codicon codicon-close" />
                  </button>
                </>
              ) : (
                <button
                  className="session-title-share-btn"
                  onClick={onShare}
                  title={t('chat.shareTooltip')}
                  aria-label={t('chat.shareTooltip')}
                >
                  <span className="codicon codicon-share" />
                </button>
              )
            )}
          </div>
        )}
      </div>
      <div className="header-right">
        {currentView === 'chat' && (
          <>
            <button className="icon-button" onClick={onNewSession} data-tooltip={t('common.newSession')}>
              <span className="codicon codicon-plus" />
            </button>
            {onOpenSearch && (
              <button
                className="icon-button"
                onClick={onOpenSearch}
                data-tooltip={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
                aria-label={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
              >
                <span className="codicon codicon-search" />
              </button>
            )}
            <button
              className="icon-button"
              onClick={onHistory}
              data-tooltip={t('common.history')}
            >
              <span className="codicon codicon-history" />
            </button>
            <button
              className="icon-button"
              onClick={onSettings}
              data-tooltip={t('common.settings')}
            >
              <span className="codicon codicon-settings-gear" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
