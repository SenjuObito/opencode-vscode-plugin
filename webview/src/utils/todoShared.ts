export type RawTodoItem = {
  id?: unknown;
  content?: unknown;
  step?: unknown;
  title?: unknown;
  text?: unknown;
  status?: unknown;
  subject?: unknown;
  description?: unknown;
  blockedBy?: unknown;
};

/**
 * The canonical task list a StatusPanel renders.
 *
 * <p>Deliberately not a `TodoItem` import: this module is also reached from the
 * shared marker path, and the panel's type is structurally the same shape.</p>
 */
export type NormalizedTodoItem = {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  blockedBy?: string[];
};

/**
 * Parse a todo payload that may arrive JSON-in-JSON.
 *
 * <p>The legacy bridge wraps the daemon's JSON once more, so a single
 * `JSON.parse` yields a string instead of the object. Unwrapping is bounded and
 * a malformed payload yields `null` rather than throwing.</p>
 */
export function parseTodoPayload(raw: unknown): unknown {
  let parsed: unknown = raw;
  for (let depth = 0; depth < 3 && typeof parsed === 'string'; depth += 1) {
    const text = parsed.trim();
    if (text === '') {
      return null;
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return parsed;
}

/**
 * Normalize whatever the daemon put on the wire into a task list.
 *
 * <p>opencode names the text field differently across versions
 * (content/step/title/text/subject/description); statuses are normalized the
 * same way everywhere. `null` means "this is not a list" — an empty array is a
 * real state and is preserved.</p>
 */
export function normalizeTodoItems(raw: unknown): NormalizedTodoItem[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw
    .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
    .map((item, index) => {
      const candidates = [item.content, item.step, item.title, item.text, item.subject, item.description];
      const content = candidates.find((value): value is string => typeof value === 'string' && value.trim() !== '');
      const normalized: NormalizedTodoItem = {
        id: item.id != null ? String(item.id) : String(index),
        content: content?.trim() ?? '',
        status: normalizeTodoStatus(item.status),
      };
      if (Array.isArray(item.blockedBy)) {
        normalized.blockedBy = item.blockedBy
          .map((id: unknown) => (id != null ? String(id) : null))
          .filter((id: string | null): id is string => id !== null);
      }
      return normalized;
    })
    .filter((item) => item.content !== '');
}

/**
 * Extract the task list from a todo payload.
 *
 * <p>core publishes `{ sessionID, revision, todos }`; older publishers sent the
 * bare array, and the legacy bridge may wrap either in one more JSON string.
 * `null` means "this payload carries no task list".</p>
 */
export function todoListFromPayload(raw: unknown): NormalizedTodoItem[] | null {
  const parsed = parseTodoPayload(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' ? (parsed as { todos?: unknown }).todos : null);
  return normalizeTodoItems(list);
}

export function normalizeTodoStatus(status: unknown): 'pending' | 'in_progress' | 'completed' | 'cancelled' {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (value === 'completed' || value === 'done') {
    return 'completed';
  }
  if (value === 'in_progress' || value === 'in-progress' || value === 'active' || value === 'running') {
    return 'in_progress';
  }
  if (value === 'cancelled' || value === 'canceled') {
    // Core publishes `cancelled` as its own state; folding it into `completed`
    // would paint a cancelled task with a checkmark.
    return 'cancelled';
  }
  return 'pending';
}
