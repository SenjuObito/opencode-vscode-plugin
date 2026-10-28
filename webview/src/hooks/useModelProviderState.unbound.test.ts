// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelProviderState } from './useModelProviderState';
import { sendBridgeEvent } from '../utils/bridge';
import { seedTabStore } from '../test/seedTabStore';

vi.mock('../utils/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/bridge')>();
  return {
    ...actual,
    sendBridgeEvent: vi.fn(),
    cardDebugLog: vi.fn(),
  };
});

const t = ((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key) as any;

/** The configuration commands the webview sent, as their envelopes. */
const configCalls = () => ((window.sendToJava as unknown as ReturnType<typeof vi.fn>)?.mock?.calls ?? [])
  .map((call: unknown[]) => call[0] as string)
  .filter((call) => call.startsWith('host_command:'))
  .map((call) => JSON.parse(call.substring('host_command:'.length)))
  .filter((envelope) => ['settings.model', 'settings.mode', 'settings.reasoning']
    .includes(envelope.type));

describe('useModelProviderState - unbound tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sendToJava = vi.fn();
    localStorage.clear();
    // The commands name the tab that owns the session.
    seedTabStore([{ id: 'tab-1', sessionId: 'ses_bound' }], 'tab-1');
  });

  it('does not write model/mode/effort while the active tab has no session', () => {
    // The ref is authoritative: it is deliberately null for a brand-new tab,
    // while the `currentSessionId` prop still carries the previous tab's id
    // until React commits. Falling back to the prop is what rewrote the
    // outgoing session.
    const currentSessionIdRef = { current: null as string | null };
    const { result } = renderHook(() => useModelProviderState({
      addToast: vi.fn(),
      t,
      currentSessionId: 'ses_previous',
      currentSessionIdRef,
    }));

    act(() => {
      result.current.handleModelSelect('opencode/new-model');
      result.current.handleModeSelect('plan');
      result.current.handleReasoningChange('high');
    });

    expect(configCalls()).toEqual([]);
  });

  it('scopes the same changes once the tab is bound', () => {
    const currentSessionIdRef = { current: 'ses_bound' as string | null };
    const { result } = renderHook(() => useModelProviderState({
      addToast: vi.fn(),
      t,
      currentSessionId: null,
      currentSessionIdRef,
    }));

    act(() => {
      result.current.handleModelSelect('opencode/new-model');
      result.current.handleModeSelect('plan');
      result.current.handleReasoningChange('high');
    });

    const calls = configCalls();
    // The envelope carries the identity; the payload only the content.
    const model = calls.find((envelope) => envelope.type === 'settings.model');
    expect(model.payload).toEqual({ model: 'opencode/new-model' });
    expect(model.sessionId).toBe('ses_bound');
    const mode = calls.find((envelope) => envelope.type === 'settings.mode');
    expect(mode.payload).toEqual({ mode: 'plan' });
    expect(mode.sessionId).toBe('ses_bound');
    const effort = calls.find((envelope) => envelope.type === 'settings.reasoning');
    expect(effort.payload).toEqual({ reasoningEffort: 'high' });
    expect(effort.sessionId).toBe('ses_bound');
  });
});
