# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 3.0.0 (2026-11-10)

> **兼容性断裂**：本版本只支持 **OpenCode 2.x**。仍在使用 OpenCode 1.x 的用户请继续使用 `@yibener/ralph-flow@2`（2.11.x），不要升级到 3.x——两者的插件模型不兼容。

### 适配
- **迁移到 OpenCode 2.x 的 Promise 插件模型**：入口从 v1 的 `async (ctx) => Hooks` 改为 `Plugin.define({ id, setup })`。v1 的默认导出在 2.x 上会被加载器以 `Plugin must export a default definition with an id and an effect or setup function` 拒绝，且每 5 秒重试一次——命令、工具、`ralph-check` agent 全部不可用，这正是用户反馈的「ralph-flow 用不了」。
- **客户端适配层 `src/v2-client.ts`**：把核心代码仍在用的 v1 SDK 窄接口（`session.create/delete/abort/messages/prompt/promptAsync`、`app.agents`、`tui.publish/showToast`）映射到 2.x 的 `context.session/agent/command/tool/permission/event`。刻意只实现 Ralph Flow 真正调用的方法，不伪造完整旧客户端。
  - 会话删除：2.x 的 Promise 上下文没有 `session.remove`，改为连接同版本已注册服务执行（`@opencode/client/service` 的 `discover` + `OpenCode.make`），验证者会话不会残留。
  - 模型/agent 切换：`session.switchAgent` / `session.switchModel` 在真正的 prompt 之前应用，并保留 `variant`（模型 effort）。
  - 状态更新消息：2.x 会隐藏 `noReply` 的合成消息，改为 `session.synthetic` 并带 `description`，CHECK 阶段/结果与投票进度重新可见。
  - 阻塞式 prompt：`prompt` → `session.prompt(resume:true)` + `session.wait` + `session.context`，验证者的错误原样返回。
- **工具注册 `src/v2-tool.ts`**：zod 定义转成 2.x 的 Standard Schema 输入与结构化 `Tool.Result`，工具名与参数保持 `ralphflow_*` 不变。
- **命令注册**：改用 `context.command.transform`，11 个固定命令 + 每个可运行工作流的动态命令（`/loop`、`/spec`…）语义不变。
- **事件桥**：`session.idle` / `session.compacted` / `session.execution.succeeded` / `session.status(idle)` 统一驱动 idle 路径；`session.execution.interrupted` / `session.deleted` 映射到会话消失路径；验证者会话永不驱动。
- **TUI 入口 `src/tui.ts`**：reset/rewind 的新会话（顶层、标题以 🔄/🔙 开头）自动跳转 + toast；验证者与子会话不抢屏。
- **权限**：用 `context.permission.hook("evaluate")` 放行工作流属主会话，插件异常绝不把权限请求变成误拒绝。

### 修复
- **换会话保留模型 variant**：2.x 的 handoff 会丢掉 `variant`（如 `#high`），reset 后的新会话退回默认 effort；现在跨 handoff 透传。
- **CHECK 阶段在 2.x TUI 不可见**：合成消息需要非空 `description` 才显示，已补上稳定标签。

### 验证
- **真实 e2e（不是 mock）**：在 `opencode v2.2.5` 与 `v2.2.6`（当前最新稳定版）上各跑一遍完整 `loop` 工作流：命令注册 → `ralphflow_start` → DO → 3 验证者投票 CHECK → 失败（带原因）→ 上下文重置到新会话 → 重做 → CHECK 全过 → 归档报告；验证者会话在检查后全部删除、`/ralphflow-status` 正常。
- 单测新增 `plugin-entry`（入口形状回归，防再次发出不可加载的包）与 V2 客户端/事件/TUI 套件；全量 19 文件 / 284 断言绿，`tsc --noEmit` 干净。

## 2.11.1 (2026-11-09)

### 变更
- **npm 发布迁移到 trusted publishing（OIDC）**：`.github/workflows/publish.yml` 改用 GitHub Actions 的短时身份换取发布凭据，删除对 `NPM_TOKEN` 密钥的依赖，不再受 granular token 90 天有效期影响（旧 token 已于 2026-11-08 到期）。工作流改用 Node 24 并显式安装 npm@11，以满足 trusted publishing 的 npm ≥ 11.5.1 要求。无运行时行为变化。

