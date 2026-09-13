import { describe, it, expect } from 'vitest';
import {
  normalizeToolName,
  isToolName,
  FILE_MODIFY_TOOL_NAMES,
  EDIT_TOOL_NAMES,
} from './toolConstants';

describe('normalizeToolName', () => {
  it('lowercases standard names', () => {
    expect(normalizeToolName('Edit')).toBe('edit');
    expect(normalizeToolName('Write')).toBe('write');
  });


  it('keeps camelCase tools as concatenated lower (TaskCreate)', () => {
    expect(normalizeToolName('TaskCreate')).toBe('taskcreate');
  });

  it('strips mcp prefix', () => {
    expect(normalizeToolName('mcp__server__Edit')).toBe('edit');
  });
});

describe('FILE_MODIFY_TOOL_NAMES', () => {

  it('still recognizes classic Edit/Write', () => {
    expect(isToolName('Edit', FILE_MODIFY_TOOL_NAMES)).toBe(true);
    expect(isToolName('Write', FILE_MODIFY_TOOL_NAMES)).toBe(true);
  });
});

