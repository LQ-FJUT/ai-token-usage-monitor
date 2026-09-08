# 多来源 Token 索引（v0.2.0）

## 目标与范围

本功能把本机可验证的 AI Token 活动汇总到一个独立看板，但不把它伪装成服务端套餐额度。当前接入顺序为 Claude Code、OpenCode 桌面版、WorkBuddy、WorkBuddy AI；Codex 保留原有 v1 增量索引。Cursor 显示等待官方个人数据来源。

所有读取均为本机只读：不联网、不登录、不扫描工作区产物，也不改动任何 AI 应用的原始数据。

## 数据源与稳定键

| 来源 | 只读数据 | 稳定去重键 | 说明 |
| --- | --- | --- | --- |
| Codex | `CODEX_HOME/sessions` | v1 rollout 与子代理边界 | v1 索引仍是唯一事实来源 |
| Claude Code | `~/.claude/projects/**/*.jsonl` | 会话 + assistant 消息 UUID 的不可逆哈希 | 仅读取带 `message.usage` 的 assistant 记录 |
| OpenCode 桌面版 | `~/.local/share/opencode/opencode.db` 与 WAL | `part.id` 的不可逆哈希 | 仅 `step-finish` Token 行 |
| WorkBuddy | `~/.workbuddy/traces` | trace 稳定键的不可逆哈希 | 仅标准 trace 文件 |
| WorkBuddy AI | `~/.workbuddy-ai/traces` | trace 稳定键的不可逆哈希 | 不扫描 `C:\Users\<你的用户名>\WorkBuddy AI` 工作区 |
| Cursor | 无 | 无 | 等待官方个人数据来源 |

## 索引内容与隐私

`usage-index-v2.sqlite3` 仅保存来源、不可逆键、时间、模型、脱敏项目标签和 Token 派生数字（新输入、缓存读取、缓存写入、输出、推理输出、总 Token）。它不保存对话文字、标题、完整路径、原始 JSON、会话 ID、账号或凭据。

源文件变化会重建该文件的映射；删除文件会删除已失去所有映射的事件。相同事件出现在多个 Claude JSONL 副本中时只统计一次，直到最后一个副本消失。

## 状态和失败隔离

每个来源独立显示：已就绪、未检测到、暂不支持或读取失败。一个来源失败不会阻断其他来源、本机 v2 索引，或 Codex 服务端额度区。来源级 Credits 与 Token 是不同单位，绝不相加。