## 2.11.0 (2026-09-03)

### 变更
- **手动审查门移到 CHECK 之后（消灭「改 → 审 → 再改」循环）**：`manual_step` 步骤与普通步骤一样，DO 完成后**先自动运行独立验证**；只有 **check 通过**才停下用 🙋 消息请你审查——你审的永远是通过验证的产物。你的 `/ralphflow-continue` 从"启动验证"变为**放行**（直接按 `on_pass` 推进，不重复验证）。
  - check 失败只走 `on_fail` 自动重试，**不再**重新布防审查门——用户不再被卷进"AI 审查失败 → 用户又改"的质量循环。
  - 你要改：直接说要改什么，模型修改后输出 `<promise>done</promise>`，自动重新验证，通过后再停下等你审查；你满意才放行进入下一步。
  - 该步骤未配置 `check` / `check_voting` 时人工审查即最终验证（与 2.9 的「manual 默认跳过对抗 check」一致，只是门从 DO 后挪到 check 通过点）。
- 内部：新增 `.manual-gate-approved`（用户批准待放行，driver 空闲时前进，记录步骤 id 防残留误触发）与 `.manual-gate-last`（门布防时模型最后输出的摘要，区分"旧 done 静默"与"要改后的新 done 重新验证"）。
- **换会话统一清理实例级 marker**：`executeContextReset` 在所有权转移后清空审查门 / done / 批准 / 催促计数等标记——修复"审查门布防期间 `/ralphflow-reset` 后，旧 gate 残留到新会话导致新 DO 阶段被静默卡住"。

### 测试
- 新增 `manual-gate-e2e.test.ts` 端到端集成套件（真实会话序列驱动完整工作流）：build→review(门)→deploy→完成；review check 失败自动重试不布防门 → 通过 → 门 → 用户要改 → re-check → 门 → 放行；审查门布防期间 reset 换干净会话且 marker 不残留；另一会话接管门中实例直接放行；voting+manual 全过 → 门 → 放行完成。
- 单测新增 4 条回归（同上文）。更新 3 条旧「先审后验」语义测试 + 子工作流 manual 组合测试。全量 15 文件 / 269 断言绿。

## 2.10.0 (2026-08-30)

### 新增
- **reset 新窗口化（`workflow.isNewOpen`）**：reset（手动 / 自动门 / 失败重试）达成"上下文重置"的载体可配置，与 `reset` / `auto_reset` 正交。
  - 缺省 `false`（不交接）：保持现状——应用内换会话 + 跳转，与 2.9.x 行为一致（默认不物理开窗）。
  - `true`（交接）：opencode 物理**新开终端窗口**，窗口内 `opencode --session <新会话>` attach reset 创建的空会话继续干活，旧窗口保留可回看；开窗失败（headless / 无终端）自动降级为应用内 `tui.session.select` 跳转，工作流不断。
  - 与 Claude Code 版统一语义：Claude 端 `true`=开新窗口 `claude --resume` 交接、`false`=当前会话 compact 代替；Claude 端作为内部另一仓库交接实施。设计文档见 `docs/reset-window-design.md`。
- **跨平台开窗模块 `src/window.ts`**：argv 直接透传不经 shell 解析（新窗口默认 shell 无关）；win32 优先 `wt.exe` 后 `cmd start` 兜底，macOS `open -a Terminal` + 临时 `#!/bin/sh` 脚本，Linux 终端探测表（x-terminal-emulator/gnome-terminal/konsole/xfce4-terminal/xterm）；任何失败返回 `ok:false` 不抛异常。

### 测试
- 新增 `window.test.ts`（9 断言：平台探测表 + argv 透传 + headless 降级 + 脚本内容）+ driver 4 条 isNewOpen 分支（默认不开窗 / 显式 true 开窗成功 / false 不开窗 / true 开窗失败降级）；engine 4 条解析/校验。全量 14 文件 / 260 断言绿。

## 2.9.0 (2026-08-20)

