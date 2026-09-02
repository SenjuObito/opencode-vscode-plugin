import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  REASONING_LEVELS,
  EFFORT_SUPPORTED_CLAUDE_MODELS,
  getAvailableReasoningLevels,
  type ReasoningEffort,
} from '../types';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { controlKeySymbol } from '../../../utils/platform';

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
const LEVEL_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1 };

/** 下拉顶部的快捷键提示行（非可点选项）。 */
const CYCLE_HINT_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '5px 10px',
  opacity: 0.65,
  cursor: 'default',
  borderBottom: '1px solid var(--dropdown-border, rgba(128,128,128,0.25))',
};

const KBD_BADGE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '16px',
  padding: '0 3px',
  border: '1px solid var(--dropdown-border, rgba(128,128,128,0.4))',
  borderRadius: 3,
  fontSize: 10,
  lineHeight: '14px',
  fontFamily: 'inherit',
};

interface ReasoningSelectProps {
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  disabled?: boolean;
  selectedModel?: string;
  currentProvider?: string;
  /** 所选模型的 opencode variants（推理力度档位），来自动态模型目录。 */
  modelVariants?: string[];
}

/**
 * ReasoningSelect - Reasoning Effort Selector
 * Controls the depth of reasoning for AI models.
 * Visibility and available levels depend on the selected model:
 * - Codex GPT-5.6: low/medium/high/xhigh/max; other Codex models: up to xhigh
 * - Claude Opus 5 and Opus 4.8: low/medium/high/xhigh/max
 * - Claude Sonnet 5, Sonnet 4.7, Opus 4.6, and Sonnet 4.6: low/medium/high/max
 * - Claude Haiku 4.5 and legacy models: hidden (no adaptive thinking support)
 */
export const ReasoningSelect = ({ value, onChange, disabled, selectedModel, currentProvider, modelVariants }: ReasoningSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, recalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
  });

  // Determine visibility: for Claude, hide if model doesn't support adaptive thinking.
  // opencode：variants 已知时按档位有无判断（空列表视为不支持，隐藏选择器）。
  const isVisible = modelVariants && modelVariants.length > 0
    ? getAvailableReasoningLevels(currentProvider, selectedModel, modelVariants).length > 0
    : currentProvider !== 'claude' || !selectedModel || EFFORT_SUPPORTED_CLAUDE_MODELS.has(selectedModel);

  // Build the list of available levels for the current model.
  // opencode：按所选模型的 variants 动态取档；其他 provider 回退静态规则。
  const availableLevels = getAvailableReasoningLevels(currentProvider, selectedModel, modelVariants);

  const currentLevel = availableLevels.find(l => l.id === value) || availableLevels[availableLevels.length - 2] || availableLevels[0];

  useEffect(() => {
    if (!isVisible || availableLevels.some(level => level.id === value)) {
      return;
    }
    if (currentLevel) {
      onChange(currentLevel.id);
    }
  }, [availableLevels, currentLevel, isVisible, onChange, value]);

  /**
   * Get translated text for reasoning level
   */
  const getReasoningText = (levelId: ReasoningEffort, field: 'label' | 'description') => {
    const key = `reasoning.${levelId}.${field}`;
    const fallback = REASONING_LEVELS.find(l => l.id === levelId)?.[field] || levelId;
    return t(key, { defaultValue: fallback });
  };

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, disabled, recalculate]);

  /**
   * Select reasoning level
   */
  const handleSelect = useCallback((effort: ReasoningEffort) => {
    onChange(effort);
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

  if (!isVisible) return null;

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        disabled={disabled}
        title={t('reasoning.title', { defaultValue: 'Select reasoning depth' })}
      >
        <span className="codicon codicon-lightbulb" />
        <span className="selector-button-text">{getReasoningText(currentLevel.id, 'label')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...DROPDOWN_STYLE, ...positionedStyle }}
        >
          {/* Ctrl+T 切换力度（对齐 opencode TUI variant_cycle 键位） */}
          <div
            className="selector-option reasoning-cycle-hint"
            data-testid="reasoning-cycle-hint"
            style={CYCLE_HINT_STYLE}
          >
            <span style={KBD_BADGE_STYLE}>{controlKeySymbol()}</span>
            <span style={KBD_BADGE_STYLE}>T</span>
            <span>{t('reasoning.cycleHint', { defaultValue: 'Cycle reasoning effort' })}</span>
          </div>

          {availableLevels.map((level) => (
            <div
              key={level.id}
              className={`selector-option ${level.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(level.id)}
              title={getReasoningText(level.id, 'description')}
            >
              <span className={`codicon ${level.icon}`} />
              <div style={LEVEL_INFO_STYLE}>
                <span>{getReasoningText(level.id, 'label')}</span>
                <span className="mode-description">{getReasoningText(level.id, 'description')}</span>
              </div>
              {level.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ReasoningSelect;
