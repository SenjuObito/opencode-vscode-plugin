import { describe, expect, it } from 'vitest';
import { TabMessageStore, messageKey } from './tabMessageStore';
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

describe('TabMessageStore', () => {
  it('keeps the order of a snapshot', () => {
    const store = new TabMessageStore();
    const result = store.applySnapshot([user('a'), assistant('b')]);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('a');
    expect(result[1].content).toBe('b');
    expect(store.size()).toBe(2);
  });

  it('reconciles by id so a message keeps its identity across snapshots', () => {
    const store = new TabMessageStore();
    store.applySnapshot([user('a', 'u1'), assistant('b', 'u2')]);

    const key = messageKey(store.toArray()[1], 1);
    store.markStreamingAssistant(key);
    expect(store.getStreamingAssistantId()).toBe(key);

    // A snapshot that repeats the same messages keeps the same key.
    const again = store.applySnapshot([user('a', 'u1'), assistant('b2', 'u2')]);
    expect(again[1].content).toBe('b2');
    expect(store.getStreamingAssistantId()).toBe(key);
  });

  it('forgets the streaming assistant when it disappears', () => {
    const store = new TabMessageStore();
    store.applySnapshot([user('a', 'u1'), assistant('b', 'u2')]);
    store.markStreamingAssistant(messageKey(store.toArray()[1], 1));

    store.applySnapshot([user('a', 'u1')]);

    expect(store.getStreamingAssistantId()).toBeNull();
  });

  it('removes messages by id', () => {
    const store = new TabMessageStore();
    store.applySnapshot([user('a', 'u1'), assistant('b', 'u2')]);
    const removedKey = messageKey(store.toArray()[0], 0);

    const result = store.removeByIds([removedKey]);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('b');
  });

  it('replaces only the tail', () => {
    const store = new TabMessageStore();
    store.applySnapshot([user('a', 'u1'), assistant('b', 'u2'), assistant('c', 'u3')]);

    const result = store.applyTail([assistant('c2', 'u3')]);

    expect(result).toHaveLength(3);
    expect(result[0].content).toBe('a');
    expect(result[1].content).toBe('b');
    expect(result[2].content).toBe('c2');
  });

  it('replaces the whole transcript when the tail is longer than it', () => {
    const store = new TabMessageStore();
    store.applySnapshot([user('a', 'u1')]);

    const result = store.applyTail([assistant('b', 'u2'), assistant('c', 'u3')]);

    // A tail longer than the transcript cannot be a tail: the whole list is
    // the newer state.
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('b');
    expect(result[1].content).toBe('c');
  });
});
