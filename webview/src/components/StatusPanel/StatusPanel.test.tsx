import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StatusPanel from './StatusPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('StatusPanel', () => {
  it.each([
    ['claude', 'statusPanel.tasksTab'],
  ])('uses the provider-specific todo label for %s', (currentProvider, expectedLabel) => {
    render(
      <StatusPanel
        todos={[]}
        fileChanges={[]}
        subagents={[]}
        currentProvider={currentProvider}
      />,
    );

    expect(screen.getByText(expectedLabel)).toBeTruthy();
  });

  it('受控模式下子页由外部状态决定，并回调变更', () => {
    const onActiveTabChange = vi.fn();
    const { rerender } = render(
      <StatusPanel
        todos={[{ content: 'todo one', status: 'pending' } as never]}
        fileChanges={[]}
        subagents={[]}
        currentProvider="opencode"
        expanded
        activeTab={null}
        onActiveTabChange={onActiveTabChange}
      />,
    );

    // 受控为 null：点任务页只上报，不自作主张切换
    fireEvent.click(screen.getByText('statusPanel.tasksTab'));
    expect(onActiveTabChange).toHaveBeenCalledWith('todo');
    expect(screen.queryByText('todo one')).toBeNull();

    // 外部把状态改成 todo 后才真正展开
    rerender(
      <StatusPanel
        todos={[{ content: 'todo one', status: 'pending' } as never]}
        fileChanges={[]}
        subagents={[]}
        currentProvider="opencode"
        expanded
        activeTab="todo"
        onActiveTabChange={onActiveTabChange}
      />,
    );
    expect(screen.getByText('todo one')).toBeTruthy();
  });

  it('切到另一个 tab 的子页状态直接生效（每个 tab 各自记住）', () => {
    const todos = [{ content: 'todo one', status: 'pending' } as never];
    const { rerender } = render(
      <StatusPanel
        todos={todos}
        fileChanges={[]}
        subagents={[]}
        currentProvider="opencode"
        expanded
        activeTab="todo"
      />,
    );
    expect(screen.getByText('todo one')).toBeTruthy();

    // 另一个 tab 没有打开任何子页
    rerender(
      <StatusPanel
        todos={todos}
        fileChanges={[]}
        subagents={[]}
        currentProvider="opencode"
        expanded
        activeTab={null}
      />,
    );
    expect(screen.queryByText('todo one')).toBeNull();
  });
});