### 新增
- **对抗性 check 可选化（与 Claude Code 版镜像）**：步骤可以完全省略 `check` / `check_voting` —— DO 完成后**直接跳过后台对抗验证**、按 `on_pass` 推进，不再被当作"漏写"静默丢弃。对抗 check 是耗时且不可见的黑盒，适合留给真正需要独立复核的步骤；文档整理、纯编排等不需要独立复核的步骤如今可以不写 check。**`manual_step` 默认**不再叠加对抗 check（人工审查门本身就是"人审过的检查"），除非步骤显式写了 `check` / `check_voting`。
- **让"跳过"不至于隐形**：
  - `check` 写成非字符串（如 `check: true`）是**配置错误**，会拒绝——避免把"想要 check"误读成"不要"。
  - `check_model` 却没写可用的 `check` 是**配置错误**，会拒绝——避免漏写 check 的笔误被静默吞掉。
  - doctor 对**非 manual** 的无 check 步骤给出醒目警告（防止忘了写 check 被当成熟练跳过）；manual 的无 check 步骤保持安静。
- **DO/完成文案如实反馈**：DO prompt 对 no-check 步骤注明"不配置对抗性检查：完成即可，不会有独立的验证进程来复核"；通过头对该类步骤显示"跳过对抗性验证"，不再伪造"检查通过"。

### 测试
- 新增 `check-optional.test.ts`（11 断言：parse/lint/DO prompt 语义）+ `check-optional-driver.test.ts`（2 断言：no-check 步骤端到端不 spawn 验证者会话、check 步骤照常）；更新 1 条旧"无 check 被丢弃"语义测试为新语义。全量 13 文件 / 242 断言绿。

## 2.8.2 (2026-08-10)

### 变更
- **检查失败原因截断上限调大**：单验证者 reason 截断 5000 → 20000 字符（`getAdversarialCheckReason`）；多验证者聚合逐票截断 1200 → 4000、聚合总兜底 8000 → 24000（通过者摘要 200 → 400、infra 摘要 200 → 400、infra 重试 400 → 800）。此前验证输出稍长即被截断，DO 拿不到完整失败反馈。上限仍远低于主流模型 context window（128k+），且只在失败时注入一次、不跨轮累积，无触及提示词上限风险。

## 2.8.1 (2026-08-07)

### 修复
- **`/ralphflow-continue` 后验证永不重跑（死锁）**：`check_error` 暂停（检查器 infra：超时/API 错/模型不可用）后 continue，空闲驱动因模型最后一条消息仍带暂停前的 `<promise>done</promise>` 标签且阶段为 check 而直接静默 return——"空闲时自动重新验证"永不兑现；用户再 continue 会误入崩溃恢复分支重置 DO、误删投票进度，infra 恢复后也永远卡在"验证未运行"。修复：driver 空闲驱动在 check 阶段检测到 done 标签且无活跃验证者时补跑检查（单 `check` 与 `check_voting` 同路径，幂等不双跑）。配套回归测试覆盖：单 check/多验证者持续 infra 补跑、infra 恢复后推进、验证进行中不双跑、补跑遇真实失败走 on_fail。
- **子工作流完成回不到父工作流（所有权被旧会话覆盖）**：嵌套工作流配合 reset 门换会话（composite `reset: true` / `auto_reset: true`）时，子工作流完成回父会把「进入子工作流前」的旧 `session_id` 从栈帧写回状态，覆盖 `executeContextReset` 换的新会话所有权——实例被已废弃的旧会话独占，新会话空闲驱动对非属主实例静默，父工作流状态虽已回退但永远无人驱动（表现为"子工作流完成了回不到父工作流"）。修复：`pushState` 压栈帧时剥离 `session_id`（运行时所有权不入状态快照），`popState` 弹出时防御清洗历史数据。配套 8 个嵌套回归测试（含三层嵌套、暂停/继续组合、manual 组合、reset 门换会话组合）。

### 变更
- 内置 `loop` 工作流执行摘要文件名 `checkpoints.md` → `summary.md`（README/命令说明同步）。

### 端到端验证
- 真实环境（独立 opencode server + 真实模型 + 真实验证会话）跑通：父 → 子工作流（reset 换会话）→ 子完成回父 → 父完成，全自动驱动。

## 2.8.0 (2026-08-06)

