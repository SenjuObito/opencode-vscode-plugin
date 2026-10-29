/**
 * EngineBlockedNotice — daemon 引擎不可用时的提示条。
 *
 * <p>这是 VS Code 宿主独有的状态（常驻 daemon + `opencode serve` 的启动/探测
 * 结果），IDEA 侧没有等价物。它此前被塞进 `StatusNoticeBar` 里，与「额度 /
 * 重试」共用同一个组件，导致那个组件无法与 idea 保持同一份实现 —— 额度条的
 * 显隐判定、dismiss 语义、上下文兜底全都跟着分叉。这里把它独立出来：
 * `StatusNoticeBar` 只负责额度与错误提示，引擎阻断由本组件负责。</p>
 */
import { useTranslation } from 'react-i18next';
import type { DaemonEngineStatus } from '../hooks/providers/useUsageTracking';
import './StatusNoticeBar.less';

export interface EngineBlockedNoticeProps {
  engine?: DaemonEngineStatus | null;
  onRetry?: () => void;
}

export const EngineBlockedNotice = ({ engine = null, onRetry }: EngineBlockedNoticeProps) => {
  const { t } = useTranslation();

  if (!engine) {
    return null;
  }
  const blocked = engine.blocking === true || engine.state === 'unknown';
  if (!blocked) {
    return null;
  }

  const meta = [engine.cliVersion, engine.cliSource, engine.apiVersion ? `API ${engine.apiVersion}` : null]
    .filter((part): part is string => !!part && String(part).trim().length > 0);

  return (
    <div className="status-notice-bar status-notice-bar--error" role="alert" aria-live="polite">
      <span className="codicon codicon-debug-disconnect status-notice-icon" />
      <div className="status-notice-body">
        <span className="status-notice-title">{t('engineNotice.title')}</span>
        <span className="status-notice-message">
          {engine.reasonMessage?.trim() || t('engineNotice.message')}
        </span>
        {meta.length > 0 && <span className="status-notice-meta">{meta.join(' · ')}</span>}
      </div>
      {onRetry && (
        <button type="button" className="status-notice-action" onClick={onRetry}>
          {t('engineNotice.retry')}
        </button>
      )}
    </div>
  );
};

export default EngineBlockedNotice;
