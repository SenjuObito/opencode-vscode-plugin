#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DAEMON_SCRIPT = path.join(PROJECT_ROOT, 'ai-bridge', 'daemon.js');
const TARGET_TITLE = '对话列表消息排序逻辑梳理';
const DIRECTORY = '/Users/obito/source/repos/opencode-gui';
const OUTPUT_FILE = '/tmp/history-messages-test.log';

const logs = [];
function log(msg) {
  console.log(msg);
  logs.push(msg);
}

function dumpPart(part, role, msgId) {
  const name = part.tool || 'unknown';
  const callID = part.callID || part.id || '';
  const state = part.state ?? {};
  const input = state.input ?? {};
  const output = typeof state.output === 'string' ? state.output : '';
  const error = typeof state.error === 'string' ? state.error : '';
  const status = state.status || 'unknown';

  log(`  tool: ${name}`);
  log(`  callID: ${callID}`);
  log(`  state.status: ${status}`);
  log(`  state.input: ${JSON.stringify(input)}`);
  log(`  state.output: ${output.substring(0, 500) || '(空)'}`);
  if (error) log(`  state.error: ${error.substring(0, 300)}`);
}

function analyzeMessages(messages, label) {
  log(`\n${'='.repeat(80)}`);
  log(`[${label}] 共 ${messages.length} 条消息，逐条输出内容：`);
  log(`${'='.repeat(80)}`);

  for (let i = 0; i < messages.length; i++) {
    const entry = messages[i];
    const info = entry.info ?? {};
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const role = info.role || 'unknown';
    const msgId = info.id || `msg-${i}`;

    log(`\n--- 消息 #${i} [role=${role}] id=${msgId} ---`);

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      log(`\n  Part #${j}: type=${part.type}`);

      if (part.type === 'text') {
        log(`  text: ${(part.text || '').substring(0, 200)}`);
      } else if (part.type === 'reasoning') {
        log(`  reasoning: ${(part.text || '').substring(0, 200)}`);
      } else if (part.type === 'tool') {
        dumpPart(part, role, msgId);
      } else if (part.type === 'tool_result') {
        log(`  tool_use_id: ${part.tool_use_id || ''}`);
        const content = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
        log(`  content: ${content.substring(0, 500)}`);
      } else {
        log(`  全量: ${JSON.stringify(part).substring(0, 300)}`);
      }
    }
  }
}

async function testDaemon() {
  log('=== 方式 1: 通过 ai-bridge daemon ===');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DAEMON_SCRIPT], {
      cwd: path.join(PROJECT_ROOT, 'ai-bridge'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = createInterface({ input: child.stdout });
    let reqId = 0;

    rl.on('line', (line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return; }

      if (obj.type === 'daemon' && obj.event === 'ready') {
        log(`\nDaemon ready, PID=${obj.pid}`);
        child.stdin.write(JSON.stringify({ id: String(++reqId), method: 'opencode.listCommands', params: {} }) + '\n');
        return;
      }

      if (obj.id && obj.line) {
        let payload;
        try { payload = JSON.parse(obj.line); } catch { return; }

        if (payload.sessions) {
          log(`\n获取到 ${payload.sessions.length} 个 sessions`);
          const target = payload.sessions.find(s => s.title === TARGET_TITLE || s.name === TARGET_TITLE);
          if (target) {
            const sid = target.id || target.sessionID;
            log(`找到目标: "${TARGET_TITLE}" → ${sid}`);
            child.stdin.write(JSON.stringify({ id: String(++reqId), method: 'opencode.listMessages', params: { sessionId: sid, directory: DIRECTORY } }) + '\n');
          } else {
            log('未找到目标，列出所有:');
            payload.sessions.forEach(s => log(`  ${s.id}: ${s.title || s.name}`));
            child.kill(); resolve();
          }
        }

        if (payload.messages) {
          analyzeMessages(payload.messages, 'Daemon');
          child.kill(); resolve();
        }
      }
    });

    child.stderr.on('data', () => {});
    setTimeout(() => { child.kill(); resolve(); }, 30000);
  });
}

async function testSdk() {
  log('\n\n=== 方式 2: 通过 opencode SDK 直连 ===');
  try {
    let createOpencodeClient;
    try {
      const m = await import('@opencode-ai/sdk/v2');
      createOpencodeClient = m.createOpencodeClient;
    } catch {
      const m = await import(path.join(PROJECT_ROOT, 'ai-bridge', 'node_modules', '@opencode-ai', 'sdk', 'dist', 'v2', 'index.js'));
      createOpencodeClient = m.createOpencodeClient;
    }
    const client = createOpencodeClient({ baseUrl: 'http://localhost:4096' });

    log('\n尝试连接 localhost:4096 ...');
    const sessions = await client.session.list({ directory: DIRECTORY });
    if (sessions.error) {
      log(`SDK 连接失败: ${JSON.stringify(sessions.error)}`);
      return;
    }
    log(`获取到 ${(sessions.data || []).length} 个 sessions`);

    const target = (sessions.data || []).find(s => s.title === TARGET_TITLE || s.name === TARGET_TITLE);
    if (!target) {
      log(`未找到 "${TARGET_TITLE}"`);
      (sessions.data || []).forEach(s => log(`  ${s.id}: ${s.title}`));
      return;
    }
    const sid = target.id || target.sessionID;
    log(`找到目标: "${TARGET_TITLE}" → ${sid}`);

    const msgs = await client.session.messages({ sessionID: sid, directory: DIRECTORY });
    if (msgs.error) {
      log(`获取消息失败: ${JSON.stringify(msgs.error)}`);
      return;
    }
    analyzeMessages(msgs.data || [], 'SDK');
  } catch (err) {
    log(`SDK 错误: ${err.message}\n${err.stack}`);
  }
}

async function main() {
  log(`目标: "${TARGET_TITLE}"`);
  log(`项目目录: ${DIRECTORY}`);
  log(`时间: ${new Date().toISOString()}\n`);

  await testDaemon();
  await testSdk();

  log(`\n${'='.repeat(80)}`);
  log('测试完成，输出已保存到 ' + OUTPUT_FILE);
  log(`${'='.repeat(80)}`);

  writeFileSync(OUTPUT_FILE, logs.join('\n'), 'utf8');
}

main().catch(err => {
  console.error(err);
  logs.push(`\nFATAL: ${err.message}\n${err.stack}`);
  writeFileSync(OUTPUT_FILE, logs.join('\n'), 'utf8');
});
