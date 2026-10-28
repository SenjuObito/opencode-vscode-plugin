// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetSlashCommandsState,
  slashCommandProvider,
} from './slashCommandProvider';
import { getTabStore, resetTabStore } from '../../../store/tabStore';
import { dispatchHostEnvelope } from '../../../utils/hostDispatcher';
import type { SessionTabData } from '../../../components/ChatHeader/types';

/**
 * §10.14：斜杠命令列表按 tab。
 *
 * 命令是按目录发现的（自定义命令 / skill），不同 cwd 的 tab 看到的列表不同。
 * 宿主按 tab 投回 `slash.commands`（语义事件，带 envelope.tabId），webview 侧
 * 按 tab 缓存；切到某个 tab 时直接用它自己的缓存。
 */
const makeTab = (id: string): SessionTabData => ({
  id,
  sessionId: null,
  title: '',
  messages: [],
} as SessionTabData);

const publish = (tabId: string, names: string[]) => {
  dispatchHostEnvelope({
    v: 2,
    type: 'slash.commands',
    tabId,
    epoch: 0,
    payload: { commands: names.map((name) => ({ name })) },
  });
};

describe('slashCommandProvider —— 命令列表按 tab 缓存', () => {
  beforeEach(() => {
    resetSlashCommandsState();
    resetTabStore();
    const store = getTabStore();
    store.setTabs([makeTab('tab-a'), makeTab('tab-b')]);
    store.setActiveTabId('tab-a');
  });

  it('每个 tab 用自己的命令列表', async () => {
    publish('tab-a', ['/alpha']);
    publish('tab-b', ['/beta']);

    const itemsA = await slashCommandProvider('', new AbortController().signal);
    expect(itemsA.map((i) => i.id)).toContain('alpha');
    expect(itemsA.map((i) => i.id)).not.toContain('beta');

    getTabStore().setActiveTabId('tab-b');
    const itemsB = await slashCommandProvider('', new AbortController().signal);
    expect(itemsB.map((i) => i.id)).toContain('beta');
    expect(itemsB.map((i) => i.id)).not.toContain('alpha');
  });

  it('后台 tab 的列表不会污染当前 tab', async () => {
    publish('tab-a', ['/alpha']);
    // 后台 tab 的列表先到：只进它自己的缓存。
    publish('tab-b', ['/beta']);

    const itemsA = await slashCommandProvider('', new AbortController().signal);
    expect(itemsA.map((i) => i.id)).toContain('alpha');
    expect(itemsA.map((i) => i.id)).not.toContain('beta');
  });
});
