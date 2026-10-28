// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_CHUNK_CHARS,
  bareBase64,
  decodedSize,
  uploadAttachment,
  uploadAttachments,
} from './attachmentTransport';
import type { Attachment } from '../components/ChatInputBox/types';

/** The commands the webview sent, as envelopes. */
const sentEnvelopes = () => ((window.sendToJava as unknown as ReturnType<typeof vi.fn>).mock.calls)
  .map((call: unknown[]) => call[0] as string)
  .filter((call: string) => call.startsWith('host_command:'))
  .map((call: string) => JSON.parse(call.substring('host_command:'.length)));

const attachment = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: 'att-1',
  fileName: 'shot.png',
  mediaType: 'image/png',
  data: Buffer.from('hello opencode').toString('base64'),
  ...overrides,
});

describe('attachment transport', () => {
  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  afterEach(() => {
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
  });

  it('strips the data URL prefix so every chunk decodes on its own', () => {
    expect(bareBase64('data:image/png;base64,AAAA')).toBe('AAAA');
    expect(bareBase64('AAAA')).toBe('AAAA');
    expect(bareBase64(null)).toBe('');
  });

  it('counts decoded bytes including padding', () => {
    expect(decodedSize('')).toBe(0);
    expect(decodedSize('AAAA')).toBe(3);
    expect(decodedSize('AAA=')).toBe(2);
    expect(decodedSize('AA==')).toBe(1);
  });

  it('announces, chunks and finishes one upload', () => {
    const file = attachment();
    const uploaded = uploadAttachment('tab-1', file);

    const envelopes = sentEnvelopes();
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      'attachment.prepare',
      'attachment.chunk',
      'attachment.complete',
    ]);
    // The send names the attachment; the bytes never travel with it.
    expect(uploaded).toEqual({
      attachmentId: 'att-1',
      fileName: 'shot.png',
      mediaType: 'image/png',
    });
    expect(envelopes[0].payload).toEqual({
      attachmentId: 'att-1',
      fileName: 'shot.png',
      mediaType: 'image/png',
      size: 14,
    });
    expect(envelopes[1].payload.offset).toBe(0);
    expect(envelopes[1].payload.data).toBe(file.data);
    expect(envelopes.every((envelope) => envelope.tabId === 'tab-1')).toBe(true);
  });

  it('splits a large upload into chunks the frame budget can carry', () => {
    // 200 KB of base64 is far past the 32 KB frame budget.
    const big = Buffer.alloc(150 * 1024, 7).toString('base64');
    uploadAttachment('tab-1', attachment({ data: big }));

    const chunks = sentEnvelopes().filter((envelope) => envelope.type === 'attachment.chunk');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.payload.data.length).toBeLessThanOrEqual(ATTACHMENT_CHUNK_CHARS);
      // A chunk must be a whole number of base64 quanta, or the host cannot
      // decode it on its own.
      expect(chunk.payload.data.length % 4).toBe(0);
    }
    // The offsets must add up to the decoded size of the whole file.
    const last = chunks[chunks.length - 1];
    const lastBytes = decodedSize(last.payload.data as string);
    expect((last.payload.offset as number) + lastBytes).toBe(decodedSize(big));
    // The reconstruction is the original bytes.
    const rejoined = chunks.map((chunk) => Buffer.from(chunk.payload.data as string, 'base64'));
    expect(Buffer.concat(rejoined).toString('base64')).toBe(big);
  });

  it('uploads every attachment in order and keeps the send payload small', () => {
    const uploaded = uploadAttachments('tab-1', [
      attachment({ id: 'a', fileName: 'a.txt', mediaType: 'text/plain' }),
      attachment({ id: 'b', fileName: 'b.txt', mediaType: 'text/plain' }),
    ]);
    expect(uploaded.map((item) => item.attachmentId)).toEqual(['a', 'b']);
    expect(JSON.stringify(uploaded)).not.toContain('data');
  });

  it('sends nothing for an empty attachment list', () => {
    expect(uploadAttachments('tab-1', undefined)).toEqual([]);
    expect(uploadAttachments('tab-1', [])).toEqual([]);
    expect(sentEnvelopes()).toEqual([]);
  });
});
