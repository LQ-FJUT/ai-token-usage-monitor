# v0.2.0 多来源验证记录（2026-08-28）

## 已通过

- `npm run typecheck`：通过。
- `npm test`：8 个测试文件、48 项测试通过。
- `npm run build`：通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：29 项通过；2 项依赖真实账户或完整历史的测试保持显式忽略。
- 多来源 Rust 夹具覆盖：Claude JSONL 缓存字段、损坏记录、不完整尾行、重复消息与文件删除；OpenCode `step-finish`、SQLite WAL 与增量替换；WorkBuddy 原始/规范化/trace 汇总回退、双来源隔离、备份排除；Cursor 未启用；v2 与 IPC 隐私回归。
- 真实只读索引抽样：Codex 251 个日志文件 / 10,905 事件，Claude Code 38 / 1,215，OpenCode 1 / 162，WorkBuddy 220 / 220，WorkBuddy AI 35 / 35；Cursor 为 `unavailable`。
- 实时来源会持续产生新记录，因此真实机第二次扫描采用“不会减少”的单调性检查；静态夹具已验证同一输入的第二次扫描不重复计数。
- 0.2.0 release 可执行文件以 `--background` 启动成功，前端 IPC 创建 `usage-index-v2.sqlite3`（802,816 bytes），并核验其中不存在完整用户路径或 `auth.json` 字样。测试进程已结束。
- NSIS current-user 离线安装包生成成功。构建时临时停用本机代理，因为代理会中断 Tauri 对 WebView2 离线安装器的 HEAD 校验；安装包仍内置离线 WebView2 运行时。

## 产物

- `release/AI Token 用量监控-0.2.0-Setup.exe`
- 大小：264,700,391 bytes
- SHA-256：`ABB6DFFA66CF9AAE4D95D5FF4ACB92F8A7EA7CCB4ABF27DF488A592166A6A0B3`
- v0.1.0 基线安装包和 SHA-256 保持不变；基线提交为 `ab162e0`，注释标签为 `baseline/v0.1.0`。

## 尚未声称通过

- 未在干净 Windows 虚拟机或另一台电脑执行 v0.2.0 安装、升级、卸载和数据保留验收。
- 未安装 v0.2.0 包覆盖本机现有版本；本次仅验证已打包的可执行文件与本机应用数据索引。
- WorkBuddy 的 `credit_json` 仅在包含明确余额字段时作为独立 Credits 显示；本机没有可显示的明确余额时会保持为空，且从不参与 Token 总量。
- Cursor 精确个人 Token 自动接入仍等待官方个人数据来源。
