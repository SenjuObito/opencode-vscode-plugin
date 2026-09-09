---
name: opencode-api-verify
description: 验证 opencode server HTTP API 的请求体格式（尤其是附件/file part），并在 opencode-idea-gui 与 opencode-vscode-plugin 两个仓库间同步 ai-bridge 改动。当出现「附件没传上去 / 消息发不出去 / 接口 400」或需要确认 opencode 接口字段时使用。
agent_created: true
---

# opencode 接口验证与双仓库同步

## 何时用

- 现象是「附件没传上去」「请求被拒绝」「parts 丢了」
- 需要确认 opencode server 某个接口的字段结构
- 改完 `ai-bridge/` 需要同步到另一个仓库

## 核心原则：不要信参考实现

SenjuObito 维护的两个 GUI 客户端（`opencode-idea-gui`、`opencode-vscode-plugin`）
共用同一份 `ai-bridge/` 拷贝。**同一个 bug 经常两边一模一样**，所以拿其中一个当"正确
写法"参考是无效的。唯一 ground truth 是 opencode 服务端源码：

- schema 定义：`packages/schema/src/v1/session.ts`（`FilePartInput` 等）
- 服务端处理：`packages/opencode/src/session/prompt.ts`
- 本地源码仓库通常在 `~/source/repos/opencode`
- 也可查已安装的 SDK 类型：`ai-bridge/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`

## 零成本实测（关键技巧）

本机常驻 opencode serve：`http://127.0.0.1:4096`（`curl /global/health` 看版本）。

验证请求体**不要触发模型推理**，用 `noReply: true` 只落库：

```bash
SID=$(curl -s -X POST http://127.0.0.1:4096/session -H 'Content-Type: application/json' -d '{}' | jq -r .id)
curl -s -w "\nHTTP %{http_code}\n" -X POST "http://127.0.0.1:4096/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"t"},{"type":"file","mime":"text/plain","filename":"a.txt","url":"data:text/plain;base64,aGVsbG8="}],"noReply":true}'
# 204 = 通过；400 会返回 {"name":"BadRequest","data":{"message":"Missing key\n  at [\"parts\"][1][\"mime\"]"}}
curl -s "http://127.0.0.1:4096/session/$SID/message"   # 确认 part 是否落库
curl -s -X DELETE "http://127.0.0.1:4096/session/$SID" # 用完务必删掉测试会话
```

## opencode FilePartInput（当前版本）

```ts
{ id?: string; type: "file"; mime: string; filename?: string; url: string; source?: FilePartSource }
```

- `mime` 和 `url` **必填**，缺一个整个 prompt 请求 400
- `url` 支持 `data:<mime>;base64,<payload>` 和 `file://<abs path>`
  （`file:` 会走 opencode 自己的 Read 工具；`data:` 更适合远程 server）
- `data:` + `text/plain` 会被服务端内联成可读文本，所以源码类附件映射到 `text/plain` 更划算
- 非图片 mime（application/pdf、application/octet-stream 等）**服务端接受**，不要自己过滤

## 双仓库同步规则

`ai-bridge/` 两边是拷贝关系，但**不是全部文件都相同**：

| 文件 | 处理方式 |
|---|---|
| `utils/cli-image-input.js` | 通常完全一致，可直接 `cp` |
| `services/opencode/opencode-sdk-client.js` | 通常完全一致，可直接 `cp` |
| `services/opencode/opencode-daemon-service.js` | **有差异**（vscode 版多了 tool output 截断逻辑），必须分别改，不能 `cp` |

同步前先 `diff` 确认基线，改完再 `diff` 确认只剩预期差异。

两边都要跑：`node --test ai-bridge/utils/file-parts.test.js`

## 已知坑

- `ai-bridge/daemon.js` 的 stderr 会被宿主转成 `node_log` 事件。往 `console.error` 打印
  完整请求体会把几 MB 的 base64 灌进 UI 日志 —— 大 payload 必须脱敏后再打。
- idea 插件有第二份副本在 `build/idea-sandbox/.../plugins/opencode-buddy-jetbrains/ai-bridge/`，
  是 Gradle 构建产物。改完源码要重新 build 才会生效，别拿沙箱副本当源码改。
- 本环境里 bash 的 `grep`/`diff` 偶发返回空结果，用 Grep 工具或直接重跑更可靠。
- `ai-bridge/utils/cli-image-input.test.js` 在 idea 仓库跑不起来（import 了不存在的
  grok 服务），已删除；相关覆盖迁移到 `utils/file-parts.test.js`。
