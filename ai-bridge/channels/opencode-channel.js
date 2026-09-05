/**
 * OpenCode channel command handler – keeps OpenCode-specific logic separated.
 * Uses the persistent `opencode serve` connection via the daemon service.
 */
import { sendMessage as openCodeSendMessage } from '../services/opencode/message-service.js';
import { listModels as openCodeListModels, ensureServerReady } from '../services/opencode/models-service.js';
import { getSessionDirectory } from '../services/opencode/opencode-daemon-service.js';
import {
  replyPermission as openCodeReplyPermission,
  replyQuestion as openCodeReplyQuestion,
  rejectQuestion as openCodeRejectQuestion,
  listMessages as openCodeListMessages,
  findFiles as openCodeFindFiles,
  getAgents as openCodeGetAgents,
  getCommands as openCodeGetCommands,
  getMcpStatus as openCodeGetMcpStatus,
  shareSession as openCodeShareSession,
  unshareSession as openCodeUnshareSession,
  revertSession as openCodeRevertSession,
  unrevertSession as openCodeUnrevertSession,
  forkSession as openCodeForkSession,
  summarizeSession as openCodeSummarizeSession,
  getSession as openCodeGetSession,
} from '../services/opencode/opencode-sdk-client.js';

/**
 * Execute an OpenCode command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleOpenCodeCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          sessionId,
          cwd,
          model,
          reasoningEffort,
          attachments,
        } = stdinData;
        await openCodeSendMessage(
          message,
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || '',
          attachments || []
        );
      } else {
        await openCodeSendMessage(args[0], args[1], args[2], args[3], args[4], []);
      }
      break;
    }

    case 'listModels':
      await openCodeListModels();
      break;

    case 'listMessages': {
      const { sessionId, directory } = stdinData || {};
      // 冷启动兜底：历史会话恢复依赖 opencode serve 已就绪。preconnect 在插件
      // 启动时预热 serve，但若 preconnect 失败/过慢，首次 listMessages 会打到
      // 冷 serve 导致 getClient().session.messages 失败/返回空，表现为「首次加载
      // 会话消息列表为空、二次及以后正常」。这里显式等待 serve 就绪再查询。
      await ensureServerReady();
      const messages = await openCodeListMessages(sessionId || '', directory || undefined);
      // 与 listModels 相同输出约定：单行 JSON（daemon 模式下被包装为 {id,line}）。
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        sessionId: sessionId || '',
        messages: Array.isArray(messages) ? messages : [],
      }));
      break;
    }

    case 'getSessionInfo': {
      const { sessionId, directory } = stdinData || {};
      // 与 listMessages 同因：跨会话加载时从 daemon session.get 读权威状态，
      // 同样需要 serve 就绪，否则首次查询失败返回空而第二次才成功。
      await ensureServerReady();
      // opencode session 原生持久化 agent（模式）与 model {providerID, id, variant}
      // （variant 即推理力度映射），是会话级状态的权威来源。
      const session = await openCodeGetSession(sessionId || '', directory || undefined);
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        sessionId: sessionId || '',
        session: session ?? null,
      }));
      break;
    }

    case 'findFiles': {
      // @ 文件补全：服务端 fs.find（与 TUI 同源，已按 frecency+模糊排序）。
      const { query, limit, directory } = stdinData || {};
      try {
        await ensureServerReady();
        const entries = await openCodeFindFiles({
          query: typeof query === 'string' ? query : '',
          limit: typeof limit === 'string' ? limit : '20',
          directory: directory || undefined,
        });
        console.error(
          `[DEBUG][OpenCodeFindFiles] query="${query || ''}" directory=${directory || '-'} entries=${entries.length}`,
        );
        console.log(JSON.stringify({
          success: true,
          provider: 'opencode',
          entries: Array.isArray(entries) ? entries : [],
        }));
      } catch (err) {
        console.error(`[DEBUG][OpenCodeFindFiles] failed: ${err?.message || err}`);
        throw err;
      }
      break;
    }

    case 'listAgents': {
      const { directory } = stdinData || {};
      const agents = await openCodeGetAgents(directory || undefined);
      // 输出约定与 listModels/listMessages 一致：单行 JSON（daemon 模式包装为 {id,line}）。
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        agents: Array.isArray(agents) ? agents : [],
      }));
      break;
    }

    case 'listCommands': {
      const { directory } = stdinData || {};
      const commands = await openCodeGetCommands(directory || undefined);
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        commands: Array.isArray(commands) ? commands : [],
      }));
      break;
    }

    case 'listMcpServers': {
      const { directory } = stdinData || {};
      // opencode 的 MCP server 配置由 opencode 自身管理（config.json）；插件侧
      // 从 mcp.status 枚举服务器名作为可展示列表（server spec 不暴露时给占位）。
      const statuses = await openCodeGetMcpStatus(directory || undefined);
      const servers = (Array.isArray(statuses) ? statuses : []).map((s) => ({
        id: s.name,
        name: s.name,
        server: { type: 'stdio' },
        description: 'opencode MCP server',
      }));
      console.log(JSON.stringify({ success: true, provider: 'opencode', servers }));
      break;
    }

    case 'getMcpStatus': {
      const { directory } = stdinData || {};
      const statuses = await openCodeGetMcpStatus(directory || undefined);
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        statuses: Array.isArray(statuses) ? statuses : [],
      }));
      break;
    }

    case 'replyPermission': {
      const { sessionId, permissionID, reply, rejectMessage } = stdinData || {};
      const directory = getSessionDirectory(sessionId);
      // cc-gui vocabulary (allow/allowAlways/deny) → SDK PermissionV2Reply
      const sdkReply = reply === 'allowAlways' ? 'always' : reply === 'deny' ? 'reject' : 'once';
      await openCodeReplyPermission(sessionId, permissionID, sdkReply, rejectMessage, directory);
      break;
    }

    case 'replyQuestion': {
      const { sessionId, questionID, answers } = stdinData || {};
      const directory = getSessionDirectory(sessionId);
      console.log(`[opencode-channel] replyQuestion sessionId=${sessionId} questionID=${questionID} directory=${directory || '-'} answers=${JSON.stringify(answers)}`);
      await openCodeReplyQuestion(sessionId, questionID, Array.isArray(answers) ? answers : [], directory);
      console.log(`[opencode-channel] replyQuestion SUCCESS`);
      break;
    }

    case 'rejectQuestion': {
      const { sessionId, questionID } = stdinData || {};
      const directory = getSessionDirectory(sessionId);
      await openCodeRejectQuestion(sessionId, questionID, directory);
      break;
    }

    case 'summarize': {
      const { sessionId, directory, model } = stdinData || {};
      // summarize 需要项目目录来运行摘要任务；宿主未传时回退到 daemon 记录的会话目录。
      // 与 listMessages 同因：resolveSummarizeModel 要查 session.get，冷 serve 会静默失败。
      console.error(`[summarize] start sessionId=${sessionId} directory=${directory || '-'} model=${model || '(session default)'} pid=${process.pid}`);
      try {
        await ensureServerReady();
        console.error('[summarize] server ready, calling summarizeSession');
        await openCodeSummarizeSession(sessionId, directory || getSessionDirectory(sessionId), model);
        console.error('[summarize] summarizeSession resolved OK');
        console.log(JSON.stringify({ success: true, provider: 'opencode' }));
      } catch (err) {
        console.error(`[summarize] failed: ${err?.message || err}`);
        throw err;
      }
      break;
    }

    case 'shareSession': {
      const { sessionId, directory } = stdinData || {};
      const share = await openCodeShareSession(sessionId, directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode', share: share ?? null }));
      break;
    }

    case 'unshareSession': {
      const { sessionId, directory } = stdinData || {};
      await openCodeUnshareSession(sessionId, directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode' }));
      break;
    }

    case 'revert': {
      const { sessionId, messageID, directory } = stdinData || {};
      const session = await openCodeRevertSession(sessionId, messageID, directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode', session: session ?? null }));
      break;
    }

    case 'unrevert': {
      const { sessionId, directory } = stdinData || {};
      const session = await openCodeUnrevertSession(sessionId, directory || undefined);
      console.log(JSON.stringify({ success: true, provider: 'opencode', session: session ?? null }));
      break;
    }

    case 'fork': {
      const { sessionId, messageID, directory } = stdinData || {};
      const forked = await openCodeForkSession(sessionId, messageID, directory || undefined);
      // 与 listMessages 相同输出约定：单行 JSON。
      console.log(JSON.stringify({
        success: true,
        provider: 'opencode',
        newSessionId: forked?.id ?? '',
        session: forked ?? null,
      }));
      break;
    }

    default:
      throw new Error(`Unknown OpenCode command: ${command}`);
  }
}

export function getOpenCodeCommandList() {
  return [
    'send', 'listModels', 'listMessages', 'getSessionInfo', 'listAgents', 'listCommands',
    'listMcpServers', 'getMcpStatus', 'replyPermission', 'replyQuestion', 'rejectQuestion',
    'shareSession', 'unshareSession', 'revert', 'unrevert', 'fork', 'summarize',
  ];
}
