# reset 新窗口化设计（opencode 端）

> 状态：**已实施（opencode 端，v2.10.0）。** 本文档定义 opencode 版 `isNewOpen` 的语义与
> 落地机制，并记录与 Claude Code 版的分叉。
>
> 要解决的问题：reset 达成"上下文重置"时，默认载体是应用内换会话（2.9.x 现状）。
> `isNewOpen` 让希望"reset 后新开一个窗口执行、旧窗口保留可回看"的用户显式开启物理开窗交接。

---

## 1. 核心语义

**reset = 上下文重置（目的） + 载体（默认应用内换会话，可配置为交接）。**

- **上下文重置**是 reset 的目的：把当前步骤的 DO 放进一份**干净、自包含**的提示里
  （`buildDoPrompt` 含任务/输入/输出/失败原因，不依赖会话历史）。工具描述原文：
  "手动重置当前工作流上下文"，transitionText 头："## 🔄 上下文已手动重置"。
- **载体**是达成"上下文重置"的手段：默认应用内换会话（2.9.x 现状）；`isNewOpen: true`
  时换成物理开窗交接，把工作流从旧容器换到一个没有旧上下文污染的新容器。

reset 的三种触发点共享"上下文重置"，之后动作由触发点决定：

| 触发点 | 上下文重置 + 之后的动作 |
|---|---|
| 手动 `/ralphflow-reset` | 重置上下文 + 重做当前步 |
| 自动门：前进到标 `reset` 的步骤 | 重置上下文 + 正常推进下一步 |
| 失败重试回标 `reset` 的步骤 | 重置上下文 + 重做该步 |

## 2. 两平台语义

| | opencode | Claude Code |
|---|---|---|
| 交接（`isNewOpen: true`） | 物理新开终端窗口，窗口内 `opencode --session <新会话id>` attach reset 创建的空会话 | 物理新开终端窗口，窗口内 `claude --resume <会话id>` 恢复会话 |
| 不交接（缺省 `false`） | 保持现状：应用内换会话 + TUI 跳转（不物理开窗，与 2.9.x 一致） | 不新开会话，用 **compact** 在当前会话达成"上下文重置"（Claude 端 compact 强大，是合理替代） |

opencode 端默认 `false`（保守：不改变既有行为，开窗是显式选择）；Claude 端默认值由
该仓库决策。两平台各自以"不交接"为默认都成立——`true` 只在用户明确要求时启用。

## 3. YAML 设计

```yaml
description: 规格驱动开发

isNewOpen: true    # 可选，缺省 false。工作流级：reset 时是否物理新开窗口执行交接
steps:
  ...
```

- `isNewOpen: boolean`，工作流级，缺省 `false`（不交接，与 2.9.x 行为一致）。
  - `false`（默认）：应用内换会话 + 跳转。
  - `true`：reset 时物理新开终端窗口，窗口内 attach 新会话。
- 与 `reset` / `auto_reset` **正交**：`reset` 决定"是否在进入该步时触发重置"，
  `isNewOpen` 决定"触发后用交接还是应用内换会话"。
- `parseWorkflowFile` 校验为 boolean（非 boolean → 校验错误，与其他字段同级）；旧 YAML
  不加字段行为不变。Claude 版 `parseWorkflowFile` 透传未知字段，无需改动即可识别。
- doctor（lintWorkflow）新增校验提示：`isNewOpen` 非 boolean → 校验错误。

**内置工作流**：`loop` 不写 `isNewOpen`（用默认 false）——单步轻量循环，失败重试频繁，
不物理开窗。

## 4. 行为矩阵

| 场景 | opencode `true` | opencode `false` | Claude `true` | Claude `false` |
|---|---|---|---|---|
| 手动 reset / 自动门 / 失败重试 | 物理开窗 + attach 新会话；开窗失败降级应用内跳转 | 应用内换会话 + 跳转（现状） | 物理开窗 + `claude --resume` | 当前会话 compact + 重做 DO |
| 旧窗口/旧会话 | 保留、只读、不再驱动 | 保留、只读、不再驱动 | 保留、不再驱动 | 保留（compact 在同一会话，无新窗口） |
| headless / 无窗口环境 | 降级应用内跳转（工作流不断） | 应用内跳转（不变） | 提示手动开窗 | compact（可用） |

## 5. opencode 端实现

### 5.1 引擎改动（engine.ts）

- `WorkflowDef` 加 `isNewOpen?: boolean`。
- `parseWorkflowFile`：解析并校验 `isNewOpen` 为 boolean（缺省 false）；非 boolean → problem。
- `lintWorkflow`：非 boolean → 校验错误（doctor）。

### 5.2 开窗模块（新增 `src/window.ts`）

```ts
export interface SpawnWindowResult { ok: boolean; error?: string }
export async function spawnTerminalWindow(
  cmd: string,
  args: string[],
  opts: { cwd: string; title?: string },
): Promise<SpawnWindowResult>
```

**原则：argv 直接透传，不经过 shell 字符串解析**——新窗口的默认 shell 是 fish/zsh/cmd
都不影响。macOS/Linux 因终端程序普遍要求 `-e` 参数，用临时脚本承载命令（`#!/bin/sh` +
`cd <cwd> && exec <cmd> <args>`），脚本内容用 shellQuote 转义。

