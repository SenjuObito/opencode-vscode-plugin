import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEMANTIC_HANDLERS } from './semanticEvents';

/**
 * 协议目录双端一致性（§4.2 / G14）。
 *
 * <p>宿主 `EventCatalog` 与 webview `semanticEvents` 是同一份契约的两半：
 * 名字或数量一旦分叉，宿主就会发布一个没有接收方的事件（或反之）。这个测试
 * 直接读宿主源码，缺少任何一个键都会失败。</p>
 */
describe('semantic event catalog parity', () => {
  it('keeps the host and webview key sets identical', () => {
    const hostFile = resolve(process.cwd(), '../src/host/router/EventCatalog.ts');
    const source = readFileSync(hostFile, 'utf8');
    const start = source.indexOf('const FUNCTION_BY_TYPE');
    const end = source.indexOf('\n};', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const table = source.slice(start, end);

    const hostKeys = new Set(
      [...table.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1]),
    );
    const webviewKeys = new Set(Object.keys(SEMANTIC_HANDLERS));

    expect([...webviewKeys].filter((key) => !hostKeys.has(key))).toEqual([]);
    expect([...hostKeys].filter((key) => !webviewKeys.has(key))).toEqual([]);
    expect(webviewKeys.size).toBe(hostKeys.size);
  });
});
