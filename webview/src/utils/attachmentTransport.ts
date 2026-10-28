import { sendHostCommand } from './bridge';
import type { Attachment } from '../components/ChatInputBox/types';

/**
 * Attachment transport.
 *
 * <p>A base64 image can be megabytes long. Sent inside `session.send` it becomes
 * one bridge frame that size: the frame budget is 32 KB, and a single oversized
 * frame stalls the renderer while the host parses it. The upload is therefore
 * delivered the way the plan describes: announce it, send it in chunks the
 * budget can carry, finish it — then the send itself only names the attachment
 * and the host reads the bytes from the tab's own directory.</p>
 *
 * <p>The commands are fire-and-forget: the bridge delivers them in order, so the
 * host has appended every chunk before it handles the send. Failures come back
 * as `attachment.failed` events.</p>
 */

/** Base64 characters per chunk. 96KB for VS Code postMessage channel. */
export const ATTACHMENT_CHUNK_CHARS = 96 * 1024;

/** Strip the `data:...;base64,` prefix: the host wants bare base64. */
export function bareBase64(data: string | null | undefined): string {
  if (!data) return '';
  const comma = data.indexOf(',');
  return data.startsWith('data:') && comma >= 0 ? data.slice(comma + 1) : data;
}

/** The decoded size of a base64 string, padding included. */
export function decodedSize(base64: string): number {
  if (!base64) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** What the send names once the bytes are on the host. */
export interface UploadedAttachment {
  attachmentId: string;
  fileName: string;
  mediaType: string;
}

/**
 * Upload one attachment to the tab that picked it.
 *
 * @returns the reference the send carries; the bytes never travel with it
 */
export function uploadAttachment(tabId: string, attachment: Attachment): UploadedAttachment {
  const attachmentId = attachment.id;
  const fileName = attachment.fileName;
  const mediaType = attachment.mediaType ?? '';
  const base64 = bareBase64(attachment.data);
  const size = decodedSize(base64);

  sendHostCommand(tabId, 'attachment.prepare', { attachmentId, fileName, mediaType, size });

  let offset = 0;
  for (let index = 0; index < base64.length; index += ATTACHMENT_CHUNK_CHARS) {
    const chunk = base64.slice(index, index + ATTACHMENT_CHUNK_CHARS);
    sendHostCommand(tabId, 'attachment.chunk', { attachmentId, offset, data: chunk });
    offset += decodedSize(chunk);
  }

  sendHostCommand(tabId, 'attachment.complete', { attachmentId });
  return { attachmentId, fileName, mediaType };
}

/** Upload every attachment of a send, in order. */
export function uploadAttachments(
  tabId: string,
  attachments: Attachment[] | undefined,
): UploadedAttachment[] {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  return attachments.map((attachment) => uploadAttachment(tabId, attachment));
}
