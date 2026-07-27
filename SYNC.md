# SYNC.md — 与 Claude Code 版的关系

opencode 版和内部的 Claude Code 版 ralph-flow **功能一致**，但**只有工作流逻辑是镜像**，
运行层是 opencode 原生实现（不逐行对应 server.mjs）。两个仓库不共享代码工件、允许各自分叉。

**为什么运行层不镜像**：Claude 版是「每会话一个 MCP server 进程」，靠文件系统在多进程间协调
（跨进程文件锁、ppid 会话身份推断、pid 存活判定）。opencode 是「每项目目录一个插件进程服务所有
会话」——共享内存、事件自带 sessionID。把 server.mjs 的多进程机制原样镜像过来会**主动引入 bug**
（State lock timeout 死锁、console 冲乱 TUI、往项目写文件污染工作区都源于此）。所以运行层照抄的是
**原 opencode 插件作者的原生设计**：函数显式传 `directory`/`instId`、无锁、内存协调。

参考基线：Claude Code 版 `mcp-server/server.mjs`（2.1.x 多实例 + 全局工作流）。

## 镜像的部分（工作流逻辑，对照 server.mjs 同步）

| server.mjs 分节 | opencode | 说明 |
|---|---|---|
| parseWorkflowFile / loadWorkflow / listWorkflows | `engine.ts` 同名 | 校验规则、错误文案、三层解析（项目>全局>内置）逐一一致 |
| lintWorkflow / diagnoseWorkflowFiles / buildDoctorReport | `engine.ts` 同名 | doctor 全部诊断逻辑一致 |
| buildDoPrompt / buildCheckPrompt / buildSubWorkflowUserTask | `engine.ts` 同名 | 提示词模板逐字一致（仅路径 `.claude/`→`.opencode/`） |
| handleCheckPassed / handleCheckFailed / resolveSubWorkflowEntry | `engine.ts` 同名 | 检查结果状态机、子工作流栈、暂停/重试路由一致 |
| buildReportText / migrateLegacyInstance | `engine.ts` 同名 | 报告格式一致；迁移源不同（旧 opencode 是 `ralph-flow.local.md`） |
| adversarialCheck 的**结果契约** `{passed, infra?, reason}` + infra/工作失败分类 | `check.ts` | 契约一致；执行载体从 spawn `claude -p` 换为 SDK 独立 session |
| 六个工具的**行为与文案** | `tools.ts` | 同名（ralphflow_start/continue/…），continue 同样三阶段；文案一致 |

## 原生的部分（运行层，不对照 server.mjs）

| 关注点 | Claude 版（多进程） | opencode 版（单进程原生） |
|---|---|---|
| 实例绑定 | 模块级 `boundInstanceId` + `bindInstance` | **无**。每个实例作用域函数显式传 `instId` |
| 并发协调 | 内存 `withLock` + 跨进程 `withInstanceLock`（`.lock` + pid 判死） | **无锁**。单进程 + 每会话回合模型天然串行；驱动器仅一个每会话在途守卫（`drivingSessions`） |
| 会话身份 | ppid → `~/.claude/sessions/<ppid>.json` | 事件/工具自带 `context.sessionID` |
| 所有权 | `owner-session` 文件 + pid 存活判定 | `state.json` 里的 `session_id` 字段；**无存活探测**（opencode 无法廉价判定会话是否关闭） |
| 实例接管 | 属主 pid 死 → 自动；活 → 需显式 id | 显式 id 接管，或「项目内仅一个实例」时自动接管 |
| done 检测 | Stop hook 读 transcript JSONL，`decision:"block"` 回注 | `session.idle` 事件 + `client.session.messages`；`client.session.prompt` 注入 |
| 只通知不驱动 | hook systemMessage（无 block） | `client.session.prompt({ noReply: true })` |
| PostToolUse owner 绑定 hook / `[instance:id]` 响应标记 | 有 | **删除**（sessionID 自带，无需） |
| 孤儿实例通知 | Stop hook 检测无人驱动并提示 | **删除**（无存活探测无法可靠判定；接管改为显式） |

> 死锁根因备忘：曾把整个 `handleSessionIdle` 包进 `withLock` 并在其中 `await injectPrompt`（驱动一整轮
> 模型，几十秒），锁被长期攥着，`ralphflow_continue` 拿不到锁 30s 超时报 "State lock timeout"。原生
> 无锁设计从根上消除了这类 bug（有回归测试守护）。

## 平台差异（路径 / 目录 / 机制）

