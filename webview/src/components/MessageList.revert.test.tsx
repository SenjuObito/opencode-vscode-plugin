import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import type { ClaudeMessage, ClaudeContentBlock } from '../types';
import { MessageList } from './MessageList';

vi.mock('./ContextMenu', () => ({
  ContextMenu: () => null,
}));

vi.mock('../hooks/useContextMenu.js', () => ({
  useContextMenu: () => ({
    visible: false,
    x: 0,
    y: 0,
    savedRange: null,
    selectedText: '',
    open: vi.fn(),
    close: vi.fn(),
  }),
  copySelection: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.revertPlaceholderCount') return `${options?.count} messages undone`;
      return key;
    },
    i18n: { language: 'zh' },
  }),
}));

const getTestText = (m: ClaudeMessage) => (typeof m.content === 'string' ? m.content : '');
const getTestBlocks = (m: ClaudeMessage): ClaudeContentBlock[] => [
  { type: 'text', text: typeof m.content === 'string' ? m.content : '' },
];
const noopFindToolResult = () => undefined;
const getTestMd = (m: ClaudeMessage) => (typeof m.content === 'string' ? m.content : '');
const t = ((k: string, opts?: Record<string, unknown>) => {
  if (k === 'chat.revertPlaceholderCount') return `${opts?.count} messages undone`;
  return k;
}) as never;

describe('MessageList Undo/Redo/Fork Revert Slicing', () => {
  const sampleMessages: ClaudeMessage[] = [
    { id: 'msg_u1', type: 'user', content: 'Turn 1 user question' },
    { id: 'msg_a1', type: 'assistant', content: 'Turn 1 assistant answer' },
    { id: 'msg_u2', type: 'user', content: 'Turn 2 user question to be undone' },
    { id: 'msg_a2', type: 'assistant', content: 'Turn 2 assistant answer to be undone' },
  ];

  it('slices messages at revertBoundaryId and renders RevertPlaceholderBar', () => {
    const onRestore = vi.fn();
    const onUndo = vi.fn();
    const onFork = vi.fn();
    const endRef = createRef<HTMLDivElement>();

    render(
      <MessageList
        messages={sampleMessages}
        messageKeys={['k1', 'k2', 'k3', 'k4']}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        isCompacting={false}
        compactingStartTime={null}
        t={t}
        getMessageText={getTestText}
        getContentBlocks={getTestBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={getTestMd}
        messagesEndRef={endRef}
        revertBoundaryId="msg_u2"
        onRestore={onRestore}
        onUndo={onUndo}
        onFork={onFork}
      />
    );

    // Active messages: Turn 1 should be visible
    expect(screen.getByText('Turn 1 user question')).toBeTruthy();
    expect(screen.getByText('Turn 1 assistant answer')).toBeTruthy();

    // Undone messages: Turn 2 should NOT be in the main list before expanding
    expect(screen.queryByText('Turn 2 user question to be undone')).toBeNull();
    expect(screen.queryByText('Turn 2 assistant answer to be undone')).toBeNull();

    // Revert placeholder bar should be rendered with undone count = 2
    expect(screen.getByTestId('revert-placeholder-bar')).toBeTruthy();
    expect(screen.getByText('2 messages undone')).toBeTruthy();

    // Click Restore button
    fireEvent.click(screen.getByTitle('chat.redoTooltip'));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('expands to show reverted messages with full MessageItem rendering', () => {
    const endRef = createRef<HTMLDivElement>();

    render(
      <MessageList
        messages={sampleMessages}
        messageKeys={['k1', 'k2', 'k3', 'k4']}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        isCompacting={false}
        compactingStartTime={null}
        t={t}
        getMessageText={getTestText}
        getContentBlocks={getTestBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={getTestMd}
        messagesEndRef={endRef}
        revertBoundaryId="msg_u2"
        onRestore={vi.fn()}
      />
    );

    const expandBtn = screen.getByRole('button', { name: 'chat.revertExpand' });
    fireEvent.click(expandBtn);

    // Reverted messages container is rendered
    expect(screen.getByTestId('reverted-messages-container')).toBeTruthy();
    expect(screen.getByText('Turn 2 user question to be undone')).toBeTruthy();
    expect(screen.getByText('Turn 2 assistant answer to be undone')).toBeTruthy();

    // Collapse back
    const collapseBtn = screen.getByRole('button', { name: 'chat.revertCollapse' });
    fireEvent.click(collapseBtn);
    expect(screen.queryByTestId('reverted-messages-container')).toBeNull();
  });

  it('uses fallback heuristics when live messages do not carry exact msg_xxx ID', () => {
    const liveMessages: ClaudeMessage[] = [
      { type: 'user', content: 'Turn 1 user' },
      { type: 'assistant', content: 'Turn 1 assistant' },
      { type: 'user', content: 'Live turn user to be undone' },
      { type: 'assistant', content: 'Live turn assistant' },
    ];
    const endRef = createRef<HTMLDivElement>();

    render(
      <MessageList
        messages={liveMessages}
        messageKeys={['lk1', 'lk2', 'lk3', 'lk4']}
        streamingActive={false}
        isThinking={false}
        loading={false}
        loadingStartTime={null}
        isCompacting={false}
        compactingStartTime={null}
        t={t}
        getMessageText={getTestText}
        getContentBlocks={getTestBlocks}
        findToolResult={noopFindToolResult}
        extractMarkdownContent={getTestMd}
        messagesEndRef={endRef}
        // Passed 'latest' or an unresolvable ID from optimistic revert
        revertBoundaryId="latest"
        onRestore={vi.fn()}
      />
    );

    // Fallback slices from the last human user message
    expect(screen.getByText('Turn 1 user')).toBeTruthy();
    expect(screen.queryByText('Live turn user to be undone')).toBeNull();
    expect(screen.getByText('2 messages undone')).toBeTruthy();
  });
});
