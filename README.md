# Antigravity 2.0 桌面端纯渲染层中文补丁 (`antigravity-zh-patch`)

[![CI](https://github.com/mop74720-commits/antigravity-zh-patch/actions/workflows/ci.yml/badge.svg)](https://github.com/mop74720-commits/antigravity-zh-patch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

这是一个**零第三方依赖、完全可逆、支持版本更新自动检测与安全中止**的 Antigravity 2.0 桌面端纯前端 DOM 汉化补丁工具。

## 合规与安全设计原则

1. **绝不触碰后台服务与网络通信**
   - 不修改 `language_server.exe` 与 `Antigravity.exe`。
   - 不拦截、不劫持、不伪造任何网络请求、OAuth 凭据、gRPC 接口或遥测数据。
2. **严格作用域隔离**
   - 仅在 Electron 主入口（根据 `app.asar` 内 `package.json` 的 `main` 自动定位）注入一行安全加载器，在主窗口 `https://127.0.0.1:<port>/` 渲染层挂载 `MutationObserver`，且校验存在 `window.electronNative` / `window.nativeStorage`。
   - 自动跳过 `<webview>` 浏览器标签页、代码块（`<pre>` / `<code>` / Monaco / xterm）、输入框与第三方网页，不影响开发预览与账号登录弹窗。
3. **Electron ASAR Fuse 安全中止护栏**
   - 打补丁前自动读取 `Antigravity.exe` 中的 Electron Fuse 标志位；如果未来官方版本启用了 `EnableEmbeddedAsarIntegrityValidation`，补丁会**直接中止且不改写任何文件**，绝不强行绕过校验。
4. **可随时一键恢复官方原版**
   - 打补丁前自动按版本号与 SHA-256 备份原版 `app.asar` 到 `%USERPROFILE%\.antigravity-zh\backups\`，随时执行 `restore.bat` 即可逐字节还原。

---

## 快速使用

> **下载与环境要求**：可直接前往 [Releases](https://github.com/mop74720-commits/antigravity-zh-patch/releases) 下载 `antigravity-zh-patch-win.zip` 并解压到任意英文路径使用。无需专门安装 Node.js！如果电脑没有 Node.js，双击 `.bat` 脚本会自动调用 Antigravity 2.0 内置运行时执行（也兼容直接用 Node.js 18+ 运行）。

### 1. 应用汉化补丁
1. **完全退出 Antigravity 2.0 桌面端**（确认系统托盘图标也已退出）。
2. 双击运行 **`patch.bat`**（或在终端执行 `node cli.mjs patch`）。
3. 重新打开 Antigravity 2.0 即可看到中文界面。

### 2. 实时切换中英文
- 在 Antigravity 2.0 窗口内随时按下 **`Ctrl+Alt+L`**，可在“中文界面”与“原版英文界面”之间无刷新瞬时切换。

### 3. Antigravity 官方更新后如何适配？
- 当 Antigravity 自动更新到新版本后，新版本的官方 `app.asar` 会覆盖旧文件（外置词典与自定义词条不会丢失）。
- 只需退出 Antigravity 后再次双击 **`patch.bat`**（或执行 `node cli.mjs check-update` 检测），即可在数秒内完成新版本适配；新版界面新增的未收录英文词条会平滑保留英文，不会白屏或报错。
- **无感自动适配（推荐）**：也可以直接双击 **`launch-zh.bat`**（或为其创建桌面快捷方式）作为日常启动入口。启动前脚本会自动执行检测，如发现官方刚更新且尚未启动主程序，会自动在 1~2 秒内重打补丁后再打开 Antigravity 2.0。

### 4. 一键还原为官方原版
- 退出 Antigravity 2.0 后，双击运行 **`restore.bat`**（或执行 `node cli.mjs restore`）。

---

## 自定义翻译与词典微调

外置词典位于 `%USERPROFILE%\.antigravity-zh\dicts\`：
- `00_community_zh.json` 与 `regex_rules.json`：默认采用 MIT 授权的 `yiheng8023/antigravity-chinese` 词库经清洗、严格锚定与去重合并生成；双击 **`update-dicts.bat`** 或执行 `node cli.mjs update-dicts` 可在线刷新（仅做纯 JSON 清洗解析，绝不执行任何外部脚本）。
- 如需在本机个人环境中补充更多社区词条，可执行 `node cli.mjs update-dicts --all-sources`：该模式额外合并 `qqxpee/antigravity2-cn` 与 `Silas-02/antigravity-desktop-cn` 的词条（重叠时以 MIT 词库优先），**仅写入你本机的 `%USERPROFILE%\.antigravity-zh\dicts\`**，不会修改本仓库，并在更新前自动备份上一版到 `%USERPROFILE%\.antigravity-zh\backups\00_community_zh.prev.json`。
- `custom.json`：你的个人自定义翻译（优先级最高，执行 `patch`、`sync-dicts` 或 `update-dicts` 时**永远保留不覆盖**）。
- `config.json`：可调整 `enabled`（开关）、`translateMenus`（是否翻译原生菜单与托盘）、`collectUntranslated`（设为 `true` 可自动把界面上尚未翻译的按钮/菜单英文收集到 `%USERPROFILE%\.antigravity-zh\untranslated.json`，方便你补全到 `custom.json`）。

修改词典（`dicts/*.json`）后无需重新打补丁，在窗口按 `Ctrl+R` 刷新或重启窗口即可生效；若修改了 `config.json` 中的 `translateMenus`，需完全重启一次 Antigravity 2.0 主进程后生效。

---

## 开源许可证与第三方声明

- 本项目代码与默认分发词典采用 **MIT License**（详见 [LICENSE](./LICENSE)）。
- 第三方社区词库版权与许可证原文见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)（致谢 `yiheng8023/antigravity-chinese`）。
