/**
 * TabAttachmentStore — 按 tab 归属的附件落盘仓库。
 *
 * 为什么要有它：一张 base64 图片可以有好几 MB，塞进 `session.send` 就是一条同样
 * 大小的桥帧——webview 发不出去、宿主也要解析很久。所以附件走「公告 → 分块 →
 * 完成 → 只发 id」，字节由宿主持有、按 tab 归档，发送时再由宿主读出来交给会话层。
 *
 * 归属规则：`<root>/<tabId>/<attachmentId>-<fileName>`。`attachmentId` 只允许
 * `[A-Za-z0-9_-]`（它是路径的一部分），`fileName` 只取 basename，防路径穿越。
 *
 * 上限：单 tab 32MB（与方案 §11.5 一致）。分块必须按 offset 顺序到达。
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { basename, join } from 'path';
import { PluginFileLogger } from '../util/PluginFileLogger';

export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface AttachmentPrepareInput {
	attachmentId: string;
	fileName: string;
	mediaType: string;
	size: number;
}

export interface ResolvedAttachment {
	path: string;
	fileName: string;
	mediaType: string;
	size: number;
}

interface PendingUpload {
	meta: AttachmentPrepareInput;
	chunks: Buffer[];
	received: number;
}

export interface AttachmentFailure {
	attachmentId: string;
	reason: string;
}

export class TabAttachmentStore {
	private readonly pending = new Map<string, PendingUpload>();
	private readonly ready = new Map<string, ResolvedAttachment>();
	private readonly bytesByTab = new Map<string, number>();

	/** @param root 附件根目录（通常是 `<globalStorage>/attachments`）；null 表示不可用 */
	constructor(private readonly root: string | null) {}

	isAvailable(): boolean {
		return !!this.root;
	}

	/** 已落盘的附件（发送时按 id 查）。 */
	resolve(tabId: string, attachmentId: string): ResolvedAttachment | null {
		const found = this.ready.get(this.key(tabId, attachmentId));
		if (found) {
			return found;
		}
		// 进程重启后内存表为空：按约定路径回查，仍存在则重新登记。
		const guessed = this.pathFor(tabId, attachmentId, attachmentId);
		if (existsSync(guessed)) {
			this.ready.set(this.key(tabId, attachmentId), {
				path: guessed,
				fileName: attachmentId,
				mediaType: '',
				size: 0,
			});
			return this.ready.get(this.key(tabId, attachmentId)) ?? null;
		}
		return null;
	}

	/** 读出附件字节的 base64（发送时内联给 core）。 */
	readBase64(tabId: string, attachmentId: string): string | null {
		const resolved = this.resolve(tabId, attachmentId);
		if (!resolved) {
			return null;
		}
		try {
			return readFileSync(resolved.path).toString('base64');
		} catch (err) {
			PluginFileLogger.warn('TabAttachmentStore', `read failed: ${String(err)}`);
			return null;
		}
	}

	prepare(tabId: string, input: AttachmentPrepareInput): AttachmentFailure | null {
		if (!this.isAvailable()) {
			return { attachmentId: input.attachmentId, reason: '附件目录不可用' };
		}
		if (!SAFE_ID.test(input.attachmentId)) {
			return { attachmentId: input.attachmentId, reason: '附件 id 非法' };
		}
		if (!Number.isFinite(input.size) || input.size < 0) {
			return { attachmentId: input.attachmentId, reason: '附件大小非法' };
		}
		if (input.size > MAX_ATTACHMENT_BYTES) {
			return { attachmentId: input.attachmentId, reason: '单个附件超过 32MB' };
		}
		const used = this.bytesByTab.get(tabId) ?? 0;
		if (used + input.size > MAX_ATTACHMENT_BYTES) {
			return { attachmentId: input.attachmentId, reason: '该会话附件总量超过 32MB' };
		}

		this.pending.set(this.key(tabId, input.attachmentId), {
			meta: {
				attachmentId: input.attachmentId,
				fileName: sanitizeFileName(input.fileName) || input.attachmentId,
				mediaType: input.mediaType || '',
				size: input.size,
			},
			chunks: [],
			received: 0,
		});
		return null;
	}

	/** 追加一块。`offset` 必须是当前已收到的字节数（顺序校验）。 */
	chunk(tabId: string, attachmentId: string, offset: number, base64: string): AttachmentFailure | null {
		const upload = this.pending.get(this.key(tabId, attachmentId));
		if (!upload) {
			return { attachmentId, reason: '未收到 attachment.prepare' };
		}
		if (offset !== upload.received) {
			return {
				attachmentId,
				reason: `分块乱序：期望 ${upload.received}，收到 ${offset}`,
			};
		}
		let buffer: Buffer;
		try {
			buffer = Buffer.from(base64, 'base64');
		} catch {
			return { attachmentId, reason: '分块 base64 解码失败' };
		}
		upload.chunks.push(buffer);
		upload.received += buffer.length;
		if (upload.received > MAX_ATTACHMENT_BYTES) {
			this.pending.delete(this.key(tabId, attachmentId));
			return { attachmentId, reason: '单个附件超过 32MB' };
		}
		return null;
	}

	complete(tabId: string, attachmentId: string): AttachmentFailure | null {
		const key = this.key(tabId, attachmentId);
		const upload = this.pending.get(key);
		if (!upload) {
			return { attachmentId, reason: '未收到 attachment.prepare' };
		}

		const bytes = Buffer.concat(upload.chunks, upload.received);
		if (upload.meta.size > 0 && bytes.length !== upload.meta.size) {
			this.pending.delete(key);
			return {
				attachmentId,
				reason: `附件不完整：声明 ${upload.meta.size}，收到 ${bytes.length}`,
			};
		}

		const path = this.pathFor(tabId, attachmentId, upload.meta.fileName);
		try {
			mkdirSync(join(this.root as string, tabId), { recursive: true });
			writeFileSync(path, bytes);
		} catch (err) {
			this.pending.delete(key);
			return { attachmentId, reason: `写入失败：${String(err)}` };
		}

		this.pending.delete(key);
		this.ready.set(key, {
			path,
			fileName: upload.meta.fileName,
			mediaType: upload.meta.mediaType,
			size: bytes.length,
		});
		this.bytesByTab.set(tabId, (this.bytesByTab.get(tabId) ?? 0) + bytes.length);
		return null;
	}

	abort(tabId: string, attachmentId: string): void {
		this.pending.delete(this.key(tabId, attachmentId));
		const resolved = this.ready.get(this.key(tabId, attachmentId));
		if (resolved) {
			try {
				rmSync(resolved.path, { force: true });
			} catch {
				// 删不掉也不影响后续发送
			}
			this.ready.delete(this.key(tabId, attachmentId));
			this.bytesByTab.set(tabId, Math.max(0, (this.bytesByTab.get(tabId) ?? 0) - resolved.size));
		}
	}

	/** tab 关闭时释放它名下所有附件（临时文件不跨会话留存）。 */
	releaseTab(tabId: string): void {
		const prefix = `${tabId}/`;
		for (const key of [...this.pending.keys()]) {
			if (key.startsWith(prefix)) {
				this.pending.delete(key);
			}
		}
		for (const [key, value] of [...this.ready.entries()]) {
			if (key.startsWith(prefix)) {
				try {
					rmSync(value.path, { force: true });
				} catch {
					// 忽略
				}
				this.ready.delete(key);
			}
		}
		this.bytesByTab.delete(tabId);
		if (this.root) {
			try {
				rmSync(join(this.root, tabId), { recursive: true, force: true });
			} catch {
				// 目录可能本来就不存在
			}
		}
	}

	private key(tabId: string, attachmentId: string): string {
		return `${tabId}/${attachmentId}`;
	}

	private pathFor(tabId: string, attachmentId: string, fileName: string): string {
		return join(this.root as string, tabId, `${attachmentId}-${sanitizeFileName(fileName)}`);
	}
}

/** 只保留 basename，去掉路径分隔符与控制字符。 */
export function sanitizeFileName(fileName: string): string {
	const base = basename((fileName || '').replace(/\\/g, '/'));
	return base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 180);
}
