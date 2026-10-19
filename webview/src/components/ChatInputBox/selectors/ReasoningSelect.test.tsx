import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReasoningSelect } from './ReasoningSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

describe('ReasoningSelect', () => {
  it('renders default reasoning level and selects a new level', () => {
    const onChange = vi.fn();

    render(
      <ReasoningSelect
        value="high"
        onChange={onChange}
        currentProvider="opencode"
        selectedModel="anthropic/claude-3-7-sonnet"
      />,
    );

    const button = screen.getByRole('button');
    expect(button).toBeTruthy();
    fireEvent.click(button);

    const maxOption = screen.getByText('Max');
    expect(maxOption).toBeTruthy();
    fireEvent.click(maxOption);

    expect(onChange).toHaveBeenCalledWith('max');
  });

  it('filters available levels when modelVariants are provided', () => {
    render(
      <ReasoningSelect
        value="low"
        onChange={vi.fn()}
        currentProvider="opencode"
        selectedModel="custom-model"
        modelVariants={['low', 'medium']}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getAllByText('Low').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Medium')).toBeTruthy();
    expect(screen.queryByText('High')).toBeNull();
    expect(screen.queryByText('XHigh')).toBeNull();
    expect(screen.queryByText('Max')).toBeNull();
  });

  it('resets effort to an available level if current value is not in modelVariants', () => {
    const onChange = vi.fn();

    render(
      <ReasoningSelect
        value="max"
        onChange={onChange}
        currentProvider="opencode"
        selectedModel="custom-model"
        modelVariants={['low', 'medium']}
      />,
    );

    // currentLevel should fallback and trigger onChange
    expect(onChange).toHaveBeenCalled();
  });

  it('disables button when disabled prop is true', () => {
    render(
      <ReasoningSelect
        value="high"
        onChange={vi.fn()}
        currentProvider="opencode"
        disabled={true}
      />,
    );

    const button = screen.getByRole('button');
    expect(button).toHaveProperty('disabled', true);
  });

  it('hides the selector when modelVariants is empty', () => {
    const { container } = render(
      <ReasoningSelect
        value="default"
        onChange={vi.fn()}
        currentProvider="opencode"
        selectedModel="custom-model"
        modelVariants={[]}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides the selector and resets effort to default when switching to a model without variants', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ReasoningSelect
        value="high"
        onChange={onChange}
        currentProvider="opencode"
        selectedModel="custom-model"
        modelVariants={[]}
      />,
    );

    expect(container.firstChild).toBeNull();
    expect(onChange).toHaveBeenCalledWith('default');
  });

  it('keeps the selector hidden after the catalog lands with an empty variants list', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ReasoningSelect
        value="high"
        onChange={onChange}
        currentProvider="opencode"
        selectedModel="custom-model"
        modelVariants={undefined}
      />,
    );

    // Unknown support → legacy list, selector visible.
    expect(screen.getByRole('button')).toBeTruthy();

    rerender(
      <ReasoningSelect
        value="default"
        onChange={onChange}
        currentProvider="opencode"
        selectedModel="custom-model"
        modelVariants={[]}
      />,
    );

    // Catalog says "no levels" → hide, and never dereference an empty currentLevel.
    expect(container.firstChild).toBeNull();
  });
});
