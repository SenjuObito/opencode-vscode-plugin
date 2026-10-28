import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeSelect } from './ModeSelect';
import { __resetAgentStoreForTests, handleAgentsUpdated } from '../../../store/agentStore';

// 只替换 useTranslation；`initReactI18next` 等导出必须保留，否则 i18n/config 初始化会炸。
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    }),
  };
});

describe('ModeSelect（宿主目录驱动）', () => {
  beforeEach(() => {
    __resetAgentStoreForTests();
  });

  it('未收到推送时回退到内置 build/plan', () => {
    render(<ModeSelect value="build" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('mode-option-build')).toBeTruthy();
    expect(screen.getByTestId('mode-option-plan')).toBeTruthy();
  });

  it('收到 agents.updated 后渲染宿主目录里的自定义主代理', () => {
    // 宿主推送的是裸数组（`agents.updated` 的 data 字段）
    handleAgentsUpdated(JSON.stringify([
      { id: 'build', name: 'Build', mode: 'primary' },
      { id: 'plan', name: 'Plan', mode: 'primary' },
      { id: 'reviewer', name: 'Reviewer', description: '只读审查', mode: 'primary', color: '#3b9eff' },
      { id: 'general', name: 'General', mode: 'subagent' },
    ]));

    render(<ModeSelect value="build" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('mode-option-reviewer')).toBeTruthy();
    // 子代理不进模式列表
    expect(screen.queryByTestId('mode-option-general')).toBeNull();
  });

  it('选中自定义模式时回调它的 id（不是伪造的枚举值）', () => {
    const onChange = vi.fn();
    handleAgentsUpdated(JSON.stringify([
      { id: 'build', name: 'Build', mode: 'primary' },
      { id: 'reviewer', name: 'Reviewer', mode: 'primary' },
    ]));

    render(<ModeSelect value="build" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByTestId('mode-option-reviewer'));

    expect(onChange).toHaveBeenCalledWith('reviewer');
  });

  it('目录里没有当前模式时回落到第一个主代理', () => {
    const onChange = vi.fn();
    handleAgentsUpdated(JSON.stringify([
      { id: 'build', name: 'Build', mode: 'primary' },
      { id: 'reviewer', name: 'Reviewer', mode: 'primary' },
    ]));

    render(<ModeSelect value="ghost-mode" onChange={onChange} />);

    expect(onChange).toHaveBeenCalledWith('build');
  });
});
