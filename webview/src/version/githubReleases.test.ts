import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GITHUB_REPO_OWNER,
  GITHUB_REPO_NAME,
  GITHUB_REPO_URL,
  GITHUB_RELEASES_API,
  fetchGithubReleases,
  clearReleasesCache,
} from './githubReleases';
import { CHANGELOG_DATA } from './changelog';

describe('githubReleases repository constants', () => {
  it('points to the correct opencode-vscode-plugin GitHub repository', () => {
    expect(GITHUB_REPO_OWNER).toBe('SenjuObito');
    expect(GITHUB_REPO_NAME).toBe('opencode-vscode-plugin');
    expect(GITHUB_REPO_URL).toBe('https://github.com/SenjuObito/opencode-vscode-plugin.git');
    expect(GITHUB_RELEASES_API).toBe(
      'https://api.github.com/repos/SenjuObito/opencode-vscode-plugin/releases'
    );
  });
});

describe('fetchGithubReleases logic & fallback', () => {
  const ORIGINAL_FETCH = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('falls back to bundled CHANGELOG_DATA when the repo has no online releases (empty array)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const result = await fetchGithubReleases();

    expect(result.fromFallback).toBe(true);
    expect(result.fromCache).toBe(false);
    expect(result.entries).toEqual(CHANGELOG_DATA);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.empty).toBeFalsy();
  });

  it('returns parsed releases and writes to cache when online releases exist', async () => {
    const mockReleases = [
      {
        tag_name: 'v0.0.3',
        body: '### Features\n- Fix subagents',
        published_at: '2026-09-06T12:00:00Z',
      },
      {
        tag_name: '0.0.2',
        body: 'Bugfixes',
        published_at: '2026-09-04T10:00:00Z',
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockReleases,
    } as Response);

    const result = await fetchGithubReleases();

    expect(result.fromCache).toBe(false);
    expect(result.fromFallback).toBeFalsy();
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].version).toBe('0.0.3');
    expect(result.entries[0].date).toBe('2026-09-06');
    expect(result.entries[0].content.zh).toBe('### Features\n- Fix subagents');
    expect(result.entries[1].version).toBe('0.0.2');

    // Subsequent call should hit cache without calling fetch again
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const cachedResult = await fetchGithubReleases();

    expect(cachedResult.fromCache).toBe(true);
    expect(cachedResult.entries).toEqual(result.entries);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('splits a bilingual release body into one zh block and one en block', async () => {
    // Shape emitted by tools/extract-release-notes.mjs: `[zh, '### English', en]`,
    // prefixed with a `## OpenCode <version>` header.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          tag_name: 'v0.0.3',
          body: '## OpenCode 0.0.3\n\n- 中文条目 (abc1234)\n\n### English\n\n- english item (abc1234)',
          published_at: '2026-09-06T12:00:00Z',
        },
      ],
    } as Response);

    const result = await fetchGithubReleases();
    const { zh, en } = result.entries[0].content;

    // The generated version heading is dropped — the dialog header already shows it.
    expect(zh).toBe('- 中文条目 (abc1234)');
    expect(en).toBe('- english item (abc1234)');
    // Distinct halves: assigning the whole body to both fields rendered it twice.
    expect(zh).not.toBe(en);
  });

  it('does not duplicate a release body that has no ### English marker', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ tag_name: 'v0.0.4', body: '- 只有中文', published_at: '2026-09-08' }],
    } as Response);

    const result = await fetchGithubReleases();
    const { zh, en } = result.entries[0].content;

    // Falls back to a single block rather than repeating the body.
    expect(zh).toBe('- 只有中文');
    expect(en).toBe('');
  });

  it('falls back to bundled CHANGELOG_DATA when GitHub returns HTTP 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response);

    const result = await fetchGithubReleases();

    expect(result.fromFallback).toBe(true);
    expect(result.fromCache).toBe(false);
    expect(result.entries).toEqual(CHANGELOG_DATA);
    expect(result.error).toBe('GitHub API 404');
  });

  it('falls back to bundled CHANGELOG_DATA with error info when network request fails (offline / CSP)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

    const result = await fetchGithubReleases();

    expect(result.fromFallback).toBe(true);
    expect(result.fromCache).toBe(false);
    expect(result.entries).toEqual(CHANGELOG_DATA);
    expect(result.error).toBe('Network offline');
  });

  it('clearReleasesCache removes cached entries so fresh request is made', async () => {
    localStorage.setItem(
      'opencode.releases.cache',
      JSON.stringify([{ version: '9.9.9', date: '2026-01-01', content: { en: 'cached', zh: 'cached' } }])
    );
    localStorage.setItem('opencode.releases.cacheTs', String(Date.now()));

    // Verify cache is read
    const cachedResult = await fetchGithubReleases();
    expect(cachedResult.fromCache).toBe(true);
    expect(cachedResult.entries[0].version).toBe('9.9.9');

    // Clear cache
    clearReleasesCache();

    // Now fetch should be called again
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ tag_name: 'v1.0.0', body: 'fresh', published_at: '2026-09-01' }],
    } as Response);

    const freshResult = await fetchGithubReleases();
    expect(freshResult.fromCache).toBe(false);
    expect(freshResult.entries[0].version).toBe('1.0.0');
  });
});
