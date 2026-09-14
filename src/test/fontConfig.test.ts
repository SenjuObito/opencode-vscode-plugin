import * as assert from 'assert';

import { FontConfigHandler } from '../host/handlers/FontConfigHandler';
import { HandlerContext } from '../host/router/HandlerContext';
import type { WebviewChannel } from '../host/router/HandlerContext';
import { SettingsService } from '../host/settings/SettingsService';
import type { SettingsStore } from '../host/settings/SettingsService';

/**
 * FontConfigHandler 字体解析测试。
 *
 * 走真实的 wire 协议（`handler.handle('<type>', content)`）而不是直接调私有的
 * resolve* 方法：这样一并覆盖 handleSetSelection 的持久化路径和 callJavaScript
 * 的回推载荷。用例与 Java 参考实现 opencode-idea-gui 的
 * FontConfigServiceUiFontResolutionTest 对齐。
 */

interface Captured {
	fn: string;
	payload: Record<string, unknown>;
}

/** SettingsStore 是 4 个方法的接口，内存 Map 实现即可（SettingsService.ts:9）。 */
function memoryStore(): SettingsStore {
	const global = new Map<string, unknown>();
	const workspace = new Map<string, unknown>();
	return {
		getGlobal: (key) => global.get(key),
		setGlobal: (key, value) => void global.set(key, value),
		getWorkspace: (key) => workspace.get(key),
		setWorkspace: (key, value) => void workspace.set(key, value),
	};
}

function makeHandler() {
	const captured: Captured[] = [];
	const channel: WebviewChannel = {
		callJavaScript: (fn, ...args) => {
			captured.push({ fn, payload: JSON.parse(args[0] ?? '{}') as Record<string, unknown> });
		},
		isDisposed: () => false,
		postRaw: () => {},
	};
	const context = new HandlerContext(channel, new SettingsService(memoryStore()));
	return { handler: new FontConfigHandler(context), captured };
}

/** 取最近一次指定回调的载荷。 */
function lastPayload(captured: Captured[], fn: string): Record<string, unknown> {
	const hit = [...captured].reverse().find((c) => c.fn === fn);
	assert.ok(hit, `expected a ${fn} callback, got: [${captured.map((c) => c.fn).join(', ')}]`);
	return hit.payload;
}

suite('FontConfigHandler font resolution', () => {
	test('named UI font resolves with mode and effectiveMode both named', () => {
		const { handler, captured } = makeHandler();
		handler.handle('set_ui_font_config', JSON.stringify({ mode: 'named', fontFamily: 'JetBrains Mono' }));

		const payload = lastPayload(captured, 'onUiFontConfigReceived');
		assert.strictEqual(payload.mode, 'named');
		assert.strictEqual(payload.effectiveMode, 'named');
		assert.strictEqual(payload.fontFamily, 'JetBrains Mono');
		assert.strictEqual(payload.displayName, 'JetBrains Mono');
		assert.strictEqual(payload.warning, undefined);
	});

	test('named code font resolves with mode and effectiveMode both named', () => {
		const { handler, captured } = makeHandler();
		handler.handle('set_code_font_config', JSON.stringify({ mode: 'named', fontFamily: 'Fira Code' }));

		const payload = lastPayload(captured, 'onCodeFontConfigReceived');
		assert.strictEqual(payload.mode, 'named');
		assert.strictEqual(payload.effectiveMode, 'named');
		assert.strictEqual(payload.fontFamily, 'Fira Code');
		assert.strictEqual(payload.displayName, 'Fira Code');
		assert.strictEqual(payload.warning, undefined);
	});

	test('named font with blank family falls back to followEditor', () => {
		const { handler, captured } = makeHandler();
		handler.handle('set_ui_font_config', JSON.stringify({ mode: 'named', fontFamily: '   ' }));

		const payload = lastPayload(captured, 'onUiFontConfigReceived');
		assert.strictEqual(payload.mode, 'followEditor');
		assert.strictEqual(payload.effectiveMode, 'followEditor');
	});

	test('unset UI font follows the editor with no downgrade', () => {
		const { handler, captured } = makeHandler();
		handler.handle('get_ui_font_config', '');

		const payload = lastPayload(captured, 'onUiFontConfigReceived');
		assert.strictEqual(payload.mode, 'followEditor');
		assert.strictEqual(payload.effectiveMode, 'followEditor');
		assert.strictEqual(payload.warningCode, undefined);
	});

	test('unavailable custom UI font keeps mode while effectiveMode downgrades', () => {
		const { handler, captured } = makeHandler();
		const path = '/tmp/does-not-exist-opencode-buddy.ttf';
		handler.handle('set_ui_font_config', JSON.stringify({ mode: 'customFile', customFontPath: path }));

		const payload = lastPayload(captured, 'onUiFontConfigReceived');
		// mode 保留用户的选择，只有 effectiveMode 降级——UI 靠 mode 反推下拉框选中项。
		assert.strictEqual(payload.mode, 'customFile');
		assert.strictEqual(payload.effectiveMode, 'followEditor');
		assert.strictEqual(payload.customFontPath, path);
		assert.strictEqual(payload.warningCode, 'fontUnavailable');
	});

	test('unavailable custom code font keeps mode while effectiveMode downgrades', () => {
		const { handler, captured } = makeHandler();
		const path = '/tmp/does-not-exist-opencode-buddy.otf';
		handler.handle('set_code_font_config', JSON.stringify({ mode: 'customFile', customFontPath: path }));

		const payload = lastPayload(captured, 'onCodeFontConfigReceived');
		assert.strictEqual(payload.mode, 'customFile');
		assert.strictEqual(payload.effectiveMode, 'followEditor');
		assert.strictEqual(payload.customFontPath, path);
		assert.strictEqual(payload.warningCode, 'fontUnavailable');
	});
});
