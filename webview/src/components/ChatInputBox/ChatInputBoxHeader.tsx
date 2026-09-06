import type { TFunction } from 'i18next';
import type { Attachment, QueuedMessage } from './types.js';
import { AttachmentList } from './AttachmentList.js';
import { ContextBar } from './ContextBar.js';
import { MessageQueue } from './MessageQueue.js';
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
  autoOpenFileEnabled?: boolean;
  onRequestEnableFileContext?: () => void;
  onCompactClick?: () => void;
  sessionLoading?: boolean;
}) {
  return (
    <>
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
