import type { TFunction } from 'i18next';
import type { Attachment, QueuedMessage } from './types.js';
import { AttachmentList } from './AttachmentList.js';
import { ContextBar } from './ContextBar.js';
import { MessageQueue } from './MessageQueue.js';
import { useUIState } from '../../contexts/UIStateContext';
import { copyToClipboard } from '../../utils/copyUtils';
import type { DaemonIssue } from '../../hooks/providers/useUsageTracking';

const GITHUB_REPO_URL = 'https://github.com/SenjuObito/opencode-vscode-plugin';

export function ChatInputBoxHeader({
  daemonStatusLoaded,
  daemonIssue,
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
  daemonIssue?: DaemonIssue | null;
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

  const handleCopyInstallCommand = async () => {
    if (!daemonIssue?.installCmd) return;
    const copied = await copyToClipboard(daemonIssue.installCmd);
    addToast(t(copied ? 'chat.installCommandCopied' : 'chat.installCommandCopyFailed'), copied ? 'success' : 'error');
  };

  // 状态栏三态：启动中（转圈）/ 启动失败（原因 + 安装命令 + 重试）/ 未运行（兜底）。
  const issueTitle = daemonIssue
    ? t(`chat.daemonIssue.${daemonIssue.code}`, { defaultValue: t('chat.daemonNotRunning') })
    : '';

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

      {/* Daemon status bar */}
      {!daemonStatusLoaded && (
        <div className="sdk-warning-bar sdk-loading">
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span className="sdk-warning-text">{t('chat.daemonStatusLoading')}</span>
        </div>
      )}

      {/* Startup failed: show the concrete reason instead of a bare "not running" */}
      {daemonStatusLoaded && !daemonAlive && daemonIssue && (
        <div className="sdk-warning-bar sdk-error">
          <span className="codicon codicon-warning" />
          <div className="sdk-warning-body">
            <span className="sdk-warning-text">{issueTitle}</span>
            {daemonIssue.installCmd && (
              <code className="sdk-install-cmd">{t('chat.daemonIssueInstallCmd', { cmd: daemonIssue.installCmd })}</code>
            )}
            {!!daemonIssue.detail && (
              <span className="sdk-warning-detail" title={daemonIssue.detail}>
                {t('chat.daemonIssueDetail', { detail: daemonIssue.detail })}
              </span>
            )}
          </div>
          <div className="sdk-warning-actions">
            {daemonIssue.installCmd && (
              <button
                className="sdk-install-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleCopyInstallCommand();
                }}
              >
                <span className="codicon codicon-copy" />
                <span>{t('chat.copyInstallCommand')}</span>
              </button>
            )}
            {onRetryDaemonStatus && (
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
        </div>
      )}

      {/* Legacy fallback: status known, daemon down, but host sent no reason */}
      {daemonStatusLoaded && !daemonAlive && !daemonIssue && (
        <div className="sdk-warning-bar">
          <span className="codicon codicon-warning" />
          <span className="sdk-warning-text">{t('chat.daemonNotRunning')}</span>
          {onRetryDaemonStatus && (
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
