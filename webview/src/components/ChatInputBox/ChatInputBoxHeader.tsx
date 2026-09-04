import type { TFunction } from 'i18next';
import type { Attachment, QueuedMessage } from './types.js';
import { AttachmentList } from './AttachmentList.js';
import { ContextBar } from './ContextBar.js';
import { MessageQueue } from './MessageQueue.js';
import { useUIState } from '../../contexts/UIStateContext';
import { copyToClipboard } from '../../utils/copyUtils';

const GITHUB_REPO_URL = 'https://github.com/SenjuObito/opencode-vscode-plugin';

export function ChatInputBoxHeader({
  daemonStatusLoaded,
  daemonAlive,
  onRetryDaemonStatus,
  t,
  attachments,
  onRemoveAttachment,
  activeFile,
  selectedLines,
  usagePercentage,
  usageUsedTokens,
  usageMaxTokens,
  showUsage,
  onClearContext,
  onAddAttachment,
  statusPanelExpanded,
  onToggleStatusPanel,
  messageQueue,
  onRemoveFromQueue,
  showOpenSourceBanner,
  onDismissOpenSourceBanner,
  autoOpenFileEnabled,
  onRequestEnableFileContext,
  onCompactClick,
  sessionLoading,
}: {
  daemonStatusLoaded: boolean;
  daemonAlive: boolean;
  onRetryDaemonStatus?: () => void;
  t: TFunction;
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  activeFile?: string;
  selectedLines?: string;
  usagePercentage: number;
  usageUsedTokens?: number;
  usageMaxTokens?: number;
  showUsage: boolean;
  onClearContext?: () => void;
  onAddAttachment: (files: FileList) => void;
  statusPanelExpanded: boolean;
  onToggleStatusPanel?: () => void;
  messageQueue?: QueuedMessage[];
  onRemoveFromQueue?: (id: string) => void;
  showOpenSourceBanner?: boolean;
  onDismissOpenSourceBanner?: () => void;
  autoOpenFileEnabled?: boolean;
  onRequestEnableFileContext?: () => void;
  onCompactClick?: () => void;
  sessionLoading?: boolean;
}) {
  const { addToast } = useUIState();

  const handleStarProject = async () => {
    const copied = await copyToClipboard(GITHUB_REPO_URL);
    if (copied) {
      addToast(t('chat.openSourceBannerStarToast'), 'success');
    }
  };

  return (
    <>
      {/* Open source banner */}
      {showOpenSourceBanner && (
        <div className="open-source-banner">
          <span className="banner-text">{t('chat.openSourceBanner')}</span>
          <button
            type="button"
            className="banner-star"
            aria-label={t('chat.openSourceBannerStarAria')}
            onClick={(e) => {
              e.stopPropagation();
              handleStarProject();
            }}
          >
            <svg className="star-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
            </svg>
            <span className="banner-star-text">{t('chat.openSourceBannerStar')}</span>
          </button>
          <button
            className="banner-close"
            aria-label="Close"
            onClick={(e) => {
              e.stopPropagation();
              onDismissOpenSourceBanner?.();
            }}
          >
            &#x2715;
          </button>
        </div>
      )}

      {/* Daemon status warning bar */}
      {(!daemonStatusLoaded || !daemonAlive) && (
        <div className={`sdk-warning-bar ${!daemonStatusLoaded ? 'sdk-loading' : ''}`}>
          <span
            className={`codicon ${!daemonStatusLoaded ? 'codicon-loading codicon-modifier-spin' : 'codicon-warning'}`}
          />
          <span className="sdk-warning-text">
            {!daemonStatusLoaded
              ? t('chat.daemonStatusLoading')
              : t('chat.daemonNotRunning')}
          </span>
          {daemonStatusLoaded && !daemonAlive && onRetryDaemonStatus && (
            <button
              className="sdk-install-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRetryDaemonStatus();
              }}
            >
              <span className="codicon codicon-refresh" />
              <span>{t('chat.retryDaemonStatus')}</span>
            </button>
          )}
        </div>
      )}

      {/* Session loading bar */}
      {sessionLoading && (
        <div className="session-loading-bar">
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span className="session-loading-text">{t('statusPanel.loadingSession')}</span>
        </div>
      )}

      {/* Message queue */}
      {messageQueue && messageQueue.length > 0 && (
        <MessageQueue
          queue={messageQueue}
          onRemove={onRemoveFromQueue ?? (() => {})}
        />
      )}

      {/* Attachment list */}
      {attachments.length > 0 && (
        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />
      )}

      {/* Context bar (Top Control Bar) */}
      <ContextBar
        activeFile={activeFile}
        selectedLines={selectedLines}
        percentage={usagePercentage}
        usedTokens={usageUsedTokens}
        maxTokens={usageMaxTokens}
        showUsage={showUsage}
        onClearFile={onClearContext}
        onAddAttachment={onAddAttachment}
        statusPanelExpanded={statusPanelExpanded}
        onToggleStatusPanel={onToggleStatusPanel}
        autoOpenFileEnabled={autoOpenFileEnabled}
        onRequestEnableFileContext={onRequestEnableFileContext}
        onCompactClick={onCompactClick}
      />
    </>
  );
}
