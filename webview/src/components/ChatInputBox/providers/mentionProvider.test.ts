import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mentionProvider, mentionToDropdownItem, type MentionItem } from './mentionProvider';
import * as fileReferenceProviderModule from './fileReferenceProvider';
import * as agentProviderModule from './agentProvider';

vi.mock('../../../i18n/config', () => ({
  default: {
    t: (key: string) => {
      if (key === 'chat.subagentsSection') return '子代理';
      if (key === 'chat.filesSection') return '文件';
      return key;
    },
  },
}));

describe('mentionProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('merges both subagents and files under section headers', async () => {
    vi.spyOn(fileReferenceProviderModule, 'fileReferenceProvider').mockResolvedValue([
      { name: 'App.tsx', path: 'src/App.tsx', type: 'file', absolutePath: '/proj/src/App.tsx' },
    ]);
    vi.spyOn(agentProviderModule, 'subagentMentionProvider').mockResolvedValue([
      { name: 'coder', description: 'Coding Assistant' },
    ]);

    const controller = new AbortController();
    const items = await mentionProvider('query', controller.signal);

    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({ kind: 'section', label: '子代理' });
    expect(items[1]).toMatchObject({ kind: 'subagent', name: 'coder' });
    expect(items[2]).toEqual({ kind: 'section', label: '文件' });
    expect(items[3]).toMatchObject({ kind: 'file', name: 'App.tsx' });
  });

  it('handles empty subagent list gracefully without subagent section', async () => {
    vi.spyOn(fileReferenceProviderModule, 'fileReferenceProvider').mockResolvedValue([
      { name: 'index.ts', path: 'src/index.ts', type: 'file', absolutePath: '/proj/src/index.ts' },
    ]);
    vi.spyOn(agentProviderModule, 'subagentMentionProvider').mockResolvedValue([]);

    const controller = new AbortController();
    const items = await mentionProvider('', controller.signal);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: 'section', label: '文件' });
    expect(items[1]).toMatchObject({ kind: 'file', name: 'index.ts' });
  });

  it('handles backend failure gracefully with empty array', async () => {
    vi.spyOn(fileReferenceProviderModule, 'fileReferenceProvider').mockRejectedValue(new Error('Backend error'));
    vi.spyOn(agentProviderModule, 'subagentMentionProvider').mockRejectedValue(new Error('Agent error'));

    const controller = new AbortController();
    const items = await mentionProvider('', controller.signal);

    expect(items).toEqual([]);
  });

  it('mentionToDropdownItem converts sections, subagents, and files properly', () => {
    const sectionItem: MentionItem = { kind: 'section', label: '文件' };
    const sectionDropdown = mentionToDropdownItem(sectionItem);
    expect(sectionDropdown.type).toBe('section-header');
    expect(sectionDropdown.label).toBe('文件');

    const subagentItem: MentionItem = { kind: 'subagent', name: 'planner', label: '@planner', description: 'Plan maker' };
    const subagentDropdown = mentionToDropdownItem(subagentItem);
    expect(subagentDropdown.label).toBe('@planner');
    expect(subagentDropdown.description).toBe('Plan maker');

    const fileItem: MentionItem = { kind: 'file', name: 'test.ts', path: 'src/test.ts', type: 'file', extension: 'ts' };
    const fileDropdown = mentionToDropdownItem(fileItem);
    expect(fileDropdown.label).toBe('test.ts');
    expect(fileDropdown.type).toBe('file');
  });
});
