import { describe, expect, it } from 'vitest';
import { TabTranscript } from './tabTranscript';
import type { ClaudeMessage } from '../types';

const user = (content: string, uuid?: string): ClaudeMessage => ({
  type: 'user',
  content,
  timestamp: '2026-01-01T00:00:00.000Z',
  ...(uuid ? { raw: { uuid } } : {}),
} as unknown as ClaudeMessage);

const assistant = (content: string, uuid?: string): ClaudeMessage => ({
  type: 'assistant',
  content,
  timestamp: '2026-01-01T00:00:01.000Z',
  ...(uuid ? { raw: { uuid } } : {}),
} as unknown as ClaudeMessage);

const contents = (list: ClaudeMessage[]): string[] => list.map((message) => message.content ?? '');

describe('TabTranscript', () => {
  it('keeps the order of a snapshot', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a'), assistant('b')]);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'b']);
    expect(transcript.size()).toBe(2);
  });

  it('returns the same snapshot reference until something changes', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a')]);

    expect(transcript.getSnapshot()).toBe(transcript.getSnapshot());

    transcript.applySnapshot([user('a'), assistant('b')]);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'b']);
  });

  it('prepends an older page in front of an empty transcript', () => {
    // Regression: an empty store used to mean "nothing to prepend in front of",
    // and the page replaced the whole conversation.
    const transcript = new TabTranscript();
    transcript.prependPage([user('a'), assistant('b')], 0);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'b']);
    expect(transcript.pagedCount()).toBe(2);
  });

  it('prepends an older page in front of the transcript', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('c', 'u3'), assistant('d', 'u4')]);

    transcript.prependPage([user('a', 'u1'), assistant('b', 'u2')]);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'b', 'c', 'd']);
    expect(transcript.size()).toBe(4);
  });

  it('keeps the older page when a snapshot for the current window arrives', () => {
    // This is the observed bug: the page is visible, then the host's next
    // snapshot (which only covers the current window) wipes it.
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('c', 'u3'), assistant('d', 'u4')]);
    transcript.prependPage([user('a', 'u1'), assistant('b', 'u2')]);

    transcript.applySnapshot([user('c', 'u3'), assistant('d', 'u4')]);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the old window head that slid out of the newest snapshot', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a', 'u1'), assistant('b', 'u2')], 0);

    // The host's window advanced by two records: its snapshot no longer
    // carries `a`/`b`, but the user has already read them.
    transcript.applySnapshot([user('c', 'u3'), assistant('d', 'u4')], 2);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'b', 'c', 'd']);
    expect(transcript.baseIndex()).toBe(2);
    expect(transcript.pagedCount()).toBe(2);
  });

  it('does not duplicate the page when it is delivered again', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('c', 'u3')]);
    transcript.prependPage([user('a', 'u1'), user('c', 'u3')]);
    transcript.prependPage([user('a', 'u1'), user('c', 'u3')]);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'c']);
  });

  it('skips the overlap between a page and the transcript', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('c', 'u3'), assistant('d', 'u4')]);

    transcript.prependPage([user('a', 'u1'), user('c', 'u3')]);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'c', 'd']);
    expect(transcript.size()).toBe(3);
  });

  it('leaves the transcript untouched for an empty page', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a', 'u1')]);
    const before = transcript.getSnapshot();

    transcript.prependPage([]);

    expect(transcript.getSnapshot()).toBe(before);
  });

  it('records the window start the page belongs to', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('c', 'u3')], 10);
    transcript.prependPage([user('a', 'u1')], 8);

    expect(transcript.baseIndex()).toBe(10);
    expect(transcript.windowStart()).toBe(8);
  });

  it('replaces only the tail', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a', 'u1'), assistant('b', 'u2'), assistant('c', 'u3')]);

    transcript.applyTail([assistant('c2', 'u3')], 2);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'b', 'c2']);
  });

  it('replaces the whole transcript when the tail is longer than it', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a', 'u1')]);

    transcript.applyTail([assistant('b', 'u2'), assistant('c', 'u3')], 0);

    expect(contents(transcript.getSnapshot())).toEqual(['b', 'c']);
  });

  it('keeps the prepended page when a tail arrives', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a', 'u1'), assistant('b', 'u2')], 0);
    transcript.prependPage([user('older', 'u0')]);

    transcript.applyTail([assistant('c', 'u3')], 2);

    expect(contents(transcript.getSnapshot())).toEqual(['older', 'a', 'b', 'c']);
    expect(transcript.baseIndex()).toBe(0);
  });

  it('removes messages by provider id', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a', 'u1'), assistant('b', 'u2')]);

    transcript.removeByIds(['u1']);

    expect(contents(transcript.getSnapshot())).toEqual(['b']);
  });

  it('truncates at an index for a revert', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a', 'u1'), assistant('b', 'u2'), user('c', 'u3')]);

    transcript.truncateAt(2);

    expect(contents(transcript.getSnapshot())).toEqual(['a', 'b']);
  });

  it('clears everything', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('a')]);
    transcript.addLocal('local-1', user('pending'));

    transcript.clear();

    expect(transcript.getSnapshot()).toEqual([]);
    expect(transcript.size()).toBe(0);
  });

  describe('optimistic bubbles', () => {
    it('survives a snapshot that predates the send', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);

      transcript.addLocal('local-1', user('new prompt'));
      transcript.applySnapshot([user('a', 'u1')]);

      expect(contents(transcript.getSnapshot())).toEqual(['a', 'new prompt']);
    });

    it('is dropped once the host echoes it', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);
      transcript.addLocal('local-1', user('new prompt'));

      transcript.applySnapshot([user('a', 'u1'), user('new prompt')]);

      expect(contents(transcript.getSnapshot())).toEqual(['a', 'new prompt']);
      expect(transcript.size()).toBe(2);
    });

    it('takes the provider id the host assigns', () => {
      const transcript = new TabTranscript();
      transcript.addLocal('local-1', user('new prompt'));

      transcript.assignProviderId('new prompt', 'u2');

      expect(transcript.getSnapshot()[0].raw).toMatchObject({ uuid: 'u2' });
    });
  });

  describe('streaming', () => {
    it('accumulates deltas into the pending bubble', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);

      const index = transcript.beginAssistant(1, false);
      transcript.appendDelta('hel', 1);
      transcript.appendDelta('lo', 1);

      const snapshot = transcript.getSnapshot();
      expect(index).toBe(1);
      expect(snapshot[1]).toMatchObject({ type: 'assistant', content: 'hello', isStreaming: true });
    });

    it('is not erased by a snapshot that predates the last delta', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);

      transcript.beginAssistant(1, false);
      transcript.appendDelta('still here', 1);
      transcript.applySnapshot([user('a', 'u1')]);

      const snapshot = transcript.getSnapshot();
      expect(snapshot).toHaveLength(2);
      expect(snapshot[1].content).toBe('still here');
    });

    it('settles into the remote segment with its duration', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);
      transcript.beginAssistant(1, false);
      transcript.appendDelta('done', 1);

      transcript.settleAssistant(1, 1234);

      const snapshot = transcript.getSnapshot();
      expect(snapshot[1]).toMatchObject({ content: 'done', isStreaming: false, durationMs: 1234 });
      expect(transcript.streamingAssistantTurn()).toBeNull();
    });

    it('reuses the last assistant bubble for a replay', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1'), assistant('partial', 'u2')]);

      transcript.beginAssistant(2, true);
      transcript.appendDelta(' more', 2);

      expect(contents(transcript.getSnapshot())).toEqual(['a', 'partial more']);
    });

    it('drops an empty bubble when the turn settles', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);
      transcript.beginAssistant(1, false);

      transcript.finalizeStreamingTurn(
        {
          turnId: 1,
          content: '',
          backendRaw: null,
          pendingToolResults: [],
          toolResultTimestamp: '2026-01-01T00:00:02.000Z',
        },
        (messages) => messages,
      );

      expect(contents(transcript.getSnapshot())).toEqual(['a']);
    });

    it('keeps the last delta when the ending snapshot is older', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);
      transcript.beginAssistant(1, false);
      transcript.appendDelta('final text', 1);

      transcript.finalizeStreamingTurn(
        {
          turnId: 1,
          content: 'final text',
          backendRaw: { message: { content: [{ type: 'text', text: 'final' }] } },
          durationMs: 10,
          pendingToolResults: [],
          toolResultTimestamp: '2026-01-01T00:00:02.000Z',
        },
        (messages) => messages,
      );

      const snapshot = transcript.getSnapshot();
      expect(snapshot[1]).toMatchObject({ content: 'final text', isStreaming: false, durationMs: 10 });
      expect((snapshot[1].raw as { message: { content: Array<{ text: string }> } }).message.content[0].text)
        .toBe('final text');
    });

    it('does not duplicate the streaming bubble when a snapshot reports it', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);
      transcript.beginAssistant(1, false);
      transcript.appendDelta('partial', 1);

      transcript.applySnapshot([
        user('a', 'u1'),
        { type: 'assistant', content: 'partial answer', timestamp: '2026-01-01T00:00:01.000Z' } as ClaudeMessage,
      ]);

      const assistantBubbles = transcript.getSnapshot().filter((message) => message.type === 'assistant');
      expect(assistantBubbles).toHaveLength(1);
      // The host's longer text wins, and the bubble stays the streaming one.
      expect(assistantBubbles[0]).toMatchObject({ content: 'partial answer', isStreaming: true });
    });

    it('takes structural blocks from a snapshot without losing streamed text', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);
      transcript.beginAssistant(1, false);
      transcript.appendDelta('long streamed text', 1);

      transcript.applySnapshot([
        user('a', 'u1'),
        {
          type: 'assistant',
          content: 'short',
          timestamp: '2026-01-01T00:00:01.000Z',
          raw: {
            message: {
              content: [
                { type: 'text', text: 'short' },
                { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          },
        } as ClaudeMessage,
      ]);

      const assistant = transcript.getSnapshot()[1];
      expect(assistant.content).toBe('long streamed text');
      const blocks = (assistant.raw as { message: { content: Array<{ type: string }> } }).message.content;
      expect(blocks.some((block) => block.type === 'tool_use')).toBe(true);
    });

    it('closes only the old assistant bubble, not a tool_result below it', () => {
      const transcript = new TabTranscript();
      transcript.applySnapshot([
        user('a', 'u1'),
        {
          type: 'assistant',
          content: 'used a tool',
          isStreaming: true,
          __turnId: 1,
          timestamp: '2026-01-01T00:00:01.000Z',
        } as ClaudeMessage,
        {
          type: 'user',
          content: '[tool_result]',
          timestamp: '2026-01-01T00:00:02.000Z',
          raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
        } as ClaudeMessage,
      ]);

      transcript.beginAssistant(2, false);

      // The old bubble closes in place; the new turn streams below the tool result.
      const snapshot = transcript.getSnapshot();
      expect(contents(snapshot)).toEqual(['a', 'used a tool', '[tool_result]', '']);
      expect(snapshot[1].isStreaming).toBe(false);
      expect(snapshot[3]).toMatchObject({ type: 'assistant', isStreaming: true, __turnId: 2 });
    });

    it('recovers tool results that never reached a frame', () => {      const transcript = new TabTranscript();
      transcript.applySnapshot([user('a', 'u1')]);
      transcript.beginAssistant(1, false);
      transcript.appendDelta('calling a tool', 1);

      transcript.finalizeStreamingTurn(
        {
          turnId: 1,
          content: 'calling a tool',
          backendRaw: null,
          pendingToolResults: [{
            content: '[tool_result]',
            raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
          }],
          toolResultTimestamp: '2026-01-01T00:00:02.000Z',
        },
        (messages) => messages,
      );

      const snapshot = transcript.getSnapshot();
      expect(snapshot).toHaveLength(3);
      expect(snapshot[2].type).toBe('user');
    });
  });
});

