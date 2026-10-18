import React from 'react';
import type { TFunction } from 'i18next';
import { BackIcon } from '../Icons';
import type { SessionTabData } from './types';
import { SessionTabBar } from './SessionTabBar';

export interface ChatHeaderProps {
  currentView: 'chat' | 'history' | 'settings';
  t: TFunction;
  tabs: SessionTabData[];
  activeTabId: string;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, newTitle: string) => void;
  onForkTab: (tab: SessionTabData) => void;
  onExportTab?: (tab: SessionTabData) => void;
  onShareTab: (tab: SessionTabData) => void;
  onCopyShareLinkTab: (tab: SessionTabData) => void;
  onUnshareTab: (tab: SessionTabData) => void;
  onReorderTabs?: (sourceIndex: number, targetIndex: number) => void;
  onBack: () => void;
  onNewSession: () => void;
  onHistory: () => void;
  onSettings: () => void;
  onOpenSearch?: () => void;
}

export function ChatHeader({
  currentView,
  t,
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
  onBack,
  onNewSession,
  onHistory,
  onSettings,
  onOpenSearch,
}: ChatHeaderProps): React.ReactElement | null {

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
        ) : (
          <SessionTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={onSelectTab}
            onCloseTab={onCloseTab}
            onRenameTab={onRenameTab}
            onForkTab={onForkTab}
            onExportTab={onExportTab ?? (() => {})}
            onShareTab={onShareTab}
            onCopyShareLinkTab={onCopyShareLinkTab}
            onUnshareTab={onUnshareTab}
            onReorderTabs={onReorderTabs}
            t={t}
          />
        )}
      </div>

      <div className="header-right">
        {currentView === 'chat' && (
          <>
            <button
              className="icon-button"
              onClick={onNewSession}
              data-tooltip={t('common.newSession', { defaultValue: 'New Chat' })}
              aria-label={t('common.newSession', { defaultValue: 'New Chat' })}
            >
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
              data-tooltip={t('common.history', { defaultValue: 'History' })}
              aria-label={t('common.history', { defaultValue: 'History' })}
            >
              <span className="codicon codicon-history" />
            </button>

            <button
              className="icon-button"
              onClick={onSettings}
              data-tooltip={t('common.settings', { defaultValue: 'Settings' })}
              aria-label={t('common.settings', { defaultValue: 'Settings' })}
            >
              <span className="codicon codicon-settings-gear" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
