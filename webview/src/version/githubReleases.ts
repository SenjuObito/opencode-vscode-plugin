/**
 * Shared GitHub releases fetcher for the first-start / version-update
 * changelog dialog and the Settings → Community version history button.
 *
 * Hybrid Fallback Strategy:
 *  1. Cache: Return valid cached releases if fresh.
 *  2. Online: Fetch releases from GitHub Releases API.
 *  3. Fallback: If repo has no releases yet OR fetch fails (offline/timeout/rate-limit),
 *     automatically fall back to the bundled CHANGELOG_DATA generated from CHANGELOG.md.
 */

import { CHANGELOG_DATA, type ChangelogEntry } from './changelog';

export const GITHUB_REPO_OWNER = 'SenjuObito';
export const GITHUB_REPO_NAME = 'opencode-idea-gui';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}.git`;
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases`;
/** Hard cap so a hanging request cannot leave the dialog spinning forever. */
const RELEASES_TIMEOUT_MS = 10_000;

const RELEASES_CACHE_KEY = 'opencode.releases.cache';
const RELEASES_CACHE_TS_KEY = 'opencode.releases.cacheTs';
const RELEASES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ReleasesCache {
  entries: ChangelogEntry[];
  ts: number;
}

function readCache(): ReleasesCache | null {
  try {
    const raw = window.localStorage.getItem(RELEASES_CACHE_KEY);
    const tsRaw = window.localStorage.getItem(RELEASES_CACHE_TS_KEY);
    if (!raw || !tsRaw) return null;
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Date.now() - ts > RELEASES_CACHE_TTL_MS) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return { entries: parsed as ChangelogEntry[], ts };
  } catch {
    return null;
  }
}

function writeCache(entries: ChangelogEntry[]): void {
  try {
    window.localStorage.setItem(RELEASES_CACHE_KEY, JSON.stringify(entries));
    window.localStorage.setItem(RELEASES_CACHE_TS_KEY, String(Date.now()));
  } catch {
    // ignore storage errors
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseReleases(data: unknown): ChangelogEntry[] {
  const list = Array.isArray(data) ? data : [];
  const entries: ChangelogEntry[] = [];
  for (const release of list) {
    if (!isPlainObject(release)) continue;
    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    const body = typeof release.body === 'string' ? release.body : '';
    const published = typeof release.published_at === 'string' ? release.published_at : '';
    if (!tag) continue;
    const version = tag.replace(/^v/, '');
    entries.push({
      version,
      date: published.slice(0, 10),
      content: { en: body, zh: body },
    });
  }
  return entries;
}

export interface FetchReleasesResult {
  entries: ChangelogEntry[];
  fromCache: boolean;
  fromFallback?: boolean;
  /** Set when the remote list could not be fetched (network / HTTP / timeout). */
  error?: string;
  /** True when no releases were found online and fallback is empty. */
  empty?: boolean;
}

/**
 * Fetch releases from the configured GitHub repository with local CHANGELOG_DATA fallback.
 *
 * 1. Checks localStorage cache.
 * 2. Fetches remote GitHub releases.
 * 3. Falls back to bundled CHANGELOG_DATA on error or when repo has 0 releases.
 */
export async function fetchGithubReleases(): Promise<FetchReleasesResult> {
  const cached = readCache();
  if (cached && cached.entries.length > 0) {
    return { entries: cached.entries, fromCache: true };
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), RELEASES_TIMEOUT_MS)
    : null;

  try {
    const resp = await fetch(GITHUB_RELEASES_API, {
      ...(controller ? { signal: controller.signal } : {}),
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) {
      throw new Error(`GitHub API ${resp.status}`);
    }
    const data = (await resp.json()) as unknown;
    const entries = parseReleases(data);
    if (entries.length > 0) {
      writeCache(entries);
      return { entries, fromCache: false };
    }
    // Request succeeded but the repo has no online releases yet: fall back to local changelog
    return {
      entries: CHANGELOG_DATA.length > 0 ? CHANGELOG_DATA : [],
      fromCache: false,
      fromFallback: true,
      empty: CHANGELOG_DATA.length === 0,
    };
  } catch (err) {
    // Network offline / rate-limited / timed out / CSP-blocked: fall back to local changelog
    const message = err instanceof Error ? err.message : String(err);
    return {
      entries: CHANGELOG_DATA.length > 0 ? CHANGELOG_DATA : [],
      fromCache: false,
      fromFallback: true,
      error: message,
      empty: CHANGELOG_DATA.length === 0,
    };
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

/** Invalidate the cached releases list (e.g. after a version bump). */
export function clearReleasesCache(): void {
  try {
    window.localStorage.removeItem(RELEASES_CACHE_KEY);
    window.localStorage.removeItem(RELEASES_CACHE_TS_KEY);
  } catch {
    // ignore
  }
}
