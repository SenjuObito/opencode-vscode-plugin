import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ModelSelect } from './ModelSelect';
import type { ModelInfo } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.model ?? key,
  }),
}));

describe('ModelSelect', () => {
  const sonnetModel: ModelInfo = {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Sonnet 4.6 · Use the default model',
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it('displays model label from props directly', () => {
    const { rerender } = render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('Sonnet 4.6');

    rerender(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[{ ...sonnetModel, label: 'Sonnet 4.7' }]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('Sonnet 4.7');
  });

  it('falls back to model id when label is not provided', () => {
    render(
      <ModelSelect
        value="claude-fable-5"
        onChange={vi.fn()}
        models={[
          sonnetModel,
          { id: 'claude-fable-5', label: '', description: 'Fable 5' },
        ]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('claude-fable-5');
  });

  it('loading 且模型为空时应显示下拉加载状态', () => {
    render(
      <ModelSelect
        value="opencode-default"
        onChange={vi.fn()}
        models={[]}
        currentProvider="opencode"
        loading
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('model-loading')).toBeTruthy();
    expect(screen.getByText('chat.loadingDropdown')).toBeTruthy();
  });

  it('error 时应显示失败状态并支持点击重试', () => {
    const onRetry = vi.fn();
    render(
      <ModelSelect
        value="auto"
        onChange={vi.fn()}
        models={[
          {
            id: 'auto',
            label: 'PI Auto',
            description: 'Use PI CLI default model',
          },
        ]}
        currentProvider="pi"
        error="pi --list-models failed"
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    const errorRow = screen.getByTestId('model-load-error');
    expect(errorRow).toBeTruthy();
    expect(screen.getByText('chat.modelsLoadFailed')).toBeTruthy();

    fireEvent.click(errorRow);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('loading 时不应同时显示 error 状态', () => {
    render(
      <ModelSelect
        value="auto"
        onChange={vi.fn()}
        models={[]}
        currentProvider="pi"
        loading
        error="timeout"
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('model-loading')).toBeTruthy();
    expect(screen.queryByTestId('model-load-error')).toBeNull();
  });

  const openCodeModels: ModelInfo[] = [
    { id: 'opencode/big-pickle', label: 'opencode/Big-Pickle', description: 'opencode/big-pickle' },
    { id: 'opencode/longcat-2.0-free', label: 'opencode/Longcat-2.0-Free', description: 'opencode/longcat-2.0-free' },
    { id: 'anthropic/claude-sonnet-4', label: 'anthropic/Claude-Sonnet-4', description: 'anthropic/claude-sonnet-4' },
    { id: 'deepseek/deepseek-v4-flash-free', label: 'deepseek/Deepseek-V4-Flash-Free', description: 'deepseek/deepseek-v4-flash-free' },
    { id: 'xiaomi/mimo-v2.5-free', label: 'xiaomi/Mimo-V2.5-Free', description: 'xiaomi/mimo-v2.5-free' },
    { id: 'laguna/laguna-s-2.1-free', label: 'laguna/Laguna-S-2.1-Free', description: 'laguna/laguna-s-2.1-free' },
    { id: 'ling/ling-3.0-tiny-free', label: 'ling/Ling-3.0-Tiny-Free', description: 'ling/ling-3.0-tiny-free' },
    { id: 'nvidia/nemotron-3-ultra-free', label: 'nvidia/Nemotron-3-Ultra-Free', description: 'nvidia/nemotron-3-ultra-free' },
  ];

  it('OpenCode 长列表应显示搜索并按 provider 分组', () => {
    render(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('model-search-input')).toBeTruthy();
    expect(screen.getByTestId('model-group-opencode')).toBeTruthy();
    expect(screen.getByTestId('model-group-anthropic')).toBeTruthy();
    expect(screen.getByTestId('model-group-deepseek')).toBeTruthy();
  });


  it('置顶后模型应出现在 Pinned 分组顶部', () => {
    render(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByTestId('model-pin-deepseek/deepseek-v4-flash-free'));

    expect(screen.getByTestId('model-group-__pinned__')).toBeTruthy();
    const pinnedSection = screen.getByTestId('model-section-__pinned__');
    expect(pinnedSection.textContent).toContain('deepseek/Deepseek-V4-Flash-Free');
  });

  it('点击搜索栏刷新按钮时应触发 onRefresh 并正确切换状态', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const { rerender } = render(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    const refreshBtn = screen.getByTestId('model-refresh-button');
    expect(refreshBtn).toBeTruthy();
    expect(refreshBtn.classList.contains('is-loading')).toBe(false);

    // 点击刷新
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(refreshBtn.classList.contains('is-loading')).toBe(true);

    // 模拟 loading 变为 true
    rerender(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
        onRefresh={onRefresh}
        loading={true}
      />,
    );
    expect(screen.getByTestId('model-refresh-button').classList.contains('is-loading')).toBe(true);

    // 模拟 50ms 后请求成功，loading 变为 false
    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
        onRefresh={onRefresh}
        loading={false}
      />,
    );

    // 此时仍在 minSpin (600ms) 缓冲中
    expect(screen.getByTestId('model-refresh-button').classList.contains('is-loading')).toBe(true);

    // 走完 600ms
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const updatedBtn = screen.getByTestId('model-refresh-button');
    expect(updatedBtn.classList.contains('is-success')).toBe(true);
    expect(updatedBtn.querySelector('.codicon-check')).toBeTruthy();

    // 走完 1200ms success 显示
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(updatedBtn.classList.contains('is-success')).toBe(false);
    expect(updatedBtn.querySelector('.codicon-refresh')).toBeTruthy();

    vi.useRealTimers();
  });

  it('刷新失败时按钮应显示 error 状态', () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const { rerender } = render(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    const refreshBtn = screen.getByTestId('model-refresh-button');

    fireEvent.click(refreshBtn);
    expect(refreshBtn.classList.contains('is-loading')).toBe(true);

    rerender(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
        onRefresh={onRefresh}
        loading={true}
      />,
    );

    // 模拟请求失败
    rerender(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
        onRefresh={onRefresh}
        loading={false}
        error="fetch failed"
      />,
    );

    // 走完 600ms
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const updatedBtn = screen.getByTestId('model-refresh-button');
    expect(updatedBtn.classList.contains('is-error')).toBe(true);
    expect(updatedBtn.querySelector('.codicon-error')).toBeTruthy();

    // 走完 1500ms error 显示
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(updatedBtn.classList.contains('is-error')).toBe(false);
    expect(updatedBtn.querySelector('.codicon-refresh')).toBeTruthy();

    vi.useRealTimers();
  });
});