### 新增
- **CHECK 多验证者投票（`check_voting`）**：步骤可声明 `check_voting`（1-5 个验证者，每条目含独立的检查依据 `check`、可选 `model`/`timeout_ms`/`system_prompt`），N 个验证者并行独立会话验证，**全过才放行**。与 `check` 互斥（同写 → doctor 硬错，优先于类型检查）。失败时聚合所有失败者 reason 反馈 DO 重试（失败者完整 + 通过者摘要 + 各自检查依据）；通过时 N 票各一行汇总。设计文档见 `docs/multi-agent-design.md`。
- **`check_model`：步骤级验证模型覆盖**（单 `check` 场景）。优先级链：条目 model > 步骤 check_model > 全局 `adversarial_check.model` > ralph-check agent 配置 > owner session 当前模型 > 全局默认。
- **验证者输出契约精炼化**：`DEFAULT_ADVERSARIAL_SYSTEM_PROMPT` 输出格式改为"每条一行、最多 10 行、位置前缀可选（`[文件:行号]` / `[模块名]` / 架构问题裸写）"，从源头控制验证输出长度与信息密度（单验证者同样受益）。
- **进度持久化 `.check-voting-progress.json`**：每票状态（pending/running/passed/failed/infra_pending/infra_failed/cancelled）落盘，供 TUI/status/continue/重启清理读取；`/ralphflow-status` 在验证中显示各票进度。
- **plugin load 孤儿验证会话清理**：进程重启后，上一进程创建的验证会话由 plugin 初始化钩子删除（`setupDirs` 防重），空闲时自动重跑验证——顺带修复单验证者的"重启后 idle 卡死"既有问题（旧行为只能靠 continue 触发崩溃恢复）。

### 变更
- **内置 `loop` 工作流升级为多验证者投票版**：`check` 替换为 `check_voting`（3 个验证者，各查一条需求完成度标准：每一条要求都已落实 / 行为符合预期真实可用 / 没有遗漏的需求与边界情况）。`do` 精简为"完成用户任务"；每轮结束把执行摘要追加到 `checkpoints.md`（多轮累积、跨会话可查），`output` 同步标明。desc/description 保持原样。
- **`infra` 语义细化**：单票 infra（超时/API 错/会话创建失败）自动重试 1 次；重试仍失败且无 failed 票 → `check_error` 暂停（不计 fail_count）；**failed 优先于 infra**（混合时直接判失败反馈 DO，基础设施故障不遮蔽工作问题）。continue 后 `infra_failed` 票重置为 pending 重新投票（重试预算按暂停会话计，不跨 continue 累计，永不死锁）。
- **投票进度实时推送**：每票完成立即向用户会话注入一行 noreply 进度（`🔍 ✅ 验证者 2/3通过：<检查依据摘要>` / `❌ 不通过` / `⚠️ 基础设施故障，自动重试中`），长耗时投票不再"无声"，用户不会误以为卡死。
- **`.adversarial-session` 改 JSON 数组**（多验证者并存），读兼容旧单值格式；`activeChecks` 改数组，取消时 abort 全部验证会话。
- **noReply 展示消息纯文本化**：opencode TUI 对 user 角色消息用 HighlightedText 纯文本渲染（不做 markdown 解析，源码实证），CHECK 开始提示/进度推送/infra 暂停/崩溃提示全部改为纯文本排版（emoji + 对齐行，不再用表格/粗体），界面干净可读。推进类消息（DO prompt 等）保持 markdown 供模型阅读。

### 文档
- `docs/multi-agent-design.md`：check_voting 完整终版设计（已通过独立对抗验证）。
- `docs/custom-workflows.md`：新增 `check_voting` / `check_model` 用法与规则。
- `README.md`：能力表、内置工作流描述、文档索引同步 2.8.0。

## 2.7.3 (2026-08-03)

