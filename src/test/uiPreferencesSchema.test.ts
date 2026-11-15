import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_UI_PREFERENCES,
  SettingsService,
  type SettingsStore,
  type UiPreferences,
} from '../host/settings/SettingsService';

/**
 * UI 偏好字段契约。
 *
 * 宿主（`SettingsService.UiPreferences`）与 webview（`webview/src/utils/uiPreferences.ts`）
 * 各自声明了同一组字段，但没有共享类型：任何一侧加字段而另一侧忘记，都会
 * 表现为「设置过、重启后丢失」或「宿主持久化但界面不认」。这两个接口在过去
 * 已经漂移过（`skipCompactConfirm` 就是漏在宿主白名单外的那一个），所以这里
 * 用源码级契约测试把字段集合钉死。
 */

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** 取出 `export interface <name> { ... }` 的字段名（保持声明顺序）。 */
function interfaceFields(source: string, name: string): string[] {
  const match = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(match, `interface ${name} not found`);
  const fields: string[] = [];
  for (const line of match[1].split('\n')) {
    const field = /^\s{1,2}([A-Za-z_][A-Za-z0-9_]*)\??:\s*\S/.exec(line);
    if (field) {
      fields.push(field[1]);
    }
  }
  return fields;
}

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

suite('UiPreferences schema parity', () => {
  const hostSource = readRepoFile('src/host/settings/SettingsService.ts');
  const webviewSource = readRepoFile('webview/src/utils/uiPreferences.ts');

  test('host and webview declare the same fields', () => {
    const hostFields = interfaceFields(hostSource, 'UiPreferences').sort();
    const webviewFields = interfaceFields(webviewSource, 'UiPreferences').sort();

    assert.deepStrictEqual(
      hostFields,
      webviewFields,
      'UiPreferences drifted between the extension host and the webview',
    );
  });

  test('DEFAULT_UI_PREFERENCES covers every declared field', () => {
    const hostFields = interfaceFields(hostSource, 'UiPreferences').sort();
    const defaultKeys = Object.keys(DEFAULT_UI_PREFERENCES).sort();
    assert.deepStrictEqual(defaultKeys, hostFields);
  });

  test('host sanitizes and round-trips skipCompactConfirm', () => {
    const service = new SettingsService(memoryStore());

    const merged = service.setUiPreferences({ skipCompactConfirm: true });
    assert.strictEqual(merged.skipCompactConfirm, true);
    assert.strictEqual(service.getUiPreferences().skipCompactConfirm, true);

    // 非布尔值不能污染存储，应回落到默认值。
    const reverted = service.setUiPreferences({
      skipCompactConfirm: 'yes' as unknown as boolean,
    });
    assert.strictEqual(reverted.skipCompactConfirm, DEFAULT_UI_PREFERENCES.skipCompactConfirm);
  });

  test('host drops unknown fields', () => {
    const service = new SettingsService(memoryStore());
    service.setUiPreferences({ somethingUnknown: 'x' } as unknown as Partial<UiPreferences>);
    const stored = service.getUiPreferences() as unknown as Record<string, unknown>;
    assert.strictEqual(stored.somethingUnknown, undefined);
  });
});
