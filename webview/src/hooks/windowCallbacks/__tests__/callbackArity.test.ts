/**
 * callbackArity.test.ts
 *
 * Guards the host → webview callback contract against silent drift.
 *
 * History: the host moved every callback to `(sessionId, payload)` when
 * multi-session routing landed, but three webview handlers
 * (`onTaskEvent` / `onTodoUpdated` / `onMessagesRemoved`) kept parsing their
 * first argument as the payload. `JSON.parse(sessionId)` threw, the surrounding
 * `catch` swallowed it, and the pushes silently did nothing for months —
 * TypeScript could not see it because `global.d.ts` already declared two params
 * while the implementations kept one (a wider declared type is assignable).
 *
 * This test scans both sides textually: it compares the argument count at each
 * `callJavaScript('<name>', ...)` site in the host with the parameter count of
 * the matching `window.<name> = (...) =>` assignment in the webview.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// webview/src/hooks/windowCallbacks/__tests__ → repo root
const repoRoot = resolve(here, '../../../../../');
const HOST_SOURCE = resolve(repoRoot, 'src/host/session/SessionCallbackAdapter.ts');
const WEBVIEW_SOURCE_DIR = resolve(here, '../../..');

/** Files that assign `window.<callback>`. Scanning the whole tree keeps this
 *  test correct no matter which module a handler moves to. */
const WEBVIEW_SOURCE_FILES = [
  'App.tsx',
  'hooks/windowCallbacks/registerCallbacks.ts',
  'hooks/windowCallbacks/registerCallbacks/messageCallbacks.ts',
  'hooks/windowCallbacks/registerCallbacks/streamingCallbacks.ts',
  'hooks/windowCallbacks/registerCallbacks/sessionCallbacks.ts',
  'hooks/windowCallbacks/registerCallbacks/usageModeCallbacks.ts',
  'hooks/windowCallbacks/registerCallbacks/permissionCallbacks.ts',
  'hooks/windowCallbacks/registerCallbacks/agentCallbacks.ts',
];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Collect every `callJavaScript('<name>', a, b, ...)` call in the host source
 * and return name → number of arguments that follow the callback name.
 *
 * Commas nested inside calls / objects / strings do not count, so multi-line
 * calls such as `callJavaScript('x', id, JSON.stringify({ a, b }))` report 2.
 */
function collectHostArity(source: string): Map<string, number> {
  const result = new Map<string, number>();
  const marker = 'callJavaScript(';
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) break;
    let i = start + marker.length;
    // First argument: the callback name literal.
    while (i < source.length && /\s/.test(source[i])) i += 1;
    const quote = source[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') {
      cursor = i;
      continue;
    }
    const nameEnd = source.indexOf(quote, i + 1);
    if (nameEnd === -1) break;
    const name = source.slice(i + 1, nameEnd);
    i = nameEnd + 1;

    // Skip the separator between the callback name and the first payload arg;
    // otherwise the first top-level comma would be counted as an argument.
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] === ',') i += 1;

    // Count top-level commas up to the matching close paren.
    let depth = 1;
    let args = 0;
    let sawContent = false;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        // Skip the string literal, honouring backslash escapes.
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === '\\') { j += 2; continue; }
          if (source[j] === ch) break;
          j += 1;
        }
        i = j;
        sawContent = true;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') { depth += 1; sawContent = true; continue; }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) break;
        continue;
      }
      if (ch === ',' && depth === 1) { args += 1; continue; }
      if (!/\s/.test(ch)) sawContent = true;
    }

    const arity = sawContent ? args + 1 : 0;
    // Keep the widest arity per callback: an adapter may guard-return early
    // with a shorter call, but at least one site carries the full payload.
    result.set(name, Math.max(result.get(name) ?? 0, arity));
    cursor = i + 1;
  }

  return result;
}

/**
 * Count declared parameters on `window.<name> = (...) =>` / `window.<name> =
 * function (...) {` assignments across the webview sources.
 */
function collectWebviewArity(): Map<string, number> {
  const result = new Map<string, number>();

  for (const relative of WEBVIEW_SOURCE_FILES) {
    let source: string;
    try {
      source = read(resolve(WEBVIEW_SOURCE_DIR, relative));
    } catch {
      continue;
    }

    const pattern = /window\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1];
      let i = match.index + match[0].length;
      let depth = 1;
      let params = 0;
      let sawContent = false;
      let sawRest = false;
      for (; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '(' || ch === '[' || ch === '{') { depth += 1; continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
          depth -= 1;
          if (depth === 0) break;
          continue;
        }
        if (ch === ',' && depth === 1) { params += 1; continue; }
        if (ch === '.' && source.startsWith('...', i)) { sawRest = true; continue; }
        if (!/\s/.test(ch)) sawContent = true;
      }
      // `(...args)` accepts any arity — treat it as unbounded so flexible
      // pass-through handlers are never reported as drift.
      const arity = sawRest ? Number.POSITIVE_INFINITY : (sawContent ? params + 1 : 0);
      result.set(name, Math.max(result.get(name) ?? 0, arity));
    }
  }

  return result;
}

describe('host → webview callback arity contract', () => {
  const hostArity = collectHostArity(read(HOST_SOURCE));
  const webviewArity = collectWebviewArity();

  it('parses a meaningful number of host call sites', () => {
    // Sanity check on the scanner itself: if the regex silently stops matching
    // (e.g. the adapter is renamed), the contract would pass vacuously.
    expect(hostArity.size).toBeGreaterThanOrEqual(15);
  });

  it('every multi-argument host callback is declared with a matching arity', () => {
    const mismatches: string[] = [];

    for (const [name, hostCount] of hostArity) {
      if (hostCount <= 1) continue; // single-payload callbacks are drift-free
      const declared = webviewArity.get(name);
      if (declared === undefined) {
        // Not a webview-facing callback (host-internal name or handled elsewhere);
        // only flag names the webview actually assigns.
        continue;
      }
      if (declared < hostCount) {
        mismatches.push(`${name}: host passes ${hostCount} args, webview declares ${declared}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('session-scoped callbacks are always double-argument on both sides', () => {
    // Named explicitly so a regression points at the contract, not at a count.
    // `updateMessages` is dispatched through StreamMessageCoalescer rather than
    // callJavaScript directly, so it is covered by the generic scan below only.
    for (const name of ['onTaskEvent', 'onTodoUpdated', 'onMessagesRemoved', 'onContentDelta', 'onThinkingDelta']) {
      expect(hostArity.get(name) ?? 0).toBeGreaterThanOrEqual(2);
      expect(webviewArity.get(name) ?? 0).toBe(2);
    }
  });
});
