import type { QueuedMessage, TabQueueErrorView } from '../../store/tabQueueStore';

export interface MessageQueueProps {
  /** Items waiting for their turn. */
  queue: QueuedMessage[];
  /** True after the user stopped a turn: the queue waits for a resume. */
  paused?: boolean;
  /** Last send failure reported by the host. */
  error?: TabQueueErrorView | null;
  /** Remove a pending item. */
  onRemove: (id: string) => void;
  /** User confirmed: continue consuming the queue. */
  onResume?: () => void;
}

function preview(item: QueuedMessage): string {
  const text = item.content.trim();
  if (text) return text;
  const count = item.attachments?.length ?? 0;
  return count > 0 ? `${count} attachment${count > 1 ? 's' : ''}` : '';
}

/**
 * MessageQueue — the active tab's outbox.
 *
 * <p>This is a projection, not a scheduling surface: the host owns the queue
 * and decides when an item is sent. Only items that are *still waiting* are
 * listed — the moment the host starts sending one it leaves this list and
 * appears in the conversation instead. A paused banner with an explicit
 * "continue" stays: after a stop the host waits for that confirmation instead
 * of sending the next prompt automatically.</p>
 */
export function MessageQueue({
  queue,
  paused = false,
  error,
  onRemove,
  onResume,
}: MessageQueueProps) {
  if (queue.length === 0 && !error) {
    return null;
  }

  return (
    <div className="message-queue">
      {error && (
        <div className="message-queue-banner message-queue-banner-error" role="alert">
          <span className="codicon codicon-warning" />
          <span className="message-queue-banner-text" title={error.message}>{error.message}</span>
        </div>
      )}
      {paused && (
        <div className="message-queue-banner message-queue-banner-paused">
          <span className="codicon codicon-debug-pause" />
          <span className="message-queue-banner-text">队列已暂停</span>
          {onResume && (
            <button className="message-queue-resume" onClick={onResume}>
              继续发送
            </button>
          )}
        </div>
      )}
      {/* Render in reverse order so newest is at bottom (closest to input) */}
      {[...queue].reverse().map((item, reversedIndex) => {
        // Calculate actual queue position (1-based, from bottom)
        const queuePosition = queue.length - reversedIndex;
        return (
          <div key={item.id} className="message-queue-item">
            <span className="message-queue-number">{queuePosition}</span>
            <span className="message-queue-content" title={item.content}>
              {preview(item)}
            </span>
            {(item.attachments?.length ?? 0) > 0 && (
              <span className="message-queue-badge" title={`${item.attachments?.length} attachment(s)`}>
                {item.attachments?.length}
              </span>
            )}
            <button
              className="message-queue-remove"
              onClick={() => onRemove(item.id)}
              title="Remove from queue"
            >
              <span className="codicon codicon-close" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default MessageQueue;