### 修复
- **催促超限后 `/ralphflow-continue` 不推进（死循环）**：DO 阶段被连续催促 `MAX_DO_REINJECT`(5) 次后，driver 提示"运行 `/ralphflow-continue` 进入验证"，但该状态下实例未暂停、无手动审查门、阶段仍是 do——continue 落入"本工具无需操作"分支，什么都不做；且催促计数永不清零，每轮 idle 重复注入同样警告，工作流永远到不了下一步。现在：① continue 在催促超限时把用户调用视为"确认完成"——写入 done 标记，下一轮 idle 自动进入独立验证（与模型自己输出 `<promise>done</promise>` 同一条路径），并清零催促计数；② 超限警告只注入一次（`.reinject-warned` 标记去重），之后静默等待用户或模型动作；③ 催促计数归零时（新一轮 DO）顺带清除警告标记，再次超限时用户还能看到一次警告。补充回归测试：超限→continue→idle 进入验证推进、未超限的 continue 不误触发确认、旧步骤残留计数不误触发。

## 2.7.2 (2026-08-03)

### 变更
- **`reset` 语义统一：标了 `reset` 的步骤任何方式进入都换干净上下文，`auto_reset` 与它完全一致（=给所有步骤标 `reset`）**。原先 `reset` 在失败重试时不触发、`auto_reset` 仅跨步骤触发；现统一为一条规则（失败原因经 retryContext 文本通道注入 DO 提示，重试不丢现场）。未标 `reset` 的步骤重试仍保留现场。纯线性 loop 配 `auto_reset` 时每次失败重试都会换会话，doctor 提示 token 成本。
- **内置 `loop` 工作流重写为单步对抗验证循环**（原两步：先列检查点清单、再逐项执行）。旧设计两个问题：(1) CHECK 逐条核对模型自列的清单，清单质量决定验证质量；(2) 全量重验清单导致检查时间过长。新设计：CHECK 独立建立完成标准（读需求自行判断，不采用模型自列清单）、核对真实变更范围、重跑验证命令、对抗找破绽；DO 每轮结束输出**执行摘要**（完成事项/变更文件/验证结果/剩余工作），给 CHECK 聚焦点并缩短检查时间。失败原因经 retryContext 回注下一轮 DO，迭代至通过。步骤默认 `reset: true`（重试换干净上下文）；变更核对不依赖 git（非 git 项目直接列文件清单）；lint 对内置工作流跳过 reset 成本警告。

### 文档
- `docs/custom-workflows.md` / `docs/reset-gate-design.md`：触发规则、理由、公式伪代码、测试矩阵同步新语义；首步标 `reset` 的 doctor 提示改述（现在包含失败重试频繁重置的成本提醒）。
- `README.md` / `docs/reset-gate-design.md`：loop 工作流描述与内置工作流 reset 建议同步单步化。

## 2.7.1 (2026-07-29)

### 修复
- **rewind 注入头的 from-step 写错（"已从步骤 X 回退到 X"）**：注入函数收到的是已倒退后的 state（`current_step` 已是目标步），头里的"从哪回退"却从 state 读——新会话冷启动第一条消息自相矛盾，且随 `.do-prompt-cache` 在每次 idle keep-alive 重注入。现由调用方显式传 `fromStepId`，并补 from-step 断言测试（该 bug 漏网的直接原因就是无此断言）。
- **跨子工作流栈帧同名步骤会被误判为"已通过"**：`StepExecutionRecord` 没有工作流名字段，子工作流里 `build` 的 check-passed 会让父工作流从未执行过的同名 `build` 变成可回退目标。记录新增 `workflowName` 字段（写入时带当前/父工作流名），`passedStepIds` 据此隔离；旧记录无字段时回退为仅按 stepId 匹配（历史不丢）。
- **`/ralphflow-reset` 在暂停实例上静默"没反应"（既有问题）**：paused 会随状态带进新会话，新会话的空闲驱动对暂停实例永远静默，告别语却说"已在新会话继续"。现在 reset 遇暂停直接拒绝，指向 `/ralphflow-continue`（显式解除暂停）或 `/ralphflow-rewind`（回退顺便清暂停）。
- **`/ralphflow-rewind` 命令模板两处笔误**："fade 场景"（残留乱码，语义不明）改为"方向回退场景"；"rewrite 把这条原因跨会话带过去"的 rewrite 改为 rewind。
- **rewind 换会话后旧会话告别语说"上下文已重置"**：`executeContextReset` 新增可选 `kind`，rewind 传 `🔙` 标题 + "已回退到步骤 X 重做"措辞，与 reset 的 🔄 区分——用户执行的是哪个命令，告别就该说哪个。
- **rewind 缺 `step_start` 日志事件**：其它所有 DO 阶段入口（start / check 转换 / continue 恢复）都记，rewind 现在补齐——按事件类型过滤日志时不再缺席。

