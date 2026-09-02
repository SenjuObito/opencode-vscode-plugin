/**
 * FontConfigHandler — 字体配置桥（VS Code 版）。
 *
 * 对应 JetBrains 插件里由 Java 端直接读取 IDE 字体的部分。webview 侧的
 * 接收回调（applyIdeaFontConfig / onEditorFontConfigReceived /
 * applyUiFontConfig / applyCodeFontConfig）原样复用，本 handler 负责：
 *
 *   get_editor_font_config   → 读 editor.fontFamily/fontSize/lineHeight，
 *                              回推 onEditorFontConfigReceived + applyIdeaFontConfig
 *   get_vscode_font_list     → 解析 editor.fontFamily 为字体名列表，
 *                              回推 onVscodeFontListReceived
 *   get/set_ui_font_config   → UI 字体（followEditor = VS Code workbench 栈）
 *   get/set_code_font_config → 代码字体（followEditor = editor.fontFamily）
 *   browse_ui/code_font_file → showOpenDialog 选字体文件并加载
 *
 * 持久化走 SettingsService 的全局 store（键 uiFontConfig / codeFontConfig）。
 */
import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import { basename, extname } from 'path';

import { BaseMessageHandler } from '../router/MessageHandler';
import { HandlerContext } from '../router/HandlerContext';
import { SettingsService } from '../settings/SettingsService';
import { listSystemFontFamilies } from '../fonts/SystemFontEnumerator';

const SUPPORTED_TYPES = [
	'get_editor_font_config',
	'get_vscode_font_list',
	'get_system_font_list',
	'get_ui_font_config',
	'set_ui_font_config',
	'get_code_font_config',
	'set_code_font_config',
	'browse_ui_font_file',
	'browse_code_font_file',
];

/** VS Code workbench 默认 UI 字体栈（无 UI 字体设置项，取系统栈）。 */
const VSCODE_UI_FONT_FAMILY = '-apple-system';
const VSCODE_UI_FALLBACKS = ['BlinkMacSystemFont', 'Segoe WPC', 'Segoe UI', 'system-ui'];

const GENERIC_FONT_KEYWORDS = new Set([
	'monospace', 'sans-serif', 'serif', 'cursive', 'fantasy',
	'system-ui', '-apple-system', 'ui-monospace', 'ui-sans-serif',
	'inherit', 'initial',
]);

interface StoredFontSelection {
	mode: 'followEditor' | 'named' | 'customFile';
	fontFamily?: string;
	customFontPath?: string;
}

interface EffectiveFontConfig {
	mode: StoredFontSelection['mode'];
	effectiveMode: 'followEditor' | 'customFile';
	customFontPath?: string;
	fontFamily: string;
	displayName?: string;
	fontSize: number;
	lineSpacing: number;
	fallbackFonts?: string[];
	fontBase64?: string;
	fontFormat?: 'truetype' | 'opentype';
	warningCode?: 'fontUnavailable';
}

export class FontConfigHandler extends BaseMessageHandler {
	constructor(context: HandlerContext) {
		super(context);
	}

	getSupportedTypes(): string[] {
		return SUPPORTED_TYPES;
	}

	handle(type: string, content: string): boolean {
		switch (type) {
			case 'get_editor_font_config':
				this.pushEditorFontConfig();
				return true;
			case 'get_vscode_font_list':
				this.pushFontList();
				return true;
			case 'get_system_font_list':
				this.pushSystemFontList();
				return true;
			case 'get_ui_font_config':
				this.pushResolvedFont('ui');
				return true;
			case 'set_ui_font_config':
				this.handleSetSelection('ui', content);
				return true;
			case 'get_code_font_config':
				this.pushResolvedFont('code');
				return true;
			case 'set_code_font_config':
				this.handleSetSelection('code', content);
				return true;
			case 'browse_ui_font_file':
				void this.browseFontFile('ui');
				return true;
			case 'browse_code_font_file':
				void this.browseFontFile('code');
				return true;
			default:
				return false;
		}
	}

	// ── 面板就绪时的初始推送 ─────────────────────────────────────────────

	private settings(): SettingsService {
		return this.context.getSettingsService();
	}

	/** webview 就绪后推送全部字体状态（editor / ui / code / 列表）。 */
	pushInitialConfig(): void {
		this.pushEditorFontConfig();
		this.pushFontList();
		this.pushSystemFontList();
		this.pushResolvedFont('ui');
		this.pushResolvedFont('code');
	}

