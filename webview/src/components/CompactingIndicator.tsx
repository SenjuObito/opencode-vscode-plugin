import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface CompactingIndicatorProps {
  startTime?: number;
}

export const CompactingIndicator = ({ startTime }: CompactingIndicatorProps) => {
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
        <span className="compact-card__text">{t('chat.compactingSession')}</span>
        <span className="compact-card__dots">{dots}</span>
        <span className="compact-card__time">{formatTime(elapsedSeconds)}</span>
      </div>
    </div>
  );
};

export default CompactingIndicator;