### 文档
- `docs/how-it-works.md`：rewind 边界补"回环流程里目标可能在数组顺序靠后（语义=跳到任何曾通过 CHECK 的步骤）"与同名步骤工作流名隔离说明；reset 暂停拒绝在 rewind 边界对照与 `docs/custom-workflows.md` 触发规则中说明。

## 2.7.0 (2026-07-29)

### 新增
- **`/ralphflow-rewind`：运行时回退到已通过 CHECK 的上游步骤重做**。长流程中途用户主观判断前面某步方向错了（非 CHECK 自动失败），可以倒退状态机到那个**已通过独立 CHECK** 的步骤重做：状态机倒退、`fail_count` 归零、`paused` 清除，下游已落盘的代码/文档**保留**（插件不删任何产物）。`reason` 必填、来自用户（"为什么回退、重做时要注意什么"），跨会话注入新会话首条 DO 提示前并随 idle keep-alive 重注入保留——这是用户旅程的关键断点：旧的 reset 会把用户跟 AI 说的"为什么回退"丢在旧会话，新会话冷启动只收到一句"步骤 X 将重新执行"，毫无方向感；rewind 把这条原因跨会话带过去，让新会话模型一开局就知道这次重做要纠正什么。默认换干净会话（与 reset 一致），`keep_session: true` 复用当前会话。paused 实例允许 rewind（顺便清暂停）。边界：回退当前步 → 拒绝指向 `/ralphflow-reset`；目标不在本工作流、是子工作流（复合）步骤、未通过 CHECK → 拒绝并提示可选清单；当前在子工作流栈帧内 → 拒绝跨栈帧回退（第一版留白，指向 `/ralphflow-cancel` + 重新 `start`）。
- **`/ralphflow-reset` 顺手补可选 `reason`**：同一旅程断点的修复——用户用 reset 时也会跟 AI 说"为什么重置"。`reason` 可选：不传时行为与旧版字节级一致（向后兼容）；传了则与 rewind 走同一条跨会话注入路径，新会话冷启动首条 DO 提示前含 reason 段，idle keep-alive 重注入也保留。

### 文档
- `docs/how-it-works.md` 新增「中途回退与上下文重置」一节，对照 reset/rewind/cancel 三种场景；`docs/commands.md` 工具表与日志事件补 `ralphflow_rewind`、`rewind`、`context_reset`；README 命令列表同步。

## 2.6.0 (2026-07-28)

### 新增
- **重置门（Reset Gate）：跨步骤转换时可换入全新上下文会话**。步骤级 `reset: true` 或工作流级 `auto_reset: true` 标记后，CHECK 通过进入该步骤时不再往上下文已膨胀的旧会话里塞提示，而是创建新会话、转移实例属主、旧会话留告别消息、新会话直接开始 DO 阶段；同步骤重试（on_fail 回本步）不触发，保留现场记忆。新增 `/ralphflow-reset` 手动重置（DO 阶段随时换干净上下文，fail_count 不赦免）。验证器会话（CHECK）与模型延续（跟随旧会话当前模型）不受影响。设计见 `docs/reset-gate-design.md`。

