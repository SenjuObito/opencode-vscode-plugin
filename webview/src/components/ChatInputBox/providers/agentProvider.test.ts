import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/bridge', () => ({
  sendWindowCommand: vi.fn(() => true),
}));

import {
  agentProvider,
  EMPTY_STATE_ID,
  ensureAgentsLoaded,
  getNextPrimaryMode,
  getPrimaryAgentsSync,
  getSubagentsSync,
  subagentMentionProvider,
} from './agentProvider';
import { __resetAgentStoreForTests, getAgentSnapshot, requestAgents } from '../../../store/agentStore';
import { sendWindowCommand } from '../../../utils/bridge';
import { dispatchHostEvent, resetHostDispatcher } from '../../../utils/hostDispatcher';
import { resetHostEvents } from '../../../utils/hostEventRegistry';

const agentsJson = JSON.stringify([
  { id: 'general', name: 'General', mode: 'subagent', description: 'General agent' },
  { id: 'explore', name: 'Explore', mode: 'subagent', description: 'Explore agent' },
]);

const catalogueJson = JSON.stringify([
  { id: 'build', name: 'Build', mode: 'primary' },
  { id: 'plan', name: 'Plan', mode: 'primary' },
  { id: 'winui-dev', name: 'winui-dev', mode: 'primary' },
  { id: 'general', name: 'General', mode: 'subagent' },
]);

describe('agent catalogue store', () => {
  beforeEach(() => {
    resetHostDispatcher();
    resetHostEvents();
    __resetAgentStoreForTests();
    vi.clearAllMocks();
  });

  it('sends one request and applies the host reply', () => {
    ensureAgentsLoaded();

    expect(sendWindowCommand).toHaveBeenCalledWith('agents.list');

    dispatchHostEvent('agents.updated', [agentsJson]);

    expect(getSubagentsSync().map((agent) => agent.name)).toEqual(['General', 'Explore']);
    expect(getAgentSnapshot().loaded).toBe(true);
  });

  it('accepts a named-event payload that still carries the JSON in `data`', () => {
    requestAgents();
    dispatchHostEvent('agents.updated', [{ data: catalogueJson }]);

    expect(getPrimaryAgentsSync().map((agent) => agent.id)).toEqual(['build', 'plan', 'winui-dev']);
  });

  it('does not retry an empty reply on a timer', () => {
    vi.useFakeTimers();
    try {
      requestAgents();
      expect(sendWindowCommand).toHaveBeenCalledTimes(1);

      // An empty answer is taken as the host's answer, not guessed at.
      dispatchHostEvent('agents.updated', ['[]']);
      vi.advanceTimersByTime(10_000);

      expect(sendWindowCommand).toHaveBeenCalledTimes(1);
      expect(getAgentSnapshot()).toEqual({ agents: [], loaded: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a malformed payload and keeps the last good snapshot', () => {
    requestAgents();
    dispatchHostEvent('agents.updated', [catalogueJson]);
    dispatchHostEvent('agents.updated', ['not json']);

    expect(getPrimaryAgentsSync().map((agent) => agent.id)).toEqual(['build', 'plan', 'winui-dev']);
  });

  it('serves the @ dropdown from the pushed catalogue', async () => {
    requestAgents();
    dispatchHostEvent('agents.updated', [agentsJson]);

    const items = await subagentMentionProvider('', new AbortController().signal);

    expect(items.map((item) => item.name)).toEqual(['General', 'Explore']);
  });

  it('keeps a custom primary agent and hides hidden/subagent entries from the mode list', () => {
    requestAgents();
    dispatchHostEvent('agents.updated', [JSON.stringify([
      { id: 'build', name: 'Build', mode: 'primary' },
      { id: 'winui-dev', name: 'winui-dev', mode: 'primary', hidden: false },
      { id: 'secret', name: 'Secret', mode: 'primary', hidden: true },
      { id: 'general', name: 'General', mode: 'subagent' },
    ])]);

    expect(getPrimaryAgentsSync().map((agent) => agent.id)).toEqual(['build', 'winui-dev']);
  });

  it('preserves the agent-declared colour through the store', () => {
    requestAgents();
    dispatchHostEvent('agents.updated', [JSON.stringify([
      { id: 'reviewer', name: 'reviewer', mode: 'primary', color: '#2fb37a' },
    ])]);

    expect(getAgentSnapshot().agents[0].color).toBe('#2fb37a');
  });

  it('cycles Shift+Tab through every primary agent, including custom ones', () => {
    requestAgents();
    dispatchHostEvent('agents.updated', [catalogueJson]);

    expect(getNextPrimaryMode('build')).toBe('plan');
    expect(getNextPrimaryMode('plan')).toBe('winui-dev');
    expect(getNextPrimaryMode('winui-dev')).toBe('build');
    // The legacy spelling of build takes the same path.
    expect(getNextPrimaryMode('default')).toBe('plan');
  });

  it('falls back to the build/plan placeholder before the first push', () => {
    expect(getNextPrimaryMode('build')).toBe('plan');
    expect(getNextPrimaryMode('plan')).toBe('build');
  });

  it('lists every agent for the settings dropdown, not only subagents', async () => {
    requestAgents();
    dispatchHostEvent('agents.updated', [catalogueJson]);

    const items = await agentProvider('', new AbortController().signal);

    expect(items.map((item) => item.id)).toEqual(['build', 'plan', 'winui-dev', 'general', '__create_new__']);
    expect(items.some((item) => item.id === EMPTY_STATE_ID)).toBe(false);
  });
});