| 平台 | 探测顺序 | 命令 |
|---|---|---|
| win32 | `wt.exe`（Windows Terminal）→ `cmd /c start` | `wt new-window --title <title> <cmd> <args...>`；兜底 `cmd /c start "" <cmd> <args...>` |
| darwin | `open -a Terminal <tmpScript>`（写 `#!/bin/sh` 临时脚本） | `open -a Terminal /tmp/...sh` |
| linux | `x-terminal-emulator` → `gnome-terminal` → `konsole` → `xfce4-terminal` → `xterm`（检测 `DISPLAY`/`WAYLAND_DISPLAY`，headless 直接失败） | `<term> -e <tmpScript>`（gnome-terminal 用 `-- <tmpScript>`） |

- 全部 `spawn(..., { cwd, detached: true, stdio: "ignore" })`，`unref()`。
- 任何探测失败 / spawn 抛错 / headless → 返回 `{ ok: false }`，调用方降级。

### 5.3 executeContextReset 接线（driver.ts）

`executeContextReset` 创建新会话、转移 owner、注入简报 + DO 之后：

1. `workflow.isNewOpen === true`（显式开启）→ 尝试物理开窗：
   `spawnTerminalWindow("opencode", ["--session", newSessionId], { cwd: engine.projectDir, title })`。
2. 开窗成功：**不再**做 `tui.session.select` 跳转（用户已在新窗口）。告别消息注明
   "已在新窗口打开，旧窗口保留可回看"。
3. 开窗失败 / headless：降级——照旧 `tui.session.select` 跳转（现状兜底，工作流不断）。
4. 缺省 / `isNewOpen === false`：完全走现状（应用内跳转），不尝试开窗。

失败日志沿用 `context_reset_*` 事件体系，新增 `context_reset_window_spawn_failed` 事件。

### 5.4 工具 / 命令文案（tools.ts、commands.ts）

- `ralphflow_reset` / `ralphflow_rewind` 的返回与告别文案随 true/false 区分：
  "已在新窗口打开（🔄 …）" vs "已在本应用内新会话继续"。opencode 端告别文案保持现状
  语义（旧会话历史保留、可切回），仅按载体措辞微调。

## 6. 交接文件 schema（两平台锚点）

opencode 端交接靠注入完成（不依赖文件）；Claude Code 端"新窗口 = 全新会话 + 认领"需要
显式交接文件。为让两平台有共同锚点，定义 schema（opencode 写入作排障/审视依据，Claude
读取作认领依据）：

```jsonc
// .opencode/ralph-flow/<instance>/handoff.json（Claude 版对应 .claude/ralph-flow/...）
{
  "version": 1,
  "instance": "inst_xxx",
  "workflow": "spec",
  "step": "implement",
  "kind": "reset" | "rewind",
  "reason": "用户给出的重置/回退原因",
  "createdAt": "ISO8601",
  "fromSession": "旧会话 id（审视锚点）",
  "doPrompt": "自包含 DO 提示（buildDoPrompt 产出，含任务/输入/输出/失败原因）",
  "resume": { "cmd": "opencode --session <newId>" | "claude --resume <sessionId>" }
}
```

- 认领协议：新窗口启动后（Startup hook / 启动检测）发现 `handoff.json` → 校验 instance
  owner → 注入 `doPrompt` 驱动 DO → 清理交接文件。与 opencode 的
  `claimOwnership` + 注入对称。
- 排障：`handoff.json` 提供 reset 的完整"从哪来到哪去"记录。

## 7. 降级链（汇总）

| 平台 | 主路径 | 降级 1 | 降级 2 |
|---|---|---|---|
| opencode `true` | 物理开窗 attach 新会话 | 开窗失败 → 应用内 `tui.session.select` 跳转 | — |
| opencode `false` | 应用内换会话 + 跳转（现状） | — | — |
| Claude `true` | 物理开窗 `claude --resume` | 开窗失败 → 提示手动开窗 | 用户不开 → 可手动 `/ralphflow-continue` 接管 |
| Claude `false` | 当前会话 compact | — | — |

## 8. 测试矩阵（vitest）

**engine（engine.test.ts）**
1. `parseWorkflowFile`：`isNewOpen: false` → 透传 false；非 boolean → problems 报错；缺省 → undefined（运行时按 false 处理）。
2. `lintWorkflow`：`isNewOpen: "yes"` → 校验错误。

**window（window.test.ts，mock platform / spawn）**
3. win32：wt 路径命令构造正确（argv 透传）；wt spawn 失败 → cmd start 兜底；都失败 → ok:false。
4. darwin/linux：生成临时脚本（shebang + shellQuote）；headless（无 DISPLAY）→ ok:false。
5. `spawnTerminalWindow` 返回错误信息而非抛异常。

**driver（driver.test.ts，mock client）**
6. `isNewOpen: true`（显式）：check 通过进 reset 步骤 → 物理开窗被调用（argv 含
   `--session <newId>`），不再发布 `tui.session.select`。
7. `isNewOpen: true` 且开窗失败（mock spawn 失败）→ 降级发布 `tui.session.select`，工作流继续。
8. `isNewOpen: false`：不调用开窗，照常 `tui.session.select`（现状）。
9. `ralphflow_reset` 手动路径同上三种分支。
10. 回归：默认不写 `isNewOpen` 的行为与 v2.9.x 完全一致（旧测试全绿）。

## 9. 分阶段实施

**opencode 端（已完成，v2.10.0）**：engine 字段 + lint + window.ts + executeContextReset 接线 +
文案区分 + 测试矩阵全部。`loop` 不写该字段（默认 false）。已发版。
**Claude Code 端**：交接文件 schema 落地 + 开窗模块 + compact 降级，按另一仓库交接实施；
默认值由该仓库决策。