import type { TFunction } from 'i18next';
import type { CodexFastMode, DropdownItemData, DropdownPosition, PermissionMode, ReasoningEffort } from './types.js';
import type { TooltipState } from './hooks/useTooltip.js';
import { ButtonArea } from './ButtonArea.js';
import { CompletionDropdown } from './Dropdown/index.js';

interface CompletionController {
  isOpen: boolean;
  position: DropdownPosition | null;
  items: DropdownItemData[];
  activeIndex: number;
  loading: boolean;
  close: () => void;
  selectIndex: (index: number) => void;
  handleMouseEnter: (index: number) => void;
}

export function ChatInputBoxFooter({
  disabled,
  hasInputContent,
  isLoading,
  selectedModel,
  permissionMode,
  currentProvider,
  reasoningEffort,
  codexFastMode,
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  onReasoningChange,
  onCodexFastModeChange,
  alwaysThinkingEnabled,
  onToggleThinking,
  onAddModel,
  longContextEnabled = true,
  onLongContextChange,
  fileCompletion,
  commandCompletion,
  dollarCommandCompletion,
  tooltip,
  t,
}: {
  disabled: boolean;
  hasInputContent: boolean;
  isLoading: boolean;
  selectedModel: string;
  permissionMode: PermissionMode;
  currentProvider: string;
  reasoningEffort: ReasoningEffort;
  codexFastMode?: CodexFastMode;
  onSubmit: () => void;
  onStop?: () => void;
  onModeSelect?: (mode: PermissionMode) => void;
  onModelSelect?: (modelId: string) => void;
  onProviderSelect?: (providerId: string) => void;
  onReasoningChange?: (effort: ReasoningEffort) => void;
  onCodexFastModeChange?: (mode: CodexFastMode) => void;
  alwaysThinkingEnabled?: boolean;
  onToggleThinking?: (enabled: boolean) => void;
  onAddModel?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  fileCompletion: CompletionController;
  commandCompletion: CompletionController;
  dollarCommandCompletion?: CompletionController;
  tooltip: TooltipState | null;
  t: TFunction;
}) {
  return (
    <>
      {/* Bottom button area */}
      <ButtonArea
        disabled={disabled || isLoading}
        hasInputContent={hasInputContent}
        isLoading={isLoading}
        selectedModel={selectedModel}
        permissionMode={permissionMode}
        currentProvider={currentProvider}
        reasoningEffort={reasoningEffort}
        codexFastMode={codexFastMode}
        onSubmit={onSubmit}
        onStop={onStop}
        onModeSelect={onModeSelect}
        onModelSelect={onModelSelect}
        onProviderSelect={onProviderSelect}
        onReasoningChange={onReasoningChange}
        onCodexFastModeChange={onCodexFastModeChange}
        alwaysThinkingEnabled={alwaysThinkingEnabled}
        onToggleThinking={onToggleThinking}
        onAddModel={onAddModel}
        longContextEnabled={longContextEnabled}
        onLongContextChange={onLongContextChange}
      />

      {/* @ file reference dropdown menu */}
      <CompletionDropdown
        isVisible={fileCompletion.isOpen}
        position={fileCompletion.position}
        items={fileCompletion.items}
        selectedIndex={fileCompletion.activeIndex}
        loading={fileCompletion.loading}
        emptyText={t('chat.noMatchingFiles')}
        onClose={fileCompletion.close}
        onSelect={(_, index) => fileCompletion.selectIndex(index)}
        onMouseEnter={fileCompletion.handleMouseEnter}
      />

      {/* / slash command dropdown menu */}
      <CompletionDropdown
        isVisible={commandCompletion.isOpen}
        position={commandCompletion.position}
        width={450}
        items={commandCompletion.items}
        selectedIndex={commandCompletion.activeIndex}
        loading={commandCompletion.loading}
        emptyText={t('chat.noMatchingCommands')}
        onClose={commandCompletion.close}
        onSelect={(_, index) => commandCompletion.selectIndex(index)}
        onMouseEnter={commandCompletion.handleMouseEnter}
      />


      {/* $ command dropdown menu */}
      {dollarCommandCompletion && (
        <CompletionDropdown
          isVisible={dollarCommandCompletion.isOpen}
          position={dollarCommandCompletion.position}
          width={400}
          items={dollarCommandCompletion.items}
          selectedIndex={dollarCommandCompletion.activeIndex}
          loading={dollarCommandCompletion.loading}
          emptyText={t('chat.noMatchingCommands')}
          onClose={dollarCommandCompletion.close}
          onSelect={(_, index) => dollarCommandCompletion.selectIndex(index)}
          onMouseEnter={dollarCommandCompletion.handleMouseEnter}
        />
      )}

      {/* Floating Tooltip (uses Portal or Fixed positioning to break overflow limit) */}
      {tooltip && tooltip.visible && (() => {
        const tooltipStyle: React.CSSProperties = {
          top: `${tooltip.top}px`,
          left: `${tooltip.left}px`,
          width: tooltip.width ? `${tooltip.width}px` : undefined,
          // @ts-expect-error CSS custom properties
          '--tooltip-tx': tooltip.tx || '-50%',
          '--arrow-left': tooltip.arrowLeft || '50%',
        };
        return (
        <div
          className={`tooltip-popup ${tooltip.isBar ? 'tooltip-bar' : ''}`}
          style={tooltipStyle}
        >
          {tooltip.text}
        </div>
        );
      })()}
    </>
  );
}
