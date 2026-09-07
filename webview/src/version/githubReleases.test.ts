import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGithubReleases, splitBilingualReleaseBody } from './githubReleases';

describe('fetchGithubReleases', () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('returns an empty list (never cc-gui history) when the repo has no releases', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const result = await fetchGithubReleases();

    expect(result.entries).toEqual([]);
    expect(result.empty).toBe(true);
    expect(result.error).toBe('no releases');
  });

  it('returns parsed releases when the repo publishes them', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { tag_name: 'v1.2.0', body: '## Changes\n- fixed', published_at: '2026-08-01T00:00:00Z' },
      ],
    } as Response);

    const result = await fetchGithubReleases();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].version).toBe('1.2.0');
    // Single-language body: kept as `zh` only so the dialog renders it once
    // instead of duplicating the same text in both the zh and en sections.
    expect(result.entries[0].content.zh).toContain('fixed');
    expect(result.entries[0].content.en).toBe('');
    expect(result.empty).toBeFalsy();
  });

  it('splits a bilingual body on the `### English` heading', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          tag_name: 'v1.2.0',
          body: '## Changes\n- 修复了问题\n\n### English\n\n## Changes\n- fixed',
          published_at: '2026-08-01T00:00:00Z',
        },
      ],
    } as Response);

    const result = await fetchGithubReleases();

    expect(result.entries[0].content.zh).toContain('修复了问题');
    expect(result.entries[0].content.en).toContain('fixed');
    expect(result.entries[0].content.zh).not.toContain('fixed');
  });

  it('returns an empty list with an error (no cc-gui fallback) when the request fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('CSP blocked'));

    const result = await fetchGithubReleases();

    expect(result.entries).toEqual([]);
    expect(result.error).toBe('CSP blocked');
  });
});

describe('splitBilingualReleaseBody', () => {
  it('splits on an `### English` heading at any level', () => {
    const { en, zh } = splitBilingualReleaseBody('中文内容\n#### English\nEnglish content');
    expect(zh).toBe('中文内容');
    expect(en).toBe('English content');
  });

  it('keeps a single-language body as zh only', () => {
    const { en, zh } = splitBilingualReleaseBody('只有中文');
    expect(zh).toBe('只有中文');
    expect(en).toBe('');
  });

  it('is case-insensitive on the marker', () => {
    const { en, zh } = splitBilingualReleaseBody('中文\n### english\nEnglish');
    expect(zh).toBe('中文');
    expect(en).toBe('English');
  });
});
