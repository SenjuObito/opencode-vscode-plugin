import type { ComponentProps } from 'react';
import { render } from '@testing-library/react';
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
});

describe('ChatInputBoxHeader', () => {
  it('renders without SDK warning bar', () => {
    render(<ChatInputBoxHeader {...createProps()} />);

    // SDK warning bar should not be present
    expect(document.querySelector('.sdk-warning-bar')).toBeNull();
  });
});
