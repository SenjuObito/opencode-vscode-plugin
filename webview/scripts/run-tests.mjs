// Runs the vitest suite in directory batches. The main runner process
// accumulates heap across all transformed modules and can OOM on large
// batches, so a failing batch is automatically bisected until it passes.
import { spawnSync } from 'node:child_process';

const GROUPS = [
  ['src/hooks', 'src/utils', 'src/types', 'src/contexts', 'src/i18n'],
  ['src/version'],
  ['src/components/ChatInputBox/selectors', 'src/components/ChatInputBox/Dropdown', 'src/components/ChatInputBox/utils'],
  ['src/components/ChatInputBox/hooks/useAttachmentHandlers.test.ts', 'src/components/ChatInputBox/hooks/useChatInputAttachmentsCoordinator.test.ts', 'src/components/ChatInputBox/hooks/useChatInputCompletionsCoordinator.test.ts'],
  ['src/components/ChatInputBox/hooks/useChatInputImperativeHandle.test.ts', 'src/components/ChatInputBox/hooks/useChatInputSelectionController.test.ts', 'src/components/ChatInputBox/hooks/useCompletionTriggerDetection.test.ts'],
  ['src/components/ChatInputBox/hooks/useCompositionSafeTagRendering.test.ts', 'src/components/ChatInputBox/hooks/useControlledValueSync.test.ts', 'src/components/ChatInputBox/hooks/useFileTags.test.ts'],
  ['src/components/ChatInputBox/hooks/useGlobalCallbacks.test.ts', 'src/components/ChatInputBox/hooks/useInputHistory.test.ts', 'src/components/ChatInputBox/hooks/useKeyboardHandler.test.ts'],
  ['src/components/ChatInputBox/hooks/useNativeEventCapture.test.ts', 'src/components/ChatInputBox/hooks/usePasteAndDrop.test.ts', 'src/components/ChatInputBox/hooks/useResetAttachmentsOnSessionChange.test.ts'],
  ['src/components/ChatInputBox/hooks/useResizableChatInputBox.test.ts', 'src/components/ChatInputBox/hooks/useSpaceKeyListener.test.ts', 'src/components/ChatInputBox/hooks/useSubmitHandler.test.ts'],
  ['src/components/ChatInputBox/hooks/useToolbarSelectorCompact.test.ts', 'src/components/ChatInputBox/hooks/useTriggerDetection.test.ts'],
  ['src/components/ChatInputBox/ButtonArea.autoCorrect.test.tsx', 'src/components/ChatInputBox/ChatInputBoxHeader.test.tsx', 'src/components/ChatInputBox/TokenIndicator.test.tsx'],
  ['src/components/StatusPanel', 'src/components/history', 'src/components/mcp', 'src/components/UsageStatistics'],
  ['src/components/MessageItem', 'src/components/ConversationSearch', 'src/components/toolBlocks'],
  ['src/components/settings'],
  ['src/components/PermissionDialog.test.tsx', 'src/components/PlanApprovalDialog.test.tsx'],
  ['src/components/WelcomeScreen', 'src/components/shared', 'src/components/MessageList/RevertPlaceholderBar.test.tsx'],
  ['src/hooks/providers'],
  ['src/components/AskUserQuestionDialog.test.tsx'],
  ['src/components/ChangelogDialog.test.tsx'],
  ['src/components/CollapsibleTextBlock.test.ts'],
  ['src/components/ContextUsageDialog.test.tsx'],
  ['src/components/MarkdownBlock.test.tsx'],
  ['src/components/MessageAnchorRail.test.ts'],
  ['src/components/MessageList'],
];

function runVitest(args) {
  const res = spawnSync('npx', ['vitest', 'run', ...args,
    '--pool=forks', '--poolOptions.forks.maxForks=1', '--silent=passed-only'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' },
  });
  return res.status === 0;
}

function runBatch(files, depth) {
  if (files.length === 0) {
    return true;
  }
  if (runVitest(files)) {
    return true;
  }
  if (files.length === 1) {
    // Single file: retry once — the runner OOM is environmental, not a real failure.
    console.log('[run-tests] single-file batch failed, retrying once...');
    return runVitest(files);
  }
  if (depth > 3) {
    return false;
  }
  // A batch usually fails due to cumulative runner heap, not the tests
  // themselves — retry in fixed small chunks of 4 files.
  console.log(`[run-tests] batch failed (${files.length} files), retrying in chunks of 4...`);
  for (let i = 0; i < files.length; i += 4) {
    if (!runBatch(files.slice(i, i + 4), depth + 1)) {
      return false;
    }
  }
  return true;
}

let failed = false;
for (const group of GROUPS) {
  if (!runBatch(group, 0)) {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
