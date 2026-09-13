import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  ATTACHMENT_ONLY_FALLBACK_TEXT,
  MAX_ATTACHMENT_BYTES,
  buildFileParts,
  formatInlinedAttachments,
  resolveAttachmentMimeType,
} from './cli-image-input.js';

// 1x1 PNG
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TEXT_B64 = Buffer.from('hello opencode').toString('base64');

describe('buildFileParts', () => {
  it('emits native multimodal parts for images', () => {
    const { parts, textAttachments, errors } = buildFileParts([
      { fileName: 'dot.png', mediaType: 'image/png', data: TINY_PNG_B64 },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(textAttachments.length, 0);
    assert.equal(parts.length, 1);
    assert.deepEqual(Object.keys(parts[0]).sort(), ['filename', 'mime', 'type', 'url']);
    assert.equal(parts[0].type, 'file');
    assert.equal(parts[0].mime, 'image/png');
    assert.equal(parts[0].filename, 'dot.png');
    assert.equal(parts[0].url, `data:image/png;base64,${TINY_PNG_B64}`);
  });

  it('separates text/code files into textAttachments and native media into parts', () => {
    const { parts, textAttachments, errors } = buildFileParts([
      { fileName: 'notes.txt', mediaType: 'text/plain', data: TEXT_B64 },
      { fileName: 'doc.pdf', mediaType: 'application/pdf', data: TEXT_B64 },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].filename, 'doc.pdf');
    assert.equal(parts[0].mime, 'application/pdf');

    assert.equal(textAttachments.length, 1);
    assert.equal(textAttachments[0].fileName, 'notes.txt');
    assert.equal(textAttachments[0].content, 'hello opencode');
    assert.equal(textAttachments[0].mime, 'text/plain');
  });

  it('reads imageData / content fields used by the VS Code host', () => {
    const { parts, textAttachments, errors } = buildFileParts([
      { name: 'shot.png', mediaType: 'image/png', imageData: TINY_PNG_B64 },
      { name: 'a.txt', mediaType: 'text/plain', content: TEXT_B64 },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].filename, 'shot.png');
    assert.equal(textAttachments.length, 1);
    assert.equal(textAttachments[0].fileName, 'a.txt');
    assert.equal(textAttachments[0].content, 'hello opencode');
  });

  it('maps path-only attachments to file:// URLs', () => {
    const { parts, textAttachments, errors } = buildFileParts([
      { name: 'Main.java', path: '/tmp/repo/Main.java', mediaType: '' },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(textAttachments.length, 0);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].url, pathToFileURL('/tmp/repo/Main.java').href);
    assert.equal(parts[0].mime, 'text/plain');
  });

  it('reports skipped attachments instead of dropping them silently', () => {
    const { parts, textAttachments, errors } = buildFileParts([
      { fileName: 'empty.bin', mediaType: 'application/octet-stream', data: '' },
      // 'A' * n is valid base64; decoded size is ~3/4 of n, so overshoot well past the cap.
      { fileName: 'huge.bin', mediaType: 'application/octet-stream', data: 'A'.repeat(MAX_ATTACHMENT_BYTES * 2) },
    ]);
    assert.equal(parts.length, 0);
    assert.equal(textAttachments.length, 0);
    assert.equal(errors.length, 2);
  });

  it('extracts json, code and text files into textAttachments', () => {
    const { parts, textAttachments, errors } = buildFileParts([
      { fileName: 'skills-lock.json', mediaType: 'application/json', data: TEXT_B64 },
      { fileName: 'data.csv', mediaType: 'text/csv', data: TEXT_B64 },
      { fileName: 'pom.xml', mediaType: 'application/xml', data: TEXT_B64 },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(parts.length, 0);
    assert.equal(textAttachments.length, 3);
    assert.equal(textAttachments[0].fileName, 'skills-lock.json');
    assert.equal(textAttachments[1].fileName, 'data.csv');
    assert.equal(textAttachments[2].fileName, 'pom.xml');
  });

  it('rejects unsupported binary files instead of sending corrupt parts', () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64');
    const { parts, textAttachments, errors } = buildFileParts([
      { fileName: 'archive.zip', mediaType: 'application/zip', data: binaryData },
      { fileName: 'compiled.class', mediaType: 'application/octet-stream', data: binaryData },
    ]);
    assert.equal(parts.length, 0);
    assert.equal(textAttachments.length, 0);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /binary files are not supported/);
    assert.match(errors[1], /binary files are not supported/);
  });

  it('returns empty results for no attachments', () => {
    const { parts, textAttachments, errors } = buildFileParts(undefined);
    assert.equal(parts.length, 0);
    assert.equal(textAttachments.length, 0);
    assert.equal(errors.length, 0);
  });
});

describe('formatInlinedAttachments', () => {
  it('formats multiple text attachments into Markdown section', () => {
    const inlined = formatInlinedAttachments([
      { fileName: 'a.txt', content: 'content of a' },
      { fileName: 'b.js', content: 'console.log("b");' },
    ]);
    assert.ok(inlined.includes('## Attached Files'));
    assert.ok(inlined.includes('<attachment filename="a.txt">\ncontent of a\n</attachment>'));
    assert.ok(inlined.includes('<attachment filename="b.js">\nconsole.log("b");\n</attachment>'));
  });

  it('returns empty string when no text attachments', () => {
    assert.equal(formatInlinedAttachments([]), '');
    assert.equal(formatInlinedAttachments(null), '');
  });
});

describe('resolveAttachmentMimeType', () => {
  it('normalizes text-like media types to text/plain', () => {
    assert.equal(resolveAttachmentMimeType('Application/JSON', null, 'a.bin'), 'text/plain');
    assert.equal(resolveAttachmentMimeType('text/csv', null, 'data.csv'), 'text/plain');
    assert.equal(resolveAttachmentMimeType('application/xml', null, 'pom.xml'), 'text/plain');
    assert.equal(resolveAttachmentMimeType('text/markdown', null, 'readme.md'), 'text/plain');
  });

  it('preserves native multimodal types', () => {
    assert.equal(resolveAttachmentMimeType('image/png', null, 'photo.png'), 'image/png');
    assert.equal(resolveAttachmentMimeType('image/jpeg', null, 'photo.jpg'), 'image/jpeg');
    assert.equal(resolveAttachmentMimeType('application/pdf', null, 'doc.pdf'), 'application/pdf');
  });

  it('identifies binary extensions as application/octet-stream', () => {
    assert.equal(resolveAttachmentMimeType('', null, 'archive.zip'), 'application/octet-stream');
    assert.equal(resolveAttachmentMimeType('', null, 'bundle.jar'), 'application/octet-stream');
    assert.equal(resolveAttachmentMimeType('', null, 'binary.exe'), 'application/octet-stream');
  });

  it('falls back to the file extension', () => {
    assert.equal(resolveAttachmentMimeType('', null, 'Main.java'), 'text/plain');
    assert.equal(resolveAttachmentMimeType(null, null, 'a.pdf'), 'application/pdf');
    assert.equal(resolveAttachmentMimeType(null, null, 'skills-lock.json'), 'text/plain');
  });

  it('falls back to text/plain for unknown extensions', () => {
    assert.equal(resolveAttachmentMimeType('', null, 'a.weirdext'), 'text/plain');
    assert.equal(resolveAttachmentMimeType('', null, 'gradlew'), 'text/plain');
  });
});

describe('fallback prompt text', () => {
  it('is defined for attachment-only turns', () => {
    assert.equal(typeof ATTACHMENT_ONLY_FALLBACK_TEXT, 'string');
    assert.ok(ATTACHMENT_ONLY_FALLBACK_TEXT.length > 0);
  });
});
