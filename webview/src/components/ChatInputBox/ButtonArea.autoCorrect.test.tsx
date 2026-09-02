import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonArea } from './ButtonArea';
import { useCliModels } from '../../hooks/providers/useCliModels';
import type { ModelInfo } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../hooks/providers/useCliModels', () => ({
  useCliModels: vi.fn(),
}));

const mockUseCliModels = vi.mocked(useCliModels);

const CATALOG: ModelInfo[] = [
  { id: 'opencode/gpt-5', label: 'GPT-5' },
  { id: 'opencode/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
];

type CliModelsResult = ReturnType<typeof useCliModels>;

function cliModelsResult(overrides: Partial<CliModelsResult> = {}): CliModelsResult {
  return {
    cliModels: CATALOG,
    cliModelsLoading: false,
    cliModelsError: null,
    cliDefaultModel: null,
    cliCatalogHasEntries: true,
    refreshCliModels: vi.fn(),
    modelsByProvider: {},
    ...overrides,
  } as CliModelsResult;
}

describe('ButtonArea 模型自动纠偏（延迟）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const baseProps = {
    currentProvider: 'opencode',
    selectedModel: 'opencode/claude-sonnet-4-5',
    onModelSelect: vi.fn(),
  };

  it('目录暂时缺失所选模型时不立即切换，目录刷新恢复后取消纠偏', async () => {
    const onModelSelect = vi.fn();
    mockUseCliModels.mockReturnValue(cliModelsResult());

    const { rerender } = render(
      <ButtonArea {...baseProps} onModelSelect={onModelSelect} />,
    );

    // 目录里没有该模型：4 秒内不得切换
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(onModelSelect).not.toHaveBeenCalled();

    // 目录刷新后模型回来了：纠偏被取消
    rerender(
      <ButtonArea
        {...baseProps}
        onModelSelect={onModelSelect}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(onModelSelect).not.toHaveBeenCalled();
  });

  it('模型持续缺失时延迟回退到默认模型', async () => {
    const onModelSelect = vi.fn();
    mockUseCliModels.mockReturnValue(
      cliModelsResult({ cliDefaultModel: 'opencode/gpt-5' }),
    );

    // 选中了一个不在目录中的模型
    render(
      <ButtonArea
        {...baseProps}
        selectedModel="opencode/gone-model"
        onModelSelect={onModelSelect}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(onModelSelect).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(onModelSelect).toHaveBeenCalledTimes(1);
    expect(onModelSelect).toHaveBeenCalledWith('opencode/gpt-5');
  });

  it('静态兜底列表不触发纠偏', async () => {
    const onModelSelect = vi.fn();
    mockUseCliModels.mockReturnValue(
      cliModelsResult({ cliCatalogHasEntries: false }),
    );

    render(
      <ButtonArea
        {...baseProps}
        selectedModel="opencode/gone-model"
        onModelSelect={onModelSelect}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(onModelSelect).not.toHaveBeenCalled();
  });

  it('等待期内用户改选其他模型则不再纠偏旧选择', async () => {
    const onModelSelect = vi.fn();
    mockUseCliModels.mockReturnValue(cliModelsResult());

    const { rerender } = render(
      <ButtonArea
        {...baseProps}
        selectedModel="opencode/gone-model"
        onModelSelect={onModelSelect}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // 用户在窗口期内手动选了目录里的另一个模型
    rerender(
      <ButtonArea
        {...baseProps}
        selectedModel="opencode/gpt-5"
        onModelSelect={onModelSelect}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(onModelSelect).not.toHaveBeenCalled();
  });
});
