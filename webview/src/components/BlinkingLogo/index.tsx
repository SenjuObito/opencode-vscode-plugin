import { useEffect, useState } from 'react';
import styles from './style.module.less';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';

const ROOT_STYLE: React.CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'center',
};

interface BlinkingLogoProps {
  /** Runtime CLI provider id (claude / codex / opencode / …). Icon follows CLI, not model. */
  provider: string;
}

export const BlinkingLogo = ({ provider }: BlinkingLogoProps) => {
  const [displayProvider, setDisplayProvider] = useState(provider);
  const [animationState, setAnimationState] = useState<'idle' | 'closing' | 'opening'>('idle');

  useEffect(() => {
    if (provider !== displayProvider) {
      if (animationState === 'idle') {
        setAnimationState('closing');
      } else if (animationState === 'opening') {
         setAnimationState('closing');
      }
    }
  }, [provider, displayProvider, animationState]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    if (animationState === 'closing') {
      timer = setTimeout(() => {
        setDisplayProvider(provider);
        setAnimationState('opening');
      }, 200);
    } else if (animationState === 'opening') {
      timer = setTimeout(() => {
        setAnimationState('idle');
      }, 200);
    }

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [animationState, provider]);

  return (
    <div style={ROOT_STYLE}>
      <div className={`${styles.container} ${styles[animationState]}`}>
        <ProviderModelIcon
          providerId={displayProvider}
          size={displayProvider === 'codex' ? 64 : 58}
          colored
        />
      </div>
    </div>
  );
};
