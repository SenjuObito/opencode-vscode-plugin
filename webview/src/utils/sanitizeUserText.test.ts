import { describe, expect, it } from 'vitest';
import { sanitizeUserText } from './sanitizeUserText';

// 与 Java 侧 UserTextSanitizerTest 保持同规则（发送时注入、历史标题兜底清洗）。
describe('sanitizeUserText', () => {
  it('剥离末尾的 IDE Context 段', () => {
    const text = '帮我重构这段代码\n\n## IDE Context\n\nActive file: `src/App.tsx#L10-20`\n\nThe user has selected the referenced lines.';
    expect(sanitizeUserText(text)).toBe('帮我重构这段代码');
  });

  it('同时剥离 Referenced Files 和 Agent Role 段', () => {
    const text = '看看这些文件\n\n## Referenced Files\n\n- `/abs/gradlew`\n\n## Agent Role and Instructions\n\nYou are a reviewer.';
    expect(sanitizeUserText(text)).toBe('看看这些文件');
  });

  it('保留用户自己的 markdown 标题', () => {
    const text = 'intro\n\n## User\'s Current IDE Context\n\nviewing x\n\n## My Own Notes\n\nuser content stays';
    expect(sanitizeUserText(text)).toBe('intro\n\n## My Own Notes\n\nuser content stays');
  });

  it('保留用户主动输入的 @ 引用', () => {
    const text = '帮我看看 @gradlew 这个文件\n\n## IDE Context\n\nActive file: `/abs/gradlew`';
    expect(sanitizeUserText(text)).toBe('帮我看看 @gradlew 这个文件');
  });

  it('所有已知注入段全部剥离', () => {
    const text = 't\n\n## Workspace Context\n\nmulti\n\n## Project Modules\n\n- a\n\n## Active Terminal Session\n\n- T\n\n## Referenced Files\n\n- f\n\n## IDE Context\n\nfile: x\n\n## User\'s Current IDE Context\n\nviewing\n\n## Agent Role and Instructions\n\nrole';
    expect(sanitizeUserText(text)).toBe('t');
  });

  it('清洗幂等', () => {
    const once = sanitizeUserText('a\n\n## IDE Context\n\nx\n\n普通内容');
    expect(sanitizeUserText(once)).toBe(once);
  });

  it('干净文本原样通过', () => {
    const text = '普通消息。## IDE Context 不在行首\n\n## 自定义标题\n\n内容';
    expect(sanitizeUserText(text)).toBe(text);
  });

  it('null/undefined/空输入返回空串', () => {
    expect(sanitizeUserText(null)).toBe('');
    expect(sanitizeUserText(undefined)).toBe('');
    expect(sanitizeUserText('')).toBe('');
  });

  it('只有注入段时清洗为空（历史列表退回占位标题）', () => {
    expect(sanitizeUserText('## IDE Context\n\nActive file: `x`')).toBe('');
  });
});
