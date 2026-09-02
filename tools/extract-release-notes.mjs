#!/usr/bin/env node
// Extract release notes for a given version, for the GitHub Release body.
//
// Source of truth: CHANGELOG.md (Keep a Changelog format). We look for a
// section matching the version (e.g. `## [0.0.1]` / `## 0.0.1` / `## v0.0.1`).
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

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';

  const collected = [];
  for (let i = start + 1; i < lines.length; i++) {
    // Stop at the next top-level (##) heading.
    if (/^##\s/.test(lines[i])) break;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
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

const header = `## OpenCode Buddy ${version}\n\n`;
const body = header + notes + '\n';

writeFileSync(outFile, body, 'utf8');
console.log(`Release notes (source: ${source}) -> ${outFile}`);
console.log('---');
console.log(body);
console.log('---');
