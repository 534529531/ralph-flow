# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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