### 修复
- **嵌套工作流里 composite 步骤的 `reset: true` 不生效**：进入子工作流时状态机已把实例状态推进到子工作流内部第一步，reset 门判定的 (source → target) 落在子工作流里，永远读不到标在父工作流 composite 步骤上的 `reset`（或父工作流的 `auto_reset`）——而嵌套恰恰意味着大任务、最需要重置。`TransitionResult` 新增可选元数据 `enteredCompositeStepId`（状态机行为不变），reset 门据此在 composite 步骤所属工作流上判定标记；fail 回炉重进同一子工作流（首尾状态完全相同）的场景同样覆盖。子工作流完成回到父级普通步骤、`auto_reset` 进子工作流均有回归测试。
- **reset 新会话在 `/session` 列表不可见、看起来"什么也没发生"**：reset 会话最初以 `parentID` 创建为旧会话的子会话，而 opencode TUI 的会话列表（`/session` 对话框与首页索引）会过滤掉所有子会话——工作流其实在后台的隐藏会话里照常推进，用户却找不到也切不过去。现改为顶级会话（验证器的临时子会话不受影响），并在创建后直接通过 `tui.session.select` 事件让 TUI 自动跳转到新会话（server 端发布，不依赖任何插件加载形态）。TUI 插件入口的跳转作为冗余路径保留：npm 安装（`plugin: ["@yibener/ralph-flow"]`）经 `exports["./tui"]` 自动生效、开箱即用；本地克隆的 file 形态需多建一个入口文件（见 README 安装节）。
- **reset 后旧会话的回合仍在继续跑**：转移 owner 只阻止了旧会话被再次驱动，但正在进行的回合（`/ralphflow-reset` 的工具调用本身就跑在旧会话的活跃回合里）会自然跑完——新会话重做同一步骤的同时旧回合还在写文件，两个会话并发改同一工作区。现在 reset 在 owner 转移后立即 abort 旧会话的回合（顺序严格：先转移后 abort，否则 `session.error` 会误暂停实例）；自动门路径旧会话通常无活跃回合，abort 为无害空操作。
- **新会话冷启动缺少交接上下文**：以前新会话的第一条注入开门见山就是"检查结果：通过"——写给经历过全程的旧会话模型的口吻，冷启动模型容易困惑。现在注入前统一包一段「会话交接说明」：reset 门接手原因、工作流进度（步骤列表 + 当前位置 + 已完成标记，来自执行记录）、artifacts 产出目录（之前的产出直接读取、不要重做）、done 标记约定。详细任务内容仍在随后的 DO 提示中，不重复。
- **reset 的 toast 通知从未弹出**：`client.tui.showToast` 调用少了 hey-api v1 的 `body` 包装层，请求体为空被服务端 400 拒绝（静默吞错）。修正为 `{ body: { variant, message } }`。

## 2.5.0

### 变更
- **CHECK 验证器权限重设计：`edit: deny` 硬约束 + `bash` 全开，不再用 bash 白名单**。三条理由：(1) 白名单覆盖不全生态——`pnpm`/`bun`/`mvn`/`mix`/`gradle`……用户每用个新工具链就得等插件补条目；(2) 白名单其实防不住篡改——`npm test` 这种必然放行的命令里跑的脚本想改什么就改什么；(3) opencode 自己内置的 `plan`/`explore` agent 就是同样的设计（`edit: deny` + `bash: allow`，行为细节交系统提示词）。真正能挡"验证者帮 DO 阶段改代码"的硬约束是 `edit: deny`，bash 的子进程副作用（缓存、构建产物）不污染验证结论。
- **验证者系统提示词按 superpowers 说服方法论重写（紧凑版）**：Authority 式铁律（不能改文件、无例外）、5 行"理性化念头 vs 现实"反理性化表、"别信 DO 报告"段，外加输出格式约束。研究显示这些技巧把纪律类提示的遵守率从 33% 提升到 72%。

## 2.4.0

### 新增
- **每个工作流自动注册成 slash 命令**：插件加载时枚举所有可启动的工作流（项目 + 全局 + 内置），各注册一个快捷命令——补全列表里直接显示 `loop`、`spec` 及你的自定义工作流，描述以 `(ralph-flow)` 标注来源。输入 `/lo` 回车即启动，省掉「`/ralphflow-list` 查名字 → `/ralphflow-start` 填名字」的两步旅程。冲突策略是绝不覆盖：与用户命令、其他插件命令或静态管理命令撞名的工作流静默跳过（仍可用 `/ralphflow-start <名字>` 启动）；定义无效的工作流不注册，留给 `/ralphflow-doctor` 暴露。注意这是启动时快照——新建的工作流在下个会话（或重启 opencode）后才有快捷命令。

## 2.3.0

