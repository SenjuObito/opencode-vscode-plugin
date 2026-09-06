import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getPrimaryAgentsSync, subscribeAgents } from '../providers/agentProvider';
import type { PermissionMode } from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
  overflowX: 'hidden',
};
const MODE_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' };
const MODE_TEXT_STYLE: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
/** 下拉顶部快捷键提示行（⇧+Tab 切换模式）。 */
const MODE_SWITCH_HINT_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '5px 10px',
  fontSize: '11px',
  opacity: 0.65,
  borderBottom: '1px solid rgba(128, 128, 128, 0.25)',
};
const KEY_CAP_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '16px',
  padding: '0 3px',
  border: '1px solid rgba(128, 128, 128, 0.45)',
  borderRadius: '3px',
  fontSize: '10px',
  lineHeight: '14px',
};

function getModeOptionStyle(disabled: boolean): React.CSSProperties {
  return {
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

interface ModeSelectProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  provider?: string;
}

/**
 * ModeSelect - Mode selector component.
 *
 * For opencode the "mode" is the selected primary agent. The list is populated
 * dynamically from `getPrimaryAgentsSync()` (mode==='primary' && !hidden).
 * Until the backend responds we fall back to the built-in build/plan agents.
 */
export const ModeSelect = ({ value, onChange, provider: _provider }: ModeSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, recalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
  });

  // Keep local snapshot in sync with the agent cache without prop drilling.
  const [primaryAgents, setPrimaryAgents] = useState(() => getPrimaryAgentsSync());
  useEffect(() => {
    return subscribeAgents(() => setPrimaryAgents(getPrimaryAgentsSync()));
  }, []);

  const modeOptions = useMemo(() => {
    return primaryAgents.map(agent => {
      const i18nKey = agent.id === 'build' ? 'default' : agent.id;
      return {
        id: agent.id,
        label: agent.name,
        icon: agent.id === 'plan' ? 'codicon-tasklist' : 'codicon-tools',
        tooltip: agent.description || t(`openCodeModes.${i18nKey}.tooltip`),
        description: agent.description || t(`openCodeModes.${i18nKey}.description`),
        disabled: false,
      };
    });
  }, [primaryAgents, t]);

  // Backward compatibility: old persisted value 'default' maps to 'build'.
  const normalizedValue = value === 'default' ? 'build' : value;

  const currentMode = useMemo(() => {
    return modeOptions.find(m => m.id === normalizedValue) || modeOptions[0] || {
      id: normalizedValue,
      label: normalizedValue,
      icon: 'codicon-tools',
      tooltip: '',
      description: '',
    };
  }, [modeOptions, normalizedValue]);

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  /**
   * Select mode
   */
  const handleSelect = useCallback((mode: PermissionMode, disabled?: boolean) => {
    if (disabled) return; // Disabled options cannot be selected
    onChange(mode);
    setIsOpen(false);
  }, [onChange]);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    // Delay adding event listener to prevent immediate trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (isOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  // If the current value disappears from the list (e.g. agent deleted), fall
  // back to the first available primary agent. Only do this once per value
  // change to avoid clobbering the user's selection while the agent cache
  // is still settling.
  const hasAutoCorrectedRef = useRef(false);
  useEffect(() => {
    hasAutoCorrectedRef.current = false;
  }, [value]);
  useEffect(() => {
    if (modeOptions.length === 0 || hasAutoCorrectedRef.current) return;

    const ids = modeOptions.map(m => m.id);
    const candidates = [
      normalizedValue,
      normalizedValue === 'default' ? 'build' : undefined,
      normalizedValue === 'build' ? 'default' : undefined,
    ].filter((id): id is string => typeof id === 'string');

    if (!candidates.some(id => ids.includes(id))) {
      hasAutoCorrectedRef.current = true;
      onChange(modeOptions[0].id);
    }
  }, [modeOptions, normalizedValue, onChange]);

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className={`selector-button${value === 'bypassPermissions' ? ' mode-auto-active' : ''}`}
        onClick={handleToggle}
        title={currentMode.tooltip || `${t('chat.currentMode', { mode: currentMode.label })}`}
      >
        <span className={`codicon ${currentMode.icon}`} />
        <span className="selector-button-text">{currentMode.label}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...DROPDOWN_STYLE, ...positionedStyle }}
        >
          <div style={MODE_SWITCH_HINT_STYLE}>
            <span style={KEY_CAP_STYLE}>⇧</span>
            <span style={KEY_CAP_STYLE}>Tab</span>
            <span>{t('modes.switchHint')}</span>
          </div>
          {modeOptions.map((mode) => (
            <div
              key={mode.id}
              data-testid={`mode-option-${mode.id}`}
              className={`selector-option ${mode.id === normalizedValue ? 'selected' : ''} ${mode.disabled ? 'disabled' : ''}`}
              onClick={() => handleSelect(mode.id, mode.disabled)}
              title={mode.tooltip}
              style={getModeOptionStyle(!!mode.disabled)}
            >
              <span className={`codicon ${mode.icon}`} />
              <div style={MODE_INFO_STYLE}>
                <span style={MODE_TEXT_STYLE}>{mode.label}</span>
                <span className="mode-description" style={MODE_TEXT_STYLE}>{mode.description}</span>
              </div>
              {mode.id === normalizedValue && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModeSelect;
