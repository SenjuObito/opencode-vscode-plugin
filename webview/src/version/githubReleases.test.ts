import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGithubReleases } from './githubReleases';

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
    expect(result.entries[0].content.en).toContain('fixed');
    expect(result.empty).toBeFalsy();
  });

  it('returns an empty list with an error (no cc-gui fallback) when the request fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('CSP blocked'));

    const result = await fetchGithubReleases();

    expect(result.entries).toEqual([]);
    expect(result.error).toBe('CSP blocked');
  });
});
