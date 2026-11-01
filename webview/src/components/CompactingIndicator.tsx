import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface CompactingIndicatorProps {
  startTime?: number;
  /**
   * `manual` for a user-issued /compact, `auto` for the engine's own
   * context-window compaction. The wording differs; the card does not.
   */
  reason?: 'manual' | 'auto';
}

export const CompactingIndicator = ({ startTime, reason = 'auto' }: CompactingIndicatorProps) => {
  const { t } = useTranslation();
  const [dotCount, setDotCount] = useState(1);
  const [elapsedSeconds, setElapsedSeconds] = useState(() => {
    if (startTime) {
      return Math.floor((Date.now() - startTime) / 1000);
    }
    return 0;
  });

  useEffect(() => {
    const timer = setInterval(() => {
      setDotCount(prev => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (startTime) {
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      } else {
        setElapsedSeconds(prev => prev + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  const dots = '.'.repeat(dotCount);

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  };

  return (
    <div className="compact-card-wrapper compact-card-wrapper--indicator">
      <div className="compact-card compact-card--compacting">
        <div className="compact-card__spinner-dual">
          <div className="compact-card__spinner-outer" />
          <div className="compact-card__spinner-inner" />
        </div>
        <span className="compact-card__text">
          {reason === 'manual'
            ? t('chat.compactingSession')
            : t('chat.autoCompactingSession', 'Auto-compacting conversation tokens')}
          <span className="compact-card__dots">{dots}</span>
        </span>
        <span className="compact-card__time-badge">{formatTime(elapsedSeconds)}</span>
      </div>
    </div>
  );
};

export default CompactingIndicator;
