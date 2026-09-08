# 第二阶段验证记录（2026-08-28）

## 已通过

- `npm test`：8 个测试文件、48 项测试通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：18 项通过，2 项真实机器联调测试默认忽略；两项已在本次开发中单独执行并通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- 当前登录的 Codex App Server 真实读取：通过；快照不包含账号对象、邮箱或原始响应。
- 当前机器 249 个 rollout、约 2.0 GB 历史的首次增量索引：通过，约 32 秒。
- release EXE 后台启动、前端 IPC 首轮刷新、SQLite 索引库和设置库创建：通过。
- 进程单实例：第二实例自动退出，首实例保持运行。
- 实际 SQLite 文件敏感文本抽查：未发现用户完整目录、当前测试提示词或 `auth.json`。
- WebView2 离线安装器：Microsoft Authenticode 签名有效。
- NSIS 安装包生成：通过。

## 产物

- `release/Codex用量监控-0.1.0-Setup.exe`
- 大小：264,654,830 bytes
- SHA-256：`6ADC7FDA390DF17A2711DDB8D33A882A9383A4B8060F1609FB4A2EE8DACA7829`

## 尚未声称通过

- 未在干净 Windows 虚拟机或另一台电脑执行安装。
- 未验证从旧版本升级、卸载以及卸载后是否按用户选择保留数据。
- 未给安装包做代码签名；从浏览器下载时可能出现 SmartScreen 提示。
- 本机已安装 WebView2，因此尚未实机验证安装包内置的离线 WebView2 安装分支。
