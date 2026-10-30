import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendWindowCommandMock = vi.fn();

vi.mock('./bridge', () => ({
  sendWindowCommand: (...args: unknown[]) => sendWindowCommandMock(...(args as [])),
}));

import { downloadJSON, downloadMarkdown } from './exportMarkdown';

describe('exportMarkdown', () => {
  beforeEach(() => {
    sendWindowCommandMock.mockReset();
    // The host path is taken when the legacy bridge global exists.
    (window as unknown as { sendToJava?: unknown }).sendToJava = vi.fn();
  });

  afterEach(() => {
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
  });

  it('sends markdown as an object payload so the host can read content', () => {
    downloadMarkdown('# Hello\n\nbody', 'My Session');

    expect(sendWindowCommandMock).toHaveBeenCalledTimes(1);
    expect(sendWindowCommandMock).toHaveBeenCalledWith('save_json', {
      content: '# Hello\n\nbody',
      filename: 'My Session.md',
    });
  });

  it('keeps the .md extension and sanitizes the filename', () => {
    downloadMarkdown('body', 'a/b:c');

    expect(sendWindowCommandMock).toHaveBeenCalledWith('save_json', {
      content: 'body',
      filename: 'a_b_c.md',
    });
  });

  it('sends json as an object payload with a .json filename', () => {
    downloadJSON('{"a":1}', 'session');

    expect(sendWindowCommandMock).toHaveBeenCalledWith('save_json', {
      content: '{"a":1}',
      filename: 'session.json',
    });
  });
});