### 新增
- **`adversarial_check` 沿子工作流链逐字段继承**：子工作流里每个填了且有效的字段（`model`/`agent`/`system_prompt`/`timeout_ms`）覆盖父工作流；没填或填了但无效（裸模型名、缺 `providerID` 的对象）的字段回退到父工作流，逐层向外直到内置默认。以前子工作流内的 CHECK 完全忽略父工作流的验证配置，静默回退默认模型。
- **工作流完成后归档执行日志**：实例完成或取消时，`execution.log` 随实例目录一并无从追溯；现在归档报告时把日志复制到 `reports/<实例id>-execution.log`，并在报告末尾注明路径——`model_source`、check 判决、infra 错误等关键事件事后仍可审计。

### 修复
- **未配置 `adversarial_check.model` 时，验证模型现在跟随工作会话当前使用的模型**：以前新建验证会话没有历史，服务端回退到 opencode **全局默认模型**——你在 TUI 里切换的模型对 CHECK 不生效。解析顺序：工作流 yaml 配置 → 验证 agent 的显式模型（如 `agent.ralph-check.model`）→ 工作会话当前模型 → 全局默认。日志 `adversarial_check_start` 新增 `model_source` 字段标明本次来源。
- **模型配错时 CHECK 失败信息透出真实原因**：`adversarial_check.model` 配置了不存在/未授权的模型时，以前一律报「验证返回空响应」；现在直接带服务端返回的错误（如 `Model not found: ...`，日志事件 `adversarial_check_request_failed`），仍是基础设施故障、不消耗失败次数。
- **对象形式的 `model` 缺 `providerID`/`modelID` 时被正确忽略并警告**：以前会原样传给 SDK 变成费解的请求失败；现在解析期丢弃、`/ralphflow-doctor` 明确警告（与裸模型名的处理一致）。
- **DO 阶段 10 秒内完成不再死锁**：DO prompt 投递后的 10 秒防抖窗口会吞掉会话的 idle 事件，若模型在此期间完成并输出 done（但因消息注册竞态被误判为"未完成"），这是唯一一次 idle——工作流就此卡住，需手动 `ralphflow_continue` 才能推进。现在吞掉 idle 时按窗口剩余时间安排一次补刀驱动：done 已注册就推进、模型工作中的就静默、真停了才催，三种情况都正确不误伤。

### 文档
- 自定义工作流指南新增「子工作流里的继承」一节；补充 `manual_step` 不能标子工作流步骤的说明；日志事件表新增 `adversarial_check_request_failed`。

## 2.2.1

### 修复
- **`ralphflow_continue` 在 DO 阶段不再误导模型**：以前无事可做时回「没有需要手动继续的操作。普通步骤的验证会在你空闲时自动运行」——模型据此以为验证已经开始，于是空等、再重试。现在它明确说明步骤仍在 DO 阶段、验证要等 DO 结束才开始，并直接把当前任务提示交还给模型。

### 优化
- **DO 阶段的催促文案收敛为一处**：驱动器的首次阶段播报、空闲保活，以及 `ralphflow_continue` 的上述回复，统一由 `buildDoNudge` 生成，不再有三份措辞不同的副本。

## 2.2.0

### 修复
- **手动步骤不再被误催促**：手动审查步骤的 DO 阶段里，当模型停下来向你提问时，不再自动注入「继续执行」的催促，让你能正常与模型来回讨论。
- **禁止把 `manual_step` 标在子工作流（复合）步骤上**：这类配置以前会静默失效（审查门永远不触发），现在加载时直接拒绝并给出明确原因——审查门只作用于带 `do`/`check` 的最小步骤。

### 新增
- **全自动免权限确认**：驱动工作流的会话中，模型的 edit/bash 等操作不再逐个弹出权限确认（通过 `permission.ask` 钩子按会话作用域自动放行）。仅对当前驱动工作流的属主会话生效；独立只读验证器不受影响，其只读边界保持不变。

### 优化
- **全流程「轮到谁」的提示**：每个阶段边界都会明确告知当前是「⏳ 自动进行中、静候即可」还是「🙋 轮到你了、需要你操作」。重点改进了 CHECK 阶段（明确提示等待、无需操作）、手动审查门、各类暂停与完成提示，并在启动时加入一次性上手指引。
- **全面中文化**：命令、工具与验证器 agent 的描述及提示模板统一为中文；仓库文档统一为中文。

## 2.1.5 及更早

见 Git 提交历史。
