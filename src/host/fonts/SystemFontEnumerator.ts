/**
 * SystemFontEnumerator — 纯 Node 枚举系统已安装字体族名（A2 方案）。
 *
 * VS Code 扩展 API 与 webview（Permissions Policy 禁用 local-fonts）都无法
 * 枚举系统字体，因此直接扫描 OS 字体目录，解析 sfnt 容器的 `name` 表提取
 * 字体族名：
 *   - 优先 nameID=16（Typographic Family），回退 nameID=1（Family）
 *   - 同一文件多条记录时优先 Windows 平台（platformID=3, UTF-16BE），
 *     其次 Macintosh（platformID=1, ASCII）
 *   - .ttc 集合逐个子字体解析
 *
 * 结果按字母排序并进程内缓存。个别损坏/非 sfnt 字体文件静默跳过。
 */
import { readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface FontDirs {
	system: string[];
	user: string[];
}

function fontDirectories(): FontDirs {
	switch (process.platform) {
		case 'darwin':
			return {
				system: ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts'],
				user: [join(homedir(), 'Library', 'Fonts')],
			};
		case 'win32': {
			const systemRoot = process.env.SystemRoot || 'C:\\Windows';
			const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
			return {
				system: [join(systemRoot, 'Fonts')],
				user: [join(localAppData, 'Microsoft', 'Windows', 'Fonts')],
			};
		}
		default:
			return {
				system: ['/usr/share/fonts', '/usr/local/share/fonts'],
				user: [join(homedir(), '.local', 'share', 'fonts'), join(homedir(), '.fonts')],
			};
	}
}

/** 从 TTF/OTF/TTC 字节中提取全部字体族名；解析失败返回空数组。 */
export function extractFamilyNames(bytes: Buffer): string[] {
	try {
		if (bytes.length < 12) {
			return [];
		}
		const tag = bytes.toString('latin1', 0, 4);
		if (tag === 'ttcf') {
			// TrueType Collection：遍历目录里的每个子字体偏移。
			// TTC 中 table offset 是相对于 TTC 文件开头的绝对偏移，
			// 不能用 bytes.subarray(offset)（会导致内部偏移全部错位）。
			const count = bytes.readUInt32BE(8);
			const families: string[] = [];
			for (let i = 0; i < count; i++) {
				const fontOffset = bytes.readUInt32BE(12 + i * 4);
				if (fontOffset + 12 > bytes.length) { continue; }
				families.push(...readSfntFamilies(bytes, fontOffset));
			}
			return families;
		}
		if (tag === '\x00\x01\x00\x00' || tag === 'OTTO' || tag === 'true') {
			return readSfntFamilies(bytes, 0);
		}
	} catch {
		// 损坏文件：跳过
	}
	return [];
}

/**
 * 解析单个 sfnt 字体的 name 表，返回候选族名（可能为空）。
 * `base` 是该字体的 sfnt 头部在 `data` 中的偏移（TTF/OTF 为 0，TTC 为子字体偏移）。
 * TTC 中 table directory 的 offset 字段是相对于 TTC 文件开头的绝对偏移。
 */
function readSfntFamilies(data: Buffer, base: number): string[] {
	if (base + 12 > data.length) {
		return [];
	}
	const numTables = data.readUInt16BE(base + 4);
	let nameTblOffset = -1;
	for (let i = 0; i < numTables; i++) {
		const rec = base + 12 + i * 16;
		if (rec + 16 > data.length) { return []; }
		if (data.toString('latin1', rec, rec + 4) === 'name') {
			nameTblOffset = data.readUInt32BE(rec + 8);
			break;
		}
	}
	if (nameTblOffset < 0 || nameTblOffset + 6 > data.length) {
		return [];
	}

	const count = data.readUInt16BE(nameTblOffset + 2);
	const storageOffset = nameTblOffset + data.readUInt16BE(nameTblOffset + 4);

	// 记录 (nameID 权重, 平台权重, 值)，最后取每个 family 槽位的最优记录
	type Rec = { nameId: number; platformWeight: number; value: string };
	const best = new Map<number, Rec>();
	for (let i = 0; i < count; i++) {
		const rec = nameTblOffset + 6 + i * 12;
		if (rec + 12 > data.length) { break; }
		const platformId = data.readUInt16BE(rec);
		const encodingId = data.readUInt16BE(rec + 2);
		const nameId = data.readUInt16BE(rec + 6);
		if (nameId !== 16 && nameId !== 1) { continue; }
		const length = data.readUInt16BE(rec + 8);
		const offset = data.readUInt16BE(rec + 10);
		const strStart = storageOffset + offset;
		if (strStart + length > data.length) { continue; }

		let value: string | null = null;
		if (platformId === 3 || platformId === 0) {
			// Windows / Unicode：UTF-16BE
			value = decodeUtf16Be(data.subarray(strStart, strStart + length));
		} else if (platformId === 1 && encodingId === 0) {
			// Macintosh Roman：ASCII 兼容段
			value = data.toString('latin1', strStart, strStart + length);
		}
		if (!value || value.trim() === '') { continue; }

		// Windows 记录优先于 Mac 记录；同平台取先出现的
		const platformWeight = platformId === 1 ? 1 : 0;
		const prev = best.get(nameId);
		if (!prev || platformWeight < prev.platformWeight) {
			best.set(nameId, { nameId, platformWeight, value: value.trim() });
		}
	}

	const families: string[] = [];
	const typographic = best.get(16)?.value;
	const legacy = best.get(1)?.value;
	if (typographic) { families.push(typographic); }
	if (legacy && legacy !== typographic) { families.push(legacy); }
	return families;
}

function decodeUtf16Be(bytes: Buffer): string {
	let out = '';
	for (let i = 0; i + 1 < bytes.length; i += 2) {
		out += String.fromCharCode(bytes.readUInt16BE(i));
	}
	return out;
}

/**
 * 是否为可提供给用户选择的字体族名。
 * macOS 等平台存在大量 `.` 开头的隐藏系统字体（如 .AppleSystemUIFont、
 * .SF NS Text、.Helvetica Neue DeskInterface），它们是系统内部别名，
 * 不应出现在设置页的字体下拉框中。
 */
export function isUserVisibleFontFamily(name: string): boolean {
	return name.trim() !== '' && !name.startsWith('.');
}

let cachedFamilies: string[] | null = null;

/** 列出系统全部字体族名（去重、排序、缓存）。失败时抛出原始错误。 */
export function listSystemFontFamilies(): string[] {
	if (cachedFamilies) {
		return cachedFamilies;
	}

	const dirs = fontDirectories();
	const seen = new Set<string>();
	const families: string[] = [];

	const MAX_DEPTH = 5;
	const walk = (dir: string, depth: number): void => {
		if (depth > MAX_DEPTH) { return; }
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // 目录不存在 / 无权限：正常忽略
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile() || !/\.(ttf|otf|ttc)$/i.test(entry.name)) {
				continue;
			}
			try {
				const bytes = readFileSync(join(dir, entry.name));
				for (const family of extractFamilyNames(bytes)) {
					if (!isUserVisibleFontFamily(family)) {
						continue;
					}
					const key = family.toLowerCase();
					if (!seen.has(key)) {
						seen.add(key);
						families.push(family);
					}
				}
			} catch {
				// 单个文件读取失败：跳过
			}
		}
	};

	for (const dir of [...dirs.system, ...dirs.user]) {
		walk(dir, 0);
	}

	families.sort((a, b) => a.localeCompare(b));
	cachedFamilies = families;
	console.log(`[SystemFontEnumerator] found ${families.length} font families`);
	return families;
}
