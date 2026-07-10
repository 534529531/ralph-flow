# SYNC.md — 与 Claude Code 版的结构映射

本插件（opencode 版）与内部的 Claude Code 版 ralph-flow 是**结构镜像**：核心引擎的
分节、函数名、函数体逐一对应，平台差异收敛到薄适配层。两个仓库不共享代码工件，
允许各自分叉；同步方式是**对照 diff 机械翻译**。

参考基线：Claude Code 版 `mcp-server/server.mjs`（2.0 多实例架构）+ `hooks/done-detect.js` + `hooks/post-tool-phase.js`。

## 文件映射

| Claude Code 版 | opencode 版 | 说明 |
|---|---|---|
| `mcp-server/server.mjs` 工具注册以外的全部（L43–L2235） | `src/engine.ts` | 逐节镜像，函数名/顺序/文案一致 |
| `server.mjs` adversarialCheck（spawn `claude -p`） | `src/check.ts` | 同一结果契约 `{passed, infra?, reason}`；执行载体换为 SDK 独立 session |
| `server.mjs` server.tool(...) ×6 | `src/tools.ts` | 六个工具同名（ralphflow_start/continue/cancel/status/list/doctor），continue 同样是三阶段编排 |
| `hooks/done-detect.js`（Stop hook） | `src/driver.ts` | session.idle 事件驱动；marker 文件名逐一相同 |
| `hooks/post-tool-phase.js`（PostToolUse） | **无对应文件** | opencode 工具调用自带 sessionID，owner 绑定在工具内完成；响应里的 `[instance: id]` 标记也随之取消 |
| `skills/ralphflow-*/SKILL.md` ×7 | `src/commands.ts` | 逐字移植为 command 模板（路径 `.claude/` → `.opencode/`） |
| `skills/<domain>/`（c-to-rust ×5、everything2rust ×7） | `skills/<domain>/` | 目录整体复制；`setup.ts` 启动时同步进项目 `.opencode/skills/`（带 `.ralph-flow-managed` 标记，不覆盖用户自建同名 skill） |
| `workflows/*.yaml` ×4 | `workflows/*.yaml` ×4 | 见下方「工作流文本转换」 |
| （无——Claude 插件自带 skill/agent 机制） | `src/setup.ts` | ralph-check agent 文件、skills 同步、pre-2.0 残留清理 |
| `server.mjs` migrateLegacyInstance（单实例 JSON 布局） | `engine.ts` migrateLegacyInstance | 迁移源不同：opencode 旧版是 `ralph-flow.local.md`（markdown frontmatter） |

## 引擎签名转换规则

`server.mjs` 是「每会话一个 MCP server 进程」；opencode 是「每项目目录一个插件实例服务所有会话」。因此：

1. `createEngine(projectDir, platform)` 工厂闭包替代模块级全局（`projectDir`、锁、`boundInstanceId`）。
2. `boundInstanceId` 变为**操作作用域**：每个工具调用/事件先 `withLock` → `engine.beginOp(sessionID)`，由 `sessionBindings: Map<sessionID, instanceID>` 恢复绑定。锁内代码与 server.mjs 逐行一致。
3. `getMySessionId()`（Claude 版读 `~/.claude/sessions/<ppid>.json`）→ 直接用 `beginOp` 传入的 sessionID。
4. 其余函数签名一致（可选尾参 `instId` 同样保留）。

## Platform 接口（全部平台差异点）

| 差异点 | Claude Code 版 | opencode 版 |
|---|---|---|
| 状态根目录 | `.claude/ralph-flow/` | `.opencode/ralph-flow/` |
| 会话身份 | ppid → `~/.claude/sessions/` 追踪文件 | 工具/事件自带 sessionID |
| 会话存活判定 | 追踪文件 pid 是否存活 | 本进程见过该会话且未删除（`seenSessions`）。opencode 重启 ⇒ 全部属主判死 ⇒ 正好触发接管旅程 |
| done 检测触发 | Stop hook 读 transcript JSONL | `session.idle` 事件 + `client.session.messages` |
| 驱动模型的方式 | hook `decision:"block"` + systemMessage | `client.session.prompt`（普通注入） |
| 只通知用户不驱动 | hook systemMessage（无 block） | `client.session.prompt` + `noReply: true` |
| CHECK 执行 | spawn `claude -p` 子进程 + `--allowedTools` 只读白名单 | SDK 独立 session + `ralph-check` agent（`edit: deny`） |
| CHECK 取消句柄 | `.adversarial-pid`（跨进程 kill 进程树） | `.adversarial-session`（本进程 abort；跨进程无法触达，结果由 phase-3 状态校验丢弃） |
| CHECK 崩溃恢复探测 | pid 存活检查 | 仅本进程 `activeChecks`；跨进程运行中的 check 探测不到（可能提前触发崩溃恢复，后到的结果会被丢弃，安全） |
| CHECK 提示词构建时机 | adversarialCheck 内（单会话进程无竞态） | phase-1 锁内构建后传入（多会话共享隐式绑定，锁外不可信） |
| extra_dirs | 传给子进程 `--add-dir` | 仅校验存在性 + 写入提示词（ralph-check agent 有 `external_directory: allow`） |
| adversarial_check.model | 字符串（CLI `--model`） | `{providerID, modelID}` 或 `"provider/model"` 字符串；裸名（如 `sonnet`）无法解析 → 回退 agent 默认模型（doctor 会警告） |
| adversarial_check.agent | 不支持（lint 警告） | 支持（默认 `ralph-check`） |
| ESC/中断 | 无法感知 | `session.error(MessageAborted)`/`session.deleted` → 暂停实例（`pause_reason: session_aborted/deleted`），继承旧版行为 |
| compaction | 无对应事件 | `session.compacted` → 按 idle 处理，用缓存 DO 提示词重新驱动 |
| logEvent 归属 | 绑定实例必然正确（每会话一进程） | phase-2（锁外）期间可能落到并行会话的实例日志或全局日志，仅影响日志归属 |

## 工作流文本转换

Claude 版 workflows/*.yaml → opencode 版时的机械替换：

- `调用 ralph-flow:<name> skill` → `用 skill 工具调用 <name> skill`
- `model: sonnet` / `model: Opus` → 注释掉（附 opencode 格式示例）
- `.claude/ralph-flow` → `.opencode/ralph-flow`

skills/*/SKILL.md 的转换只有一处：产出目录示例路径 `.claude/ralph-flow/artifacts/` → `.opencode/ralph-flow/artifacts/`。

## 同步流程（Claude 版更新后）

1. diff Claude 仓库中 `server.mjs`/`done-detect.js` 相对上次同步基线的变化。
2. 按文件映射表定位 opencode 侧对应函数，逐块翻译（保持函数名与文案一致）。
3. workflows/skills 直接重拷 + 上面的机械替换。
4. `npm run typecheck && npm test`，必要时补对应断言。
5. 更新本文件的参考基线说明。
