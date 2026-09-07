#!/usr/bin/env node
// Extract release notes for a given version, for the GitHub Release body.
//
// Source of truth: CHANGELOG.md. Two section formats are supported:
//  1. `## [0.0.1]` / `## 0.0.1` / `## v0.0.1` (Keep a Changelog style)
//  2. `##### **2026年9月2日（v0.0.1）**` — the format webview/scripts/
//     extract-changelog.mjs parses, with `中文：` and `English：` sub-sections.
//
// Bilingual sections are emitted as: Chinese content, then an `### English`
// heading, then the English content. The in-extension changelog dialog splits
// the release body on that `### English` heading to render one Chinese and one
// English block (see webview/src/version/githubReleases.ts).
//
// If the section is missing or empty, fall back to the git commit log since
// the previous tag (so a release always has some notes).
//
// Output is written to the file given as the 2nd argument (default
// release-notes.md) and also printed to stdout.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const version = process.argv[2];
const outFile = process.argv[3] || 'release-notes.md';

if (!version) {
  console.error('Usage: node tools/extract-release-notes.mjs <version> [outFile]');
  process.exit(1);
}

const cleanVersion = version.replace(/^v/, '');

function extractFromChangelog() {
  const changelogPath = 'CHANGELOG.md';
  if (!existsSync(changelogPath)) return '';
  const text = readFileSync(changelogPath, 'utf8');
  const lines = text.split('\n');

  // Match a heading whose text contains the version (with optional v / brackets).
  const headingRe = new RegExp(
    `^##+\\s*\\[?v?${escapeRegex(cleanVersion)}\\]?\\b`,
    'i'
  );
  // `##### **2026年9月2日（v0.0.1）**` — the extract-changelog.mjs format.
  const boldHeadingRe = new RegExp(
    `^#{2,5}\\s*\\*\\*.*[（(]v?${escapeRegex(cleanVersion)}[）)]`,
    'i'
  );
  // Any bold version header, used to detect where the section ends.
  const nextBoldHeaderRe = /^#{2,5}\s+\*\*.*[（(]v?\d+\.\d+/;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i]) || boldHeadingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';

  const collected = [];
  for (let i = start + 1; i < lines.length; i++) {
    // Stop at the next version heading (either format).
    if (/^##\s/.test(lines[i]) || nextBoldHeaderRe.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return toReleaseBody(collected.join('\n').trim());
}

/**
 * CHANGELOG sections carry `中文：` and `English：` markers. The GitHub release
 * body instead uses an `### English` heading, which the changelog dialog splits
 * on. Sections without both markers pass through unchanged.
 */
function toReleaseBody(section) {
  const enMarker = /^English\s*[:：]\s*$/im.exec(section);
  const zhMarker = /^中文\s*[:：]\s*$/im.exec(section);
  if (!enMarker || !zhMarker) return section;

  const sections = {
    en: enMarker.index < zhMarker.index
      ? sliceBetween(section, enMarker, zhMarker.index)
      : section.slice(enMarker.index + enMarker[0].length),
    zh: zhMarker.index < enMarker.index
      ? sliceBetween(section, zhMarker, enMarker.index)
      : section.slice(zhMarker.index + zhMarker[0].length),
  };

  const zh = sections.zh.trim();
  const en = sections.en.trim();
  return [zh, '### English', en].filter(Boolean).join('\n\n');
}

function sliceBetween(text, marker, endIndex) {
  return text.slice(marker.index + marker[0].length, endIndex);
}

function fallbackFromGit() {
  let range = '';
  try {
    const prev = execSync('git describe --tags --abbrev=0 HEAD^', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (prev) range = `${prev}..HEAD`;
  } catch {
    // No previous tag: use all history.
  }
  try {
    const log = execSync(
      `git log ${range} --pretty=format:"- %s (%h)"`,
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .toString()
      .trim();
    return log || '';
  } catch {
    return '';
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let notes = extractFromChangelog();
let source = 'CHANGELOG.md';
if (!notes) {
  notes = fallbackFromGit();
  source = 'git log';
}
if (!notes) {
  notes = `Release ${version}`;
  source = 'default';
}

const header = `## OpenCode ${version}\n\n`;
const body = header + notes + '\n';

writeFileSync(outFile, body, 'utf8');
console.log(`Release notes (source: ${source}) -> ${outFile}`);
console.log('---');
console.log(body);
console.log('---');