describe('TabTranscript compaction boundaries', () => {
  const compaction = (
    uuid: string,
    status: 'in_progress' | 'completed' | 'failed' = 'in_progress',
  ): ClaudeMessage => ({
    type: 'compaction',
    content: '',
    timestamp: '2026-01-01T00:00:02.000Z',
    raw: { type: 'compaction', uuid },
    compaction: { status, reason: 'auto' },
  } as unknown as ClaudeMessage);

  it('settles the pre-compaction pending above the card, then opens a new bubble', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('u1')]);
    transcript.beginAssistant(1, false);
    transcript.appendDelta('before compaction', 1);

    // The host seals the assistant and appends the compaction record.
    transcript.applySnapshot([
      user('u1'),
      assistant('before compaction', 'a1'),
      compaction('c1'),
    ]);

    expect(contents(transcript.getSnapshot())).toEqual(['u1', 'before compaction', '']);
    expect(transcript.getSnapshot()[2].type).toBe('compaction');

    // The first delta after the boundary belongs to a new segment.
    transcript.appendDelta('after compaction', 1);
    const afterDelta = transcript.getSnapshot();
    expect(afterDelta.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'compaction',
      'assistant',
    ]);
    expect(afterDelta[3].content).toBe('after compaction');
  });

  it('merges the post-compaction streaming copy instead of duplicating it', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([
      user('u1'),
      assistant('before', 'a1'),
      compaction('c1'),
      assistant('', 'a2'),
    ]);
    transcript.beginAssistant(2, false);
    transcript.appendDelta('after', 2);

    transcript.applySnapshot([
      user('u1'),
      assistant('before', 'a1'),
      compaction('c1'),
      assistant('after and more', 'a2'),
    ]);

    const snapshot = transcript.getSnapshot();
    expect(snapshot.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'compaction',
      'assistant',
    ]);
    expect(snapshot[3].content).toBe('after and more');
  });

  it('never rewrites the sealed assistant when the current segment is empty', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([
      user('u1'),
      assistant('sealed', 'a1'),
      compaction('c1'),
    ]);
    // No assistant after the boundary: the patch must not fall back to the
    // sealed one.
    expect(transcript.patchAssistant(2, (message) => ({ ...message, content: 'leak' }))).toBe(-1);
    expect(transcript.getSnapshot()[1].content).toBe('sealed');
  });
  it('reports a crossed boundary exactly once so the view can drop stale buffers', () => {
    const transcript = new TabTranscript();
    transcript.applySnapshot([user('u1')]);
    transcript.beginAssistant(1, false);
    transcript.appendDelta('before', 1);

    transcript.applySnapshot([user('u1'), assistant('before', 'a1'), compaction('c1')]);

    expect(transcript.consumeCompactionBoundary()).toBe(true);
    expect(transcript.consumeCompactionBoundary()).toBe(false);
  });

});