	// ── VS Code 编辑器字体读取 ───────────────────────────────────────────

	private editorConfig(): { fontFamily: string; fontSize: number; lineHeight: number } {
		const cfg = vscode.workspace.getConfiguration('editor');
		const fontFamily = cfg.get<string>('fontFamily') ?? '';
		const fontSize = cfg.get<number>('fontSize') ?? 14;
		const lineHeight = cfg.get<number>('lineHeight') ?? 0;
		return { fontFamily, fontSize, lineHeight };
	}

	/** 解析 editor.fontFamily（如 `Menlo, Monaco, 'Courier New', monospace`）为字体名列表。 */
	static parseFontFamilyList(raw: string): string[] {
		const names: string[] = [];
		for (const part of raw.split(',')) {
			const name = part.trim().replace(/^['"]+|['"]+$/g, '').trim();
			if (!name || GENERIC_FONT_KEYWORDS.has(name.toLowerCase())) {
				continue;
			}
			if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) {
				names.push(name);
			}
		}
		return names;
	}

	private fontList(): string[] {
		const list = FontConfigHandler.parseFontFamilyList(this.editorConfig().fontFamily);
		return list.length > 0 ? list : [];
	}

	private lineSpacing(fontSize: number): number {
		const lineHeight = this.editorConfig().lineHeight;
		return lineHeight > 0 ? lineHeight / Math.max(fontSize, 1) : 1.5;
	}

	private pushEditorFontConfig(): void {
		const { fontFamily, fontSize } = this.editorConfig();
		const names = this.fontList();
		const primary = names[0] ?? (fontFamily.trim() !== '' ? fontFamily.trim() : 'monospace');
		const config = {
			fontFamily: primary,
			fontSize,
			lineSpacing: this.lineSpacing(fontSize),
			fallbackFonts: names.slice(1),
		};
		this.callJavaScript('onEditorFontConfigReceived', JSON.stringify(config));
		// main.tsx 的 applyEditorTypographyConfig 接收对象而非 JSON 字符串。
		this.callJavaScript('applyIdeaFontConfig', config as unknown as string);
	}

	private pushFontList(): void {
		this.callJavaScript('onVscodeFontListReceived', JSON.stringify({ fonts: this.fontList() }));
	}

	private pushSystemFontList(): void {
		try {
			const fonts = listSystemFontFamilies();
			this.callJavaScript('onSystemFontListReceived', JSON.stringify({ fonts, source: 'host' }));
		} catch (err) {
			console.warn(`[FontConfigHandler] system font enumeration failed: ${String(err)}`);
			this.callJavaScript('onSystemFontListReceived', JSON.stringify({ fonts: [], error: String(err) }));
		}
	}

	// ── 选择持久化 + 生效配置解析 ────────────────────────────────────────

	private selectionKey(kind: 'ui' | 'code'): string {
		return kind === 'ui' ? 'uiFontConfig' : 'codeFontConfig';
	}

	private getStoredSelection(kind: 'ui' | 'code'): StoredFontSelection {
		const raw = this.settings().getStore().getGlobal(this.selectionKey(kind));
		if (raw && typeof raw === 'object' && typeof (raw as StoredFontSelection).mode === 'string') {
			return raw as StoredFontSelection;
		}
		return { mode: 'followEditor' };
	}

	private handleSetSelection(kind: 'ui' | 'code', content: string): void {
		try {
			const json = JSON.parse(content) as Record<string, unknown>;
			const mode = json?.mode;
			let next: StoredFontSelection = { mode: 'followEditor' };
			if (mode === 'named' && typeof json.fontFamily === 'string' && json.fontFamily.trim() !== '') {
				next = { mode: 'named', fontFamily: json.fontFamily.trim() };
			} else if (mode === 'customFile' && typeof json.customFontPath === 'string' && json.customFontPath.trim() !== '') {
				next = { mode: 'customFile', customFontPath: json.customFontPath.trim() };
			}
			this.settings().getStore().setGlobal(this.selectionKey(kind), next);
			this.pushResolvedFont(kind);
		} catch {
			this.callJavaScript('showError', `Failed to save ${kind} font config`);
		}
	}

	/** 解析存储的选择为生效配置并推给 webview（设置状态 + CSS 变量）。 */
	private pushResolvedFont(kind: 'ui' | 'code'): void {
		const stored = this.getStoredSelection(kind);
		const effective = kind === 'ui' ? this.resolveUiFont(stored) : this.resolveCodeFont(stored);
		this.callJavaScript(
			kind === 'ui' ? 'onUiFontConfigReceived' : 'onCodeFontConfigReceived',
			JSON.stringify(effective),
		);
	}

	private baseFontSize(): number {
		return this.editorConfig().fontSize || 14;
	}

	private resolveUiFont(stored: StoredFontSelection): EffectiveFontConfig {
		const fontSize = this.baseFontSize();
		const common = { fontSize, lineSpacing: this.lineSpacing(fontSize) };
		if (stored.mode === 'named' && stored.fontFamily) {
			return {
				mode: 'named', effectiveMode: 'followEditor',
				fontFamily: stored.fontFamily, displayName: stored.fontFamily,
				fallbackFonts: [...VSCODE_UI_FALLBACKS],
				...common,
			};
		}
		if (stored.mode === 'customFile' && stored.customFontPath) {
			const loaded = this.loadCustomFontFile(stored.customFontPath);
			if (loaded) {
				return { ...loaded, mode: 'customFile', effectiveMode: 'customFile', ...common };
			}
			return this.followUiFont(common, stored.customFontPath);
		}
		return this.followUiFont(common);
	}

	private followUiFont(common: { fontSize: number; lineSpacing: number }, customFontPath?: string): EffectiveFontConfig {
		return {
			mode: 'followEditor', effectiveMode: 'followEditor',
			fontFamily: VSCODE_UI_FONT_FAMILY,
			displayName: 'VS Code UI',
			fallbackFonts: [...VSCODE_UI_FALLBACKS],
			customFontPath,
			warningCode: customFontPath ? 'fontUnavailable' : undefined,
			...common,
		};
	}

	private resolveCodeFont(stored: StoredFontSelection): EffectiveFontConfig {
		const fontSize = this.baseFontSize();
		const common = { fontSize, lineSpacing: this.lineSpacing(fontSize) };
		const names = this.fontList();
		if (stored.mode === 'named' && stored.fontFamily) {
			return {
				mode: 'named', effectiveMode: 'followEditor',
				fontFamily: stored.fontFamily, displayName: stored.fontFamily,
				fallbackFonts: names.filter((n) => n.toLowerCase() !== stored.fontFamily!.toLowerCase()),
				...common,
			};
		}
		if (stored.mode === 'customFile' && stored.customFontPath) {
			const loaded = this.loadCustomFontFile(stored.customFontPath);
			if (loaded) {
				return { ...loaded, mode: 'customFile', effectiveMode: 'customFile', ...common };
			}
			return this.followCodeFont(common, names, stored.customFontPath);
		}
		return this.followCodeFont(common, names);
	}

	private followCodeFont(
		common: { fontSize: number; lineSpacing: number },
		names: string[],
		customFontPath?: string,
	): EffectiveFontConfig {
		return {
			mode: 'followEditor', effectiveMode: 'followEditor',
			fontFamily: names[0] ?? 'Menlo',
			displayName: names[0] ?? 'VS Code Editor',
			fallbackFonts: names.slice(1),
			customFontPath,
			warningCode: customFontPath ? 'fontUnavailable' : undefined,
			...common,
		};
	}

	private loadCustomFontFile(path: string): Omit<EffectiveFontConfig, 'fontSize' | 'lineSpacing'> | null {
		try {
			const bytes = readFileSync(path);
			const ext = extname(path).toLowerCase();
			if (ext !== '.ttf' && ext !== '.otf') {
				return null;
			}
			const family = basename(path, ext);
			return {
				mode: 'customFile', effectiveMode: 'customFile',
				fontFamily: family,
				displayName: basename(path),
				customFontPath: path,
				fontBase64: bytes.toString('base64'),
				fontFormat: ext === '.otf' ? 'opentype' : 'truetype',
			};
		} catch {
			return null;
		}
	}

	// ── 浏览选择字体文件 ────────────────────────────────────────────────

	private async browseFontFile(kind: 'ui' | 'code'): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: vscode.l10n.t('Open'),
			filters: { Fonts: ['ttf', 'otf'] },
		});
		const uri = uris?.[0];
		if (!uri || uri.scheme !== 'file') {
			return;
		}
		const path = uri.fsPath;
		this.settings().getStore().setGlobal(this.selectionKey(kind), { mode: 'customFile', customFontPath: path });
		this.pushResolvedFont(kind);
	}
}
