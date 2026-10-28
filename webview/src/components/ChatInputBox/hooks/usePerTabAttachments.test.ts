// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePerTabAttachments } from './usePerTabAttachments';
import { getTabStore, resetTabStore } from '../../../store/tabStore';
import type { Attachment } from '../types';

/**
 * §10.10：未发送的附件按 tab 保存。
 *
 * 旧行为是「会话一变就清空」——切 tab 会把待发附件扔掉。现在切 tab 各自保留，
 * 同一 tab 内换会话（加载历史）才清空。
 */
const attachment = (id: string): Attachment => ({
  id,
  fileName: `${id}.png`,
  mediaType: 'image/png',
  data: 'data:image/png;base64,AAA',
} as Attachment);

const makeTab = (id: string) => ({
  id,
  sessionId: null,
  title: '',
  messages: [],
} as never);

describe('usePerTabAttachments', () => {
  beforeEach(() => {
    resetTabStore();
    const store = getTabStore();
    store.setTabs([makeTab('tab-a'), makeTab('tab-b')]);
    store.setActiveTabId('tab-a');
  });

  it('切到别的 tab：旧 tab 保留附件，新 tab 取回自己的', () => {
    let current: Attachment[] = [attachment('a1')];
    const setAttachments = vi.fn((next: Attachment[]) => {
      current = next;
    });

    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        usePerTabAttachments({
          attachments: current,
          setAttachments,
          isControlled: false,
          currentSessionId: sessionId,
        }),
      { initialProps: { sessionId: 'ses_a' } },
    );

    // 切到 tab-b：附件存回 tab-a，tab-b 目前没有附件
    act(() => {
      getTabStore().setActiveTabId('tab-b');
    });

    const store = getTabStore();
    expect(store.findById('tab-a')?.pendingAttachments?.map((a) => a.id)).toEqual(['a1']);
    expect(setAttachments).toHaveBeenCalledWith([]);

    // 切回 tab-a：取回自己的附件
    act(() => {
      store.setActiveTabId('tab-a');
    });
    expect(setAttachments).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'a1' })]);

    rerender({ sessionId: 'ses_a' });
  });

  it('同一 tab 内换会话：附件属于旧会话，清空', () => {
    const setAttachments = vi.fn();
    const clearDraft = vi.fn();

    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        usePerTabAttachments({
          attachments: [attachment('a1')],
          setAttachments,
          isControlled: false,
          currentSessionId: sessionId,
          clearDraft,
        }),
      { initialProps: { sessionId: 'ses_a' } },
    );

    act(() => {
      rerender({ sessionId: 'ses_b' });
    });

    expect(setAttachments).toHaveBeenCalledWith([]);
    expect(clearDraft).toHaveBeenCalled();
  });

  it('外部控制附件时不动它（保持既有行为）', () => {
    const setAttachments = vi.fn();

    renderHook(() =>
      usePerTabAttachments({
        attachments: [attachment('a1')],
        setAttachments,
        isControlled: true,
        currentSessionId: 'ses_a',
      }),
    );

    act(() => {
      getTabStore().setActiveTabId('tab-b');
    });

    expect(setAttachments).not.toHaveBeenCalled();
  });
});
