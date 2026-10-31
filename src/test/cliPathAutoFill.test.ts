import * as assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SettingsService, SettingsStore } from '../host/settings/SettingsService';
import {
	applyAutoFill,
	isWslPath,
	resolveCliPathForInjection,
	resolveValidCliPath,
	shouldFill,
} from '../host/provider/CliPathAutoFill';

/** 内存版 SettingsStore：不碰真实 Memento，且写入立即可读。 */
class MemorySettingsStore implements SettingsStore {
	private readonly global = new Map<string, unknown>();
	private readonly workspace = new Map<string, unknown>();

	getGlobal(key: string): unknown {
		return this.global.get(key);
	}

	setGlobal(key: string, value: unknown): void {
		this.global.set(key, value);
	}

	getWorkspace(key: string): unknown {
		return this.workspace.get(key);
	}

	setWorkspace(key: string, value: unknown): void {
		this.workspace.set(key, value);
	}

	/** 测试用：模拟旧版本遗留的键。 */
	seed(key: string, value: unknown): void {
		this.global.set(key, value);
	}
}

/** 写入必失败的存储：验证回填不向上抛。 */
class ThrowingStore extends MemorySettingsStore {
	override setGlobal(): void {
		throw new Error('globalState is read-only');
	}
}

const positives = {
	isFile: () => true,
	platform: 'linux' as NodeJS.Platform,
	home: '/home/tester',
};

const negatives = {
	isFile: () => false,
	platform: 'linux' as NodeJS.Platform,
	home: '/home/tester',
};

suite('CliPathAutoFill (engine_status → 设置回填)', () => {
	let tempDir = '';
	let realBinary = '';

	suiteSetup(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'opencode-auto-fill-'));
		realBinary = join(tempDir, 'opencode');
		writeFileSync(realBinary, '');
	});

	suiteTeardown(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch { /* 忽略清理失败 */ }
	});

	test('把空设置填成 daemon 解析出的路径', () => {
		const service = new SettingsService(new MemorySettingsStore());

		const { applied } = applyAutoFill(service, realBinary, 'known-dir');

		assert.strictEqual(applied, realBinary);
		assert.strictEqual(service.getOpencodeCliPath(), realBinary);
		assert.strictEqual(service.getOpencodeCliPathAutoDetected(), true);
	});

	test('空白设置视为空', () => {
		const store = new MemorySettingsStore();
		const service = new SettingsService(store);
		service.setOpencodeCliPath(null);
		store.seed('opencode.tuiPath', '   ');

		const { applied } = applyAutoFill(service, realBinary, 'path');

		assert.strictEqual(applied, realBinary);
	});

	test('永不覆盖用户显式设置', () => {
		const service = new SettingsService(new MemorySettingsStore());
		service.setOpencodeCliPath('/opt/custom/opencode');

		const { applied } = applyAutoFill(service, realBinary, 'known-dir');

		assert.strictEqual(applied, null);
		assert.strictEqual(service.getOpencodeCliPath(), '/opt/custom/opencode');
	});

	test('daemon 报 source=settings 时不回填', () => {
		// 自己的值被读回 L0：没有新信息，重写只会每次启动都动一次存储。
		assert.strictEqual(shouldFill(realBinary, 'settings', null), false);
		assert.strictEqual(applyAutoFill(new SettingsService(new MemorySettingsStore()), realBinary, 'settings').applied, null);
	});

	test('二进制不存在时不回填', () => {
		const missing = join(tempDir, 'does-not-exist');

		assert.strictEqual(shouldFill(missing, 'known-dir', null), false);
	});

	test('L4 裸命令名不回填', () => {
		// 裸名不是路径；写回后 L0 只接受路径，等于把 PATH 查找禁掉。
		assert.strictEqual(shouldFill('opencode', 'bare', null), false);
	});

	test('空白 / null 报告不回填', () => {
		assert.strictEqual(shouldFill(null, 'path', null), false);
		assert.strictEqual(shouldFill('', 'path', null), false);
		assert.strictEqual(shouldFill('   ', 'path', null), false);
	});

	test('WSL 路径直接信任（宿主无法校验）', () => {
		assert.strictEqual(isWslPath('/usr/local/bin/opencode', 'win32'), true);
		assert.strictEqual(isWslPath('C:\\tools\\opencode.exe', 'win32'), false);
		assert.strictEqual(isWslPath('/usr/local/bin/opencode', 'linux'), false);
		assert.strictEqual(
			shouldFill('/usr/local/bin/opencode', 'known-dir', null, { platform: 'win32', isFile: () => false }),
			true,
		);
	});

	test('写入失败被吞掉而不是抛出', () => {
		const service = new SettingsService(new ThrowingStore());

		const { applied } = applyAutoFill(service, realBinary, 'known-dir');

		assert.strictEqual(applied, null);
	});

	test('容忍 null store', () => {
		assert.strictEqual(applyAutoFill(null, realBinary, 'known-dir').applied, null);
		assert.strictEqual(resolveCliPathForInjection(null), null);
	});

	test('陈旧自动检测值在注入前被丢弃并清空', () => {
		const store = new MemorySettingsStore();
		const service = new SettingsService(store);
		service.setOpencodeCliPathAutoDetected(join(tempDir, 'gone'));

		const injected = resolveCliPathForInjection(service);

		assert.strictEqual(injected, null);
		// 两个键都要清：否则下次注入仍会读到死路径。
		assert.strictEqual(service.getOpencodeCliPath(), null);
		assert.strictEqual(service.getOpencodeCliPathAutoDetected(), false);
	});

	test('用户手填的失效路径保持原样（维持阻塞语义）', () => {
		const service = new SettingsService(new MemorySettingsStore());
		service.setOpencodeCliPath(join(tempDir, 'typo'));

		assert.strictEqual(resolveCliPathForInjection(service), join(tempDir, 'typo'));
	});

	test('自动检测的 WSL 路径不做宿主存在性判断', () => {
		const service = new SettingsService(new MemorySettingsStore());
		service.setOpencodeCliPathAutoDetected('/usr/local/bin/opencode');

		const injected = resolveCliPathForInjection(service, { platform: 'win32', isFile: () => false });

		assert.strictEqual(injected, '/usr/local/bin/opencode');
	});

	test('手动保存后清除自动检测标记', () => {
		const service = new SettingsService(new MemorySettingsStore());
		service.setOpencodeCliPathAutoDetected(realBinary);
		assert.strictEqual(service.getOpencodeCliPathAutoDetected(), true);

		service.setOpencodeCliPath(realBinary);

		assert.strictEqual(service.getOpencodeCliPathAutoDetected(), false);
	});

	test('兼容旧版本遗留的 opencodeCliPath 键', () => {
		const store = new MemorySettingsStore();
		store.seed('opencodeCliPath', '/legacy/opencode');
		const service = new SettingsService(store);

		assert.strictEqual(service.getOpencodeCliPath(), '/legacy/opencode');
	});
});

