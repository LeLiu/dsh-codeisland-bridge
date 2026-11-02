# dsh-codeisland-bridge

把 DeepSeek Harness（DSH）的会话、工具调用、审批实时转发到 **CodeIsland** 刘海面板。

CodeIsland 对 DSH 只内置了「来源标签」（`source: dsh`），**不会**主动读取 DSH 的任何状态；它唯一的事件入口是 `/tmp/codeisland-<uid>.sock` 上的 hook JSON。本插件就是那个发射器：一个不拉起面板、不读会话日志的纯转发插件。

## 它能给你什么

| CodeIsland 卡片上的东西 | 来源 |
|---|---|
| 会话出现 / 结束 | `session/created` → `SessionStart`，`session/disposed` → `SessionEnd` |
| 最近一次提问（标题区） | `agent/pre-step` → `UserPromptSubmit`（带 prompt 文本） |
| 运行中 / 当前工具 | `tools/pre-execute` / `tools/post-execute` → `PreToolUse` / `PostToolUse(Failure)` |
| 最近回复 | `session/event`（assistant/message）→ `Stop.last_assistant_message` |
| 等待授权 + 在刘海上点允许/拒绝 | `approval/request` → `PermissionRequest`，决策回写为 `allowed-once` / `rejected` |
| 子代理 | `subagent/start|end` → `SubagentStart` / `SubagentStop` |

拿不到的：token 用量、完整 transcript、点击跳转到终端——这些 CodeIsland 只从各 CLI 的本地日志读，而 DSH 的会话日志是 zstd 压缩的，它没有对应 reader。

## 安装

插件要装进**你实际在跑的 profile**：

```bash
# 未发布 npm 前，直接从 GitHub 源码装：
dsh plugin --profile web add github:LeLiu/dsh-codeisland-bridge

# CLI profile（web / headless / 自建，npm 发布后）
dsh plugin --profile web add dsh-codeisland-bridge

# 桌面端（DSH Desktop）的 profile 由应用独占，CLI 装不进去：
# 菜单栏「桌面插件…」里填 dsh-codeisland-bridge，或用它的插件市场安装。
```

本地开发可以直接链目录：

```bash
dsh plugin --profile headless add /absolute/path/to/dsh-codeisland-bridge
```

装完重启对应的 DSH 进程 / 应用。

## 配置

所有字段都有默认值，全部可省：

```yaml
# 在你自己的 profile patch 层里按 id 覆盖（不是本包的 cordis.patch.yml）
- id: codeisland-bridge
  config:
    socketPath: /tmp/codeisland-501.sock   # 默认 $CODEISLAND_SOCKET_PATH 或 /tmp/codeisland-<uid>.sock
    source: dsh                            # CodeIsland 的来源标识，决定卡片显示为 DeepSeek Harness
    approvals: true                        # 把 approval/request 转发到刘海
    approvalTimeoutMs: 300000              # 等太久就交还给其他 answerer
    connectTimeoutMs: 1500                 # 普通事件的连接/回执预算
    subagents: true                        # 上报子代理启停
    toolInput: false                       # 是否把工具参数（命令/文件内容）也发过去
    maxReplyChars: 4000                    # Stop 携带的回复文本上限
```

## 行为约定

- **永不阻塞 agent**：所有非审批监听器都 `return next()`，发送是 fire-and-forget；CodeIsland 没开时静默跳过。
- **审批不越权**：刘海返回 `allow`/`always` 才映射为 `allowed-once`，`deny` 映射为 `rejected`；超时、断线或 CodeIsland 未运行一律 `next()` 交还给其它 answerer，而不是在这里 fail-closed。
- **代码即文档**：payload 字段就是 CodeIsland 的 hook 协议（`hook_event_name` / `session_id` / `cwd` / `tool_name` / `tool_use_id` / `_source`）。
- **隐私**：默认不发送 `tool_input`；`last_assistant_message` 只发本会话最后一条助手文本。

## 验证

```bash
node --test test/*.test.mjs     # 18 个用例：payload 映射、审批决策、超时、无 island 降级
python3 -c "import json;print(json.load(open('$HOME/.codeisland/sessions.json'))[-1])"   # 跑一次会话后应出现 source: dsh
```

## 卸载

```bash
dsh plugin --profile <name> remove dsh-codeisland-bridge
```

## 许可

MIT
