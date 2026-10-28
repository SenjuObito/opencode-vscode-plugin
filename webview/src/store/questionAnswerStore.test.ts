import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setQuestionAnswer,
  getQuestionAnswer,
  removeQuestionAnswerByRequestId,
  clearQuestionAnswers,
  subscribe,
  getSnapshot,
} from './questionAnswerStore';

describe('questionAnswerStore', () => {
  beforeEach(() => {
    clearQuestionAnswers();
  });

  it('stores and retrieves question answer entries by callId', () => {
    const entry = {
      callId: 'call-1',
      requestId: 'req-1',
      questions: [{ question: 'What is your choice?' }],
      answers: { 'What is your choice?': 'Option A' },
    };

    setQuestionAnswer(entry);
    expect(getQuestionAnswer('call-1')).toEqual(entry);
    expect(getQuestionAnswer('call-non-existent')).toBeUndefined();
  });

  it('removes entries by requestId and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    const entry1 = {
      callId: 'call-1',
      requestId: 'req-1',
      questions: [{ question: 'Q1' }],
      answers: { Q1: 'A1' },
    };
    const entry2 = {
      callId: 'call-2',
      requestId: 'req-2',
      questions: [{ question: 'Q2' }],
      answers: { Q2: 'A2' },
    };

    setQuestionAnswer(entry1);
    setQuestionAnswer(entry2);
    expect(getQuestionAnswer('call-1')).toBeDefined();
    expect(getQuestionAnswer('call-2')).toBeDefined();

    const snapshotBefore = getSnapshot();
    removeQuestionAnswerByRequestId('req-1');

    expect(getQuestionAnswer('call-1')).toBeUndefined();
    expect(getQuestionAnswer('call-2')).toBeDefined();
    expect(getSnapshot()).toBeGreaterThan(snapshotBefore);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it('clears all answers and notifies subscribers', () => {
    setQuestionAnswer({
      callId: 'call-1',
      requestId: 'req-1',
      questions: [],
      answers: {},
    });
    expect(getQuestionAnswer('call-1')).toBeDefined();

    clearQuestionAnswers();
    expect(getQuestionAnswer('call-1')).toBeUndefined();
  });
});
