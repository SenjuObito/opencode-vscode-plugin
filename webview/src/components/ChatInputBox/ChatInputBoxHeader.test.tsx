import type { ComponentProps } from 'react';
import { render, screen } from '@testing-library/react';
import { ChatInputBoxHeader } from './ChatInputBoxHeader';

vi.mock('../../contexts/UIStateContext', () => ({
  useUIState: () => ({ addToast: vi.fn() }),
}));

const createProps = (): ComponentProps<typeof ChatInputBoxHeader> => ({
  t: ((key: string) => key) as never,
  attachments: [],
  onRemoveAttachment: vi.fn(),
  usagePercentage: 0,
  showUsage: false,
  onAddAttachment: vi.fn(),
  statusPanelExpanded: false,
  onRetryDaemonStatus: vi.fn(),
  // 健康态：状态已知 + daemon 存活 → 不展示任何状态栏。
  daemonStatusLoaded: true,
  daemonAlive: true,
  daemonIssue: null,
});

describe('ChatInputBoxHeader', () => {
  it('renders without SDK warning bar', () => {
    render(<ChatInputBoxHeader {...createProps()} />);

    // SDK warning bar should not be present
    expect(document.querySelector('.sdk-warning-bar')).toBeNull();
  });

  it('shows the starting state while opencode serve is launching', () => {
    render(<ChatInputBoxHeader {...createProps()} daemonStatusLoaded={false} daemonAlive={false} />);

    const bar = document.querySelector('.sdk-warning-bar');
    expect(bar).not.toBeNull();
    expect(bar?.classList.contains('sdk-loading')).toBe(true);
    expect(screen.getByText('chat.daemonStatusLoading')).toBeTruthy();
  });

  it('shows the concrete reason and install command when opencode is missing', () => {
    render(
      <ChatInputBoxHeader
        {...createProps()}
        daemonAlive={false}
        daemonIssue={{ code: 'NOT_INSTALLED', detail: '找不到 opencode 可执行文件', installCmd: 'npm install -g opencode-ai' }}
      />
    );

    // 标题取 code 对应文案，而不是笼统的「serve 未运行」。
    expect(screen.getByText('chat.daemonIssue.NOT_INSTALLED')).toBeTruthy();
    expect(screen.queryByText('chat.daemonNotRunning')).toBeNull();
    // 安装命令可复制。
    expect(screen.getByText('chat.copyInstallCommand')).toBeTruthy();
    expect(screen.getByText('chat.retryDaemonStatus')).toBeTruthy();
  });

  it('falls back to the generic not-running bar when the host sent no reason', () => {
    render(<ChatInputBoxHeader {...createProps()} daemonAlive={false} daemonIssue={null} />);

    expect(screen.getByText('chat.daemonNotRunning')).toBeTruthy();
    expect(document.querySelector('.sdk-warning-bar.sdk-error')).toBeNull();
  });
});