suite('resolveValidCliPath (手填路径校验)', () => {
	test('展开 ~', () => {
		// 展开用宿主路径风格（生产环境宿主就是真正去读该路径的一方）。
		const expected = join('/home/tester', 'bin/opencode');
		const resolved = resolveValidCliPath('~/bin/opencode', {
			platform: 'linux',
			home: '/home/tester',
			isFile: (p) => p === expected,
		});

		assert.strictEqual(resolved, expected);
	});

	test('去掉成对引号', () => {
		const resolved = resolveValidCliPath('"/opt/opencode"', {
			platform: 'linux',
			isFile: (p) => p === '/opt/opencode',
		});

		assert.strictEqual(resolved, '/opt/opencode');
	});

	test('Windows 下补 .cmd 扩展名', () => {
		const resolved = resolveValidCliPath('C:\\Users\\me\\AppData\\Roaming\\npm\\opencode', {
			platform: 'win32',
			isFile: (p) => p === 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd',
		});

		assert.strictEqual(resolved, 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd');
	});

	test('WSL 路径跳过宿主存在性检查', () => {
		const resolved = resolveValidCliPath('/usr/local/bin/opencode', {
			platform: 'win32',
			isFile: () => false,
		});

		assert.strictEqual(resolved, '/usr/local/bin/opencode');
	});

	test('相对路径锚在 home，而不是宿主 cwd', () => {
		const expected = join('/home/tester', 'bin/opencode');
		const resolved = resolveValidCliPath('bin/opencode', {
			platform: 'linux',
			home: '/home/tester',
			isFile: (p) => p === expected,
		});

		assert.strictEqual(resolved, expected);
	});

	test('不存在又无扩展名回退时返回 null', () => {
		assert.strictEqual(
			resolveValidCliPath('/nope/opencode', { platform: 'linux', isFile: () => false }),
			null,
		);
		assert.strictEqual(resolveValidCliPath('   ', { platform: 'linux', isFile: () => true }), null);
	});

	test('否定探针下真实路径依然通过（探针接管）', () => {
		assert.strictEqual(
			resolveValidCliPath('/opt/opencode', { platform: 'linux', isFile: () => true }),
			'/opt/opencode',
		);
		assert.strictEqual(shouldFill('/opt/opencode', 'known-dir', null, negatives), false);
		assert.strictEqual(shouldFill('/opt/opencode', 'known-dir', null, positives), true);
	});
});
