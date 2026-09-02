import { memo } from 'react';
import type { TFunction } from 'i18next';

import { BlinkingLogo } from '../BlinkingLogo';
import { AnimatedText } from '../AnimatedText';

const ROOT_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: '#555',
  gap: '16px',
};

const LOGO_WRAPPER_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };

export interface WelcomeScreenProps {
  /** Runtime CLI provider (opencode); welcome logo follows the CLI */
  currentProvider: string;
  t: TFunction;
  /** 点击 welcome 页的 provider 标识时切换供应商 */
  onProviderChange?: (providerId: string) => void;
}

export const WelcomeScreen = memo(function WelcomeScreen({
  currentProvider,
  t,
}: WelcomeScreenProps): React.ReactElement {
  // opencode-only: the claude / codex / grok / kimi / pi labels were removed.
  const providerLabels: Record<string, string> = {
    opencode: t('providers.opencode.label'),
  };

  return (
    <div style={ROOT_STYLE}>
      <div style={LOGO_WRAPPER_STYLE}>
        <BlinkingLogo provider={currentProvider} />
      </div>
      <div>
        <AnimatedText text={t('chat.sendMessage', { provider: providerLabels[currentProvider] ?? currentProvider })} />
      </div>
    </div>
  );
});
