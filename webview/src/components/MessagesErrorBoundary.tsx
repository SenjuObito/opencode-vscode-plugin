import React, { Component, type ReactNode } from 'react';
import type { TFunction } from 'i18next';

interface MessagesErrorBoundaryProps {
  children: ReactNode;
  currentSessionId?: string | null;
  t?: TFunction;
  onReset?: () => void;
}

interface MessagesErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

/**
 * Error boundary wrapping the message display list.
 * Catches any render crashes (e.g. malformed markdown, unhandled KaTeX, broken tool blocks)
 * and displays a localized fallback error card with retry capability without unmounting
 * the entire chat view or leaving an empty black screen.
 */
export class MessagesErrorBoundary extends Component<MessagesErrorBoundaryProps, MessagesErrorBoundaryState> {
  constructor(props: MessagesErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): MessagesErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[MessagesErrorBoundary] Caught error in message list rendering:', error, errorInfo);
  }

  componentDidUpdate(prevProps: MessagesErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.currentSessionId !== this.props.currentSessionId) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: undefined });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const t = this.props.t;
      const errorMsg = this.state.error?.message || (t ? t('chat.renderError', { defaultValue: '消息渲染发生异常' }) : '消息渲染发生异常');
      const retryText = t ? t('common.retry', { defaultValue: '重新加载' }) : '重新加载';

      return (
        <div className="messages-render-error-container" style={{ padding: '24px 16px', textAlign: 'center' }}>
          <div style={{ color: 'var(--vscode-errorForeground, #f48771)', marginBottom: '12px' }}>
            <span className="codicon codicon-warning" style={{ marginRight: '8px', verticalAlign: 'middle' }} />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            className="chat-action-btn secondary"
            onClick={this.handleRetry}
            style={{ padding: '6px 14px', borderRadius: '4px', cursor: 'pointer' }}
          >
            {retryText}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default MessagesErrorBoundary;
