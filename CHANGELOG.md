# Change Log

All notable changes to the "opencode-buddy" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
- Remove the Open Source Star banner that prompted users to star the GitHub repository

## Format

Each released version uses a `##### **日期（vX.Y.Z）**` header followed by two
sections marked with `中文：` and `English：`. Consumers of this file:

- `webview/scripts/extract-changelog.mjs` → bundled `webview/src/version/changelog.ts`
- `tools/extract-release-notes.mjs` → GitHub Release body (emits the English
  section under an `### English` heading, which the in-extension changelog
  dialog splits on to render one Chinese and one English block)

##### **2026年11月2日（v2.0.1）**

中文：
🐛 问题修复
- 修复出现错误提示后无法继续发送消息的问题
- 修正相关界面显示错误

English：
🐛 Fixes
- Fixed messages being blocked after an error notice appeared
- Corrected related UI display issues

##### **2026年11月1日（v2.0.0）**

中文：
✨ 新增功能
- 支持自动压缩 Token，长对话自动收敛上下文
- 对齐 IDEA 版队列机制：CLI 自动探测回填、技能管理、提示音通知
- 重构回合生命周期与发送、推理、撤销、通知流程
- 后台标签页消息改为排队发送，不再打断当前会话
- 模型支持拖拽置顶，命令、Todo、附件草稿按标签页隔离
- 新增终端错误提示与 command.rejected 通知，补齐 8 种语言文案

🐛 问题修复
- 修复历史会话下载与删除、子代理状态显示
- 修复导出 Markdown 生成空文件、成功提示时机不对
- 修复权限弹窗边框与弹窗队列归属
- 修复流式响应路由与模型推荐推理力度
- 修复会话标题被覆盖、模式多语言、编辑器上下文
- 修复标签页重新同步失败导致无法发送消息
- 修复多标签串流、附件归属等会话隔离问题

English：
✨ Features
- Automatic token compaction keeps long conversations within the context window
- Aligned queue mechanics with the IDEA plugin: CLI auto-detection backfill, skill management, and notification sounds
- Reworked the turn lifecycle and the send, reasoning, undo, and notification flows
- Background-tab messages now queue instead of interrupting the active conversation
- Models can be drag-pinned; commands, todos, and attachment drafts are scoped per tab
- Added terminal error notices and command.rejected notifications, with copy for 8 locales

🐛 Fixes
- Fixed history session download and deletion, and subagent status display
- Fixed Markdown export writing an empty file and the success toast firing too early
- Fixed the permission dialog border and prompt queue ownership
- Fixed streaming response routing and model-recommended reasoning effort
- Fixed session titles being overwritten, mode i18n, and editor context
- Fixed tab resync failures that blocked sending messages
- Fixed cross-tab streaming leaks and attachment ownership

##### **2026年10月14日（v0.1.0）**

中文：
🐛 问题修复
- 修复 GitHub 打包失败

English：
🐛 Fixes
- Fixed the GitHub packaging failure

##### **2026年10月14日（v0.0.9）**

中文：
✨ 新增功能
- 支持 OpenCode v2：问题弹窗、权限弹窗最小化
- 架构重构：移除 ai-bridge，改用 opencode-buddy-core，支持多会话

🔧 其他
- 本地开发支持链接本地 core 仓库
- 补充 v2 兼容性与破坏性变更文档

English：
✨ Features
- OpenCode v2 support, with a question dialog and a minimizable permission dialog
- Architecture overhaul: replaced ai-bridge with opencode-buddy-core and added multi-session support

🔧 Other
- Local development can link the local core repository
- Documented v2 compatibility and breaking changes

##### **2026年10月10日（v0.0.8）**

中文：
✨ 新增功能
- 新建对话不再中断正在运行的会话

🐛 问题修复
- 修复 Token 显示与详细消息展示
- 修复启动时重复拉起 opencode serve

English：
✨ Features
- Starting a new conversation no longer interrupts the running one

🐛 Fixes
- Fixed token display and detailed message rendering
- Fixed opencode serve being launched repeatedly at startup

##### **2026年9月22日（v0.0.7）**

中文：
✨ 新增功能
- 添加赞助者信息

