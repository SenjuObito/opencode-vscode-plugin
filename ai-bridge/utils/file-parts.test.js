/**
 * Unit tests for opencode file-part construction.
 * Run: node --test utils/file-parts.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  ATTACHMENT_ONLY_FALLBACK_TEXT,
  MAX_ATTACHMENT_BYTES,
  buildFileParts,
  resolveAttachmentMimeType,
} from './cli-image-input.js';

// 1x1 PNG
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TEXT_B64 = Buffer.from('hello opencode').toString('base64');

describe('buildFileParts', () => {
  it('emits the opencode FilePartInput shape', () => {
    const { parts, errors } = buildFileParts([
      { fileName: 'dot.png', mediaType: 'image/png', data: TINY_PNG_B64 },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(parts.length, 1);
    assert.deepEqual(Object.keys(parts[0]).sort(), ['filename', 'mime', 'type', 'url']);
    assert.equal(parts[0].type, 'file');
    assert.equal(parts[0].mime, 'image/png');
    assert.equal(parts[0].filename, 'dot.png');
    assert.equal(parts[0].url, `data:image/png;base64,${TINY_PNG_B64}`);
  });

  it('keeps non-image files instead of dropping them', () => {
    const { parts, errors } = buildFileParts([
      { fileName: 'notes.txt', mediaType: 'text/plain', data: TEXT_B64 },
      { fileName: 'doc.pdf', mediaType: 'application/pdf', data: TEXT_B64 },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].mime, 'text/plain');
    assert.equal(parts[1].mime, 'application/pdf');
  });

  it('reads imageData / content fields used by the VS Code host', () => {
    const { parts, errors } = buildFileParts([
      { name: 'shot.png', mediaType: 'image/png', imageData: TINY_PNG_B64 },
      { name: 'a.txt', mediaType: 'text/plain', content: TEXT_B64 },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].filename, 'shot.png');
    assert.equal(parts[1].filename, 'a.txt');
  });

  it('maps path-only attachments to file:// URLs', () => {
    const { parts, errors } = buildFileParts([
      { name: 'Main.java', path: '/tmp/repo/Main.java', mediaType: '' },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].url, pathToFileURL('/tmp/repo/Main.java').href);
    assert.equal(parts[0].mime, 'text/plain');
  });

  it('reports skipped attachments instead of dropping them silently', () => {
    const { parts, errors } = buildFileParts([
      { fileName: 'empty.bin', mediaType: 'application/octet-stream', data: '' },
      // 'A' * n is valid base64; decoded size is ~3/4 of n, so overshoot well past the cap.
      { fileName: 'huge.bin', mediaType: 'application/octet-stream', data: 'A'.repeat(MAX_ATTACHMENT_BYTES * 2) },
    ]);
    assert.equal(parts.length, 0);
    assert.equal(errors.length, 2);
  });

  it('returns empty results for no attachments', () => {
    const { parts, errors } = buildFileParts(undefined);
    assert.equal(parts.length, 0);
    assert.equal(errors.length, 0);
  });
});

describe('resolveAttachmentMimeType', () => {
  it('prefers the explicit media type', () => {
    assert.equal(resolveAttachmentMimeType('Application/JSON', null, 'a.bin'), 'application/json');
  });

  it('falls back to the file extension', () => {
    assert.equal(resolveAttachmentMimeType('', null, 'Main.java'), 'text/plain');
    assert.equal(resolveAttachmentMimeType(null, null, 'a.pdf'), 'application/pdf');
  });

  it('falls back to text/plain for unknown extensions', () => {
    assert.equal(resolveAttachmentMimeType('', null, 'a.weirdext'), 'text/plain');
  });
});

describe('fallback prompt text', () => {
  it('is defined for attachment-only turns', () => {
    assert.equal(typeof ATTACHMENT_ONLY_FALLBACK_TEXT, 'string');
    assert.ok(ATTACHMENT_ONLY_FALLBACK_TEXT.length > 0);
  });
});
