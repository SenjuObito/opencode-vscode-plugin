import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AskUserQuestionDialog, type AskUserQuestionRequest } from './AskUserQuestionDialog';

const countdown = vi.hoisted(() => ({
  state: { remainingSeconds: 100, isTimeWarning: false },
  markSubmitted: vi.fn(() => true),
  lastOpts: null as null | { onTimeout?: () => void; requestKey?: string },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}));

vi.mock('../hooks/useDialogCountdownTimeout', () => ({
  useDialogCountdownTimeout: (opts: { onTimeout?: () => void; requestKey?: string }) => {
    countdown.lastOpts = opts;
    return {
      remainingSeconds: countdown.state.remainingSeconds,
      isTimeWarning: countdown.state.isTimeWarning,
      markSubmitted: countdown.markSubmitted,
    };
  },
}));

vi.mock('../hooks/useDialogResize', () => ({
  useDialogResize: () => ({
    dialogRef: { current: null },
    dialogHeight: null,
    setDialogHeight: vi.fn(),
    handleResizeStart: vi.fn(),
  }),
}));

const mkRequest = (overrides: Partial<AskUserQuestionRequest> = {}): AskUserQuestionRequest => ({
  requestId: 'req-1',
  toolName: 'AskUserQuestion',
  questions: [
    {
      question: 'Pick one?',
      header: 'Choice',
      options: [
        { label: 'Option A', description: 'first' },
        { label: 'Option B' },
      ],
    },
  ],
  ...overrides,
});

const renderDialog = (request: AskUserQuestionRequest | null) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <AskUserQuestionDialog isOpen request={request} onSubmit={onSubmit} onCancel={onCancel} />,
  );
  return { onSubmit, onCancel };
};

describe('AskUserQuestionDialog', () => {
  beforeEach(() => {
    countdown.state = { remainingSeconds: 100, isTimeWarning: false };
    countdown.markSubmitted.mockClear();
    countdown.lastOpts = null;
  });

  it('renders nothing without a request', () => {
    const { container } = render(
      <AskUserQuestionDialog isOpen={false} request={null} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('single-select submit serializes the chosen option keyed by question text', () => {
    const { onSubmit } = renderDialog(mkRequest());
    fireEvent.click(screen.getByText('Option A'));
    fireEvent.click(screen.getByText('askUserQuestion.submit'));
    expect(onSubmit).toHaveBeenCalledWith('req-1', { 'Pick one?': 'Option A' });
  });

  it('multi-select submit passes the selected labels as an array', () => {
    const request = mkRequest({
      questions: [
        { question: 'Pick many?', header: 'Choice', multiSelect: true, options: [
          { label: 'A' }, { label: 'B' }, { label: 'C' },
        ] },
      ],
    });
    const { onSubmit } = renderDialog(request);
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('B'));
    fireEvent.click(screen.getByText('askUserQuestion.submit'));
    expect(onSubmit).toHaveBeenCalledWith('req-1', { 'Pick many?': ['A', 'B'] });
  });

  it('Other option uses the custom textarea value', () => {
    const request = mkRequest({
      questions: [
        { question: 'Pick?', header: 'Choice', options: [
            { label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' },
        ] },
      ],
    });
    const { onSubmit } = renderDialog(request);
    fireEvent.click(screen.getByText('askUserQuestion.otherOption'));
    const textarea = screen.getByPlaceholderText('askUserQuestion.customInputPlaceholder');
    fireEvent.change(textarea, { target: { value: 'my custom answer' } });
    fireEvent.click(screen.getByText('askUserQuestion.submit'));
    expect(onSubmit).toHaveBeenCalledWith('req-1', { 'Pick?': 'my custom answer' });
  });

  it('paging through multiple questions serializes each answer', () => {
    const request = mkRequest({
      questions: [
        { question: 'Q1?', header: 'One', options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2?', header: 'Two', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    });
    const { onSubmit } = renderDialog(request);
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('askUserQuestion.next'));
    fireEvent.click(screen.getByText('C'));
    fireEvent.click(screen.getByText('askUserQuestion.submit'));
    expect(onSubmit).toHaveBeenCalledWith('req-1', { 'Q1?': 'A', 'Q2?': 'C' });
  });

  it('cancel invokes onCancel with the requestId', () => {
    const { onCancel } = renderDialog(mkRequest());
    fireEvent.click(screen.getByText('askUserQuestion.cancel'));
    expect(onCancel).toHaveBeenCalledWith('req-1');
  });

  it('timeout invokes onCancel for the active request even when the countdown is gated', () => {
    const { onCancel } = renderDialog(mkRequest());
    countdown.markSubmitted.mockReturnValue(false);
    act(() => {
      countdown.lastOpts?.onTimeout?.();
    });
    expect(countdown.markSubmitted).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith('req-1');
  });

  it('renders dialog with codicon checkboxes', () => {
    renderDialog(mkRequest());
    expect(document.querySelector('.question-option')).toBeTruthy();
    expect(document.querySelector('.option-checkbox .codicon')).toBeTruthy();
  });
});