| 差异点 | Claude Code 版 | opencode 版 |
|---|---|---|
| 状态根目录 | `.claude/ralph-flow/` | `.opencode/ralph-flow/` |
| 全局配置家目录 | `$CLAUDE_CONFIG_DIR` 或 `~/.claude` | `$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode` |
| 全局工作流目录 | `~/.claude/ralph-flow/workflows/` | `~/.config/opencode/ralph-flow/workflows/`（项目>全局>内置三层解析一致） |
| skill 发现 | `plugin.json` 的 `"skills":["./skills"]` 原生加载，零拷贝、不碰项目 | 无原生机制，`setup.ts` 同步到全局 `~/.config/opencode/skills/`（`.ralph-flow-managed` 标记，不覆盖用户同名，清理旧版误拷进项目的副本） |
| CHECK agent | CLI `--allowedTools` 只读白名单，无 agent 概念 | `config` hook 内存注册 + 全局 `~/.config/opencode/agent/ralph-check.md` 文件（双保险，不碰项目） |
| CHECK 权限 | CLI `--allowedTools` 白名单（Read/Glob/Grep + 一批非变更 bash 命令） | `ralph-check` agent：`edit: deny`（硬约束）+ `bash: allow`（全开），不靠 bash 白名单——与 opencode 内置的 `plan`/`explore` agent 同形；防篡改落在 `edit: deny` + 系统提示词（Authority + 反理性化表 + "别信报告"，参考 superpowers 方法论） |
| CHECK 执行 | spawn `claude -p` 子进程 | SDK 独立 session + `ralph-check` agent（`edit: deny`） |
| CHECK 取消 | `.adversarial-pid` 跨进程 kill 进程树 | `.adversarial-session` + 内存 `activeChecks`，`session.abort`；跨进程触达不到，结果由 phase-3 状态校验丢弃 |
| adversarial_check.model | 字符串（CLI `--model`） | `{providerID, modelID}` 或 `"provider/model"`；裸名（如 `sonnet`）无法解析→回退 agent 默认（doctor 警告）；对象形式缺 `providerID`/`modelID` 同样被忽略并警告。未配置时默认跟随**属主会话当前模型**（新验证会话无历史，服务端只会回退全局默认，故由插件读属主会话最近 user 消息补位；验证 agent 显式 model 优先于它） |
| adversarial_check.agent | 不支持（doctor 警告） | 支持（默认 `ralph-check`） |
| adversarial_check 继承 | （待确认 Claude 版行为） | 沿子工作流链**逐字段**继承（`getEffectiveAdversarialCheck`）：子工作流填了且有效的字段覆盖父，无效/缺失字段回退父链 |
| CHECK 请求失败 | 子进程非零退出→stderr 进 reason | SDK `throwOnError=false`，`{error}` 体由 `extractRequestError` 透传（如 `Model not found`），事件 `adversarial_check_request_failed` |
| extra_dirs | 传子进程 `--add-dir` | 仅校验存在 + 写入提示词（ralph-check agent 有 `external_directory: allow`） |
| ESC/中断 | 无法感知 | `session.error(MessageAborted)` / `session.deleted` → 暂停实例（`pause_reason: session_aborted/deleted`） |
| compaction | 无对应事件 | `session.compacted` → 按 idle 处理，用缓存 DO 提示词重新驱动 |
| 诊断输出 | `console.error` 进独立进程 stderr（无害） | 与 TUI 同进程，**禁用 console**，写文件 `logs/plugin-diag.log` |

## 工作流文本转换

Claude 版 workflows/*.yaml → opencode 版时的机械替换：

- `调用 ralph-flow:<name> skill` → `用 skill 工具调用 <name> skill`
- `model: sonnet` / `model: Opus` → 注释掉（附 opencode 格式示例）
- `.claude/ralph-flow` → `.opencode/ralph-flow`

skills/*/SKILL.md 的转换只有一处：产出目录示例路径 `.claude/ralph-flow/artifacts/` → `.opencode/ralph-flow/artifacts/`。

## 同步流程（Claude 版更新后）

1. diff Claude 仓库 `server.mjs` 相对上次基线的变化。
2. **只把「镜像的部分」表里的工作流逻辑改动**翻译到 `engine.ts` 对应同名函数（提示词/状态机/校验/doctor）。
   运行层（锁、会话身份、所有权、驱动方式）**不跟着改**——那是各自平台的原生实现。
3. workflows/skills 直接重拷 + 「工作流文本转换」的机械替换。
4. `npm run typecheck && npm test`，必要时补断言。
5. 更新本文件。
