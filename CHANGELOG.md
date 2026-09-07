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

##### **2026年9月6日（v0.0.3）**

中文：
- ✨修复OOM问题，大型对话场景，加载子代理 (147aef9)
- ✨支持主代理，子代理。历史会话分页加载。 (68016b1)
- 🐛 修复分享按钮 (cad5b1e)
- 🐛修复图标问题 (ef3a936)
- ✨调整压缩会话流程，修复界面元素对齐问题 (1b9a85c)
- ✨压缩会话二次确认，结束有提示 (27a4db1)
- 🐛修复加载历史消息出现空响应问题 (06f1382)
- ✨修复图表文字对齐问题 (c7e713a)
- Reapply "✨ 修复图标文字不居中问题" (43e69e3)
- Revert "✨ 修复图标文字不居中问题" (55e29df)
- ✨没有安装opencode，插件启动时会弹窗提醒 (a3e07da)
- ✨ 修复图标文字不居中问题 (7825ed7)
- [fix]修复赞赏码不一致显示问题 (e18817d)

English：
- ✨ Fix OOM issue when loading sub-agents in large conversation scenarios (147aef9)
- ✨ Support main agent and sub-agents; paginated loading of session history (68016b1)
- 🐛 Fix the share button (cad5b1e)
- 🐛 Fix icon issue (ef3a936)
- ✨ Adjust the session-compaction flow; fix UI element alignment (1b9a85c)
- ✨ Add a secondary confirmation for session compaction with a completion notice (27a4db1)
- 🐛 Fix empty-response issue when loading history messages (06f1382)
- ✨ Fix chart text alignment (c7e713a)
- Reapply "✨ Fix icon text centering" (43e69e3)
- Revert "✨ Fix icon text centering" (55e29df)
- ✨ Show a reminder dialog at startup when opencode is not installed (a3e07da)
- ✨ Fix icon text centering (7825ed7)
- [fix] Fix inconsistent donation-QR display (e18817d)

##### **2026年9月4日（v0.0.2）**

中文：
- docs: 更新已知问题文档 (198c88b)
- [fix] 卡片状态修复 (a6e0e9e)
- 🐛 修复问题卡片状态问题，隐藏未开发的下载会话按钮 (077f2d8)

English：
- docs: Update the known-issues document (198c88b)
- [fix] Fix card status (a6e0e9e)
- 🐛 Fix issue-card status; hide the not-yet-implemented download-session button (077f2d8)

##### **2026年9月2日（v0.0.1）**

中文：
- [add] 修复插件名称 (d658666)
- build(release): rename extension to OpenCode Buddy (opencode-buddy) (58ed13d)
- fix(release): derive VSIX filename from package.json name (057a864)
- [add]修改插件id (2594cc3)
- [add] 修改插件id (df30bc4)
- [add] 修改名称 (3ec6c8b)
- build(icon): switch marketplace icon to black (was purple #8B5CF6) (f562a62)
- build(release): rename extension id to opencode-x; ship one universal VSIX (0f3944f)
- fix(webview): anchor bootstrap injection on real <head> tag; align @types/vscode with engines (c85bdf8)
- build: rename extension display name to OpenCode X; lower min VS Code to 1.85 (7c2d754)
- build(ci): exclude webview/node_modules from VSIX (fix vsce 'not a file' error) (3c53657)
- build(ci): declare repository URL so vsce can rewrite README images (e6a3226)
- build(ci): make webview a standalone pnpm project (fix vite/client build) (23561c0)
- build(ci): migrate pnpm build-script allowlist to v11 allowBuilds (26f37c2)
- build(ci): allow esbuild/@swc/core install scripts for pnpm v10+ (33b6aaf)
- [init] 初始化仓库 (3a93adc)
- Initial commit (6fac116)

English：
- [add] Fix plugin name (d658666)
- build(release): rename extension to OpenCode Buddy (opencode-buddy) (58ed13d)
- fix(release): derive VSIX filename from package.json name (057a864)
- [add] Change the plugin id (2594cc3)
- [add] Change the plugin id (df30bc4)
- [add] Change the name (3ec6c8b)
- build(icon): switch marketplace icon to black (was purple #8B5CF6) (f562a62)
- build(release): rename extension id to opencode-x; ship one universal VSIX (0f3944f)
- fix(webview): anchor bootstrap injection on real <head> tag; align @types/vscode with engines (c85bdf8)
- build: rename extension display name to OpenCode X; lower min VS Code to 1.85 (7c2d754)
- build(ci): exclude webview/node_modules from VSIX (fix vsce 'not a file' error) (3c53657)
- build(ci): declare repository URL so vsce can rewrite README images (e6a3226)
- build(ci): make webview a standalone pnpm project (fix vite/client build) (23561c0)
- build(ci): migrate pnpm build-script allowlist to v11 allowBuilds (26f37c2)
- build(ci): allow esbuild/@swc/core install scripts for pnpm v10+ (33b6aaf)
- [init] Initialize the repository (3a93adc)
- Initial commit (6fac116)