🐛 问题修复
- 修复 Token 消耗显示与模型列表默认选中项
- 修复 MCP 加载失败
- 重构模型列表并修复字体加载
- 修复日志异常与超时自动结束对话
- 修复启动状态栏与 opencode 进程生命周期

English：
✨ Features
- Added sponsor information

🐛 Fixes
- Fixed token consumption display and the model list default selection
- Fixed MCP loading failures
- Rebuilt the model list and fixed font loading
- Fixed logging issues and the timeout that auto-ended conversations
- Fixed the startup status bar and the opencode process lifecycle

##### **2026年9月17日（v0.0.6）**

中文：
✨ 新增功能
- 支持多标签多会话
- 支持会话导出为 Markdown

🔧 其他
- 补足单元测试

🐛 问题修复
- 修复 Linux 下图标与文字对齐

English：
✨ Features
- Multiple tabs and sessions
- Session export to Markdown

🔧 Other
- Expanded unit test coverage

🐛 Fixes
- Fixed icon and text alignment on Linux

##### **2026年9月16日（v0.0.5）**

中文：
🔧 其他
- 修改开源协议

English：
🔧 Other
- Changed the open-source license

##### **2026年9月16日（v0.0.4）**

中文：
✨ 新增功能
- 重构附件、@ 文件引用、!bash、/opencode 命令与上下文压缩流程

🐛 问题修复
- 修复消息撤销、恢复与 Fork
- 修复 Token 上下文额度显示错误
- 修复权限审批与问题回答偶发报错
- 修复文件上传失败
- 修复弹窗与字体导致的 UI 对齐
- 修复设置项与 README 显示问题

English：
✨ Features
- Reworked attachments, @ file mentions, !bash and /opencode commands, and context compaction

🐛 Fixes
- Fixed message undo, redo, and fork
- Fixed an incorrect token context limit
- Fixed intermittent permission approval and question answer errors
- Fixed file upload failures
- Fixed UI alignment issues caused by dialogs and fonts
- Fixed settings and README display problems

##### **2026年9月6日（v0.0.3）**

中文：
✨ 新增功能
- 支持主代理与子代理，历史会话分页加载
- 会话压缩增加二次确认与完成提示
- 未安装 opencode 时启动弹窗提醒

🐛 问题修复
- 修复大对话加载子代理时的 OOM
- 修复加载历史消息出现空响应
- 修复分享按钮失效
- 修复图标显示与图标文字居中
- 修复图表文字对齐
- 修复赞赏码显示不一致

🔧 其他
- 调整会话压缩流程与界面元素对齐

English：
✨ Features
- Main agent and subagent support, with paginated history loading
- Session compaction now asks for confirmation and shows a completion notice
- A startup dialog when opencode is not installed

🐛 Fixes
- Fixed OOM when loading subagents in large conversations
- Fixed empty responses when loading history messages
- Fixed the broken share button
- Fixed the icon and icon text centering
- Fixed chart text alignment
- Fixed inconsistent donation QR display

🔧 Other
- Adjusted the session compaction flow and UI alignment

##### **2026年9月4日（v0.0.2）**

中文：
🐛 问题修复
- 修复问题卡片状态显示
- 隐藏尚未开发的下载会话按钮

🔧 其他
- 更新已知问题文档

English：
🐛 Fixes
- Fixed the issue-card status display
- Hid the not-yet-implemented download-session button

🔧 Other
- Updated the known-issues document

##### **2026年9月2日（v0.0.1）**

中文：
🔧 其他
- 初始化仓库，确定插件名称 OpenCode Buddy 与扩展 ID
- 统一打包与发布：单一通用 VSIX、图标改为黑色、README 图片可重写
- 最低 VS Code 版本降至 1.85
- Webview 拆为独立 pnpm 工程，修正 bootstrap 注入位置

English：
🔧 Other
- Initialized the repository and settled on the OpenCode Buddy name and extension id
- Unified packaging and releases: one universal VSIX, a black icon, rewritable README images
- Lowered the minimum VS Code version to 1.85
- Made the webview a standalone pnpm project and fixed where the bootstrap is injected
