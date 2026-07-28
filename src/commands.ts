/**
 * Ralph Flow slash commands — opencode adapter.
 *
 * The command templates are ports of the Claude Code plugin's user-invocable
 * skills (skills/ralphflow-&lt;name&gt;/SKILL.md); the underlying tools share the exact
 * MCP tool names (ralphflow_start, ralphflow_continue, …) so the texts stay
 * word-for-word portable. Path references use .opencode/ralph-flow/.
 *
 * All user-facing prose is Chinese (this plugin serves Chinese users); only
 * identifiers — tool names, arg keys, tags, file paths — stay verbatim.
 */

export interface RalphCommandDef {
  description: string;
  template: string;
}

/**
 * 由 \`ralphflow_start\` 启动工作流之后，模型需要知道的全部机制说明。
 * /ralphflow-start 和每个工作流的动态快捷命令（/loop、/spec……）共享这份文本，
 * 保证两条入口的行为指引永远一致。
 */
const SHARED_MECHANISM = `**extra_dirs**：如果任务的源材料位于当前项目目录之外（例如把 \`~/some-c-lib\` 迁移进本项目），把这些目录通过可选的 \`extra_dirs\` 参数传入——独立的 CHECK 验证器从项目目录运行，必须能读取它要对照验证的源材料。每个目录在启动时都会校验；不存在的路径会立即拒绝启动。不要猜测：只传用户确实提到的路径。

每次启动都会创建一个新的**工作流实例**（响应里带有它的实例 id）。一个会话最多运行一个实例；同一项目下的多个会话可以各自并行运行自己的实例。如果工具提示本会话已有活跃实例，请先完成或取消它。

## 工作流机制

每个工作流步骤有两个阶段：

**DO 阶段（执行）**：
- 根据你收到的提示执行当前步骤的任务
- 完成实际工作（写代码、创建文件、运行命令）
- 所有任务要求满足后，在回复的**最后一行**输出 \`<promise>done</promise>\`
- 对于**普通步骤**，到此为止——你空闲时系统会**自动**运行独立的 CHECK。你不需要调用任何工具。
- 对于**手动步骤**，系统会停下会话并请**用户**审查——只有用户的 /ralphflow-continue 才会启动验证。

**CHECK 阶段（验证，普通步骤自动进行）**：
- 你输出 done 标记后，一个独立的验证器会话会依据该步骤的检查依据验证你的工作（你会看到一条「🔍 CHECK 阶段」消息，然后一条「检查结果：通过/未通过」消息）。
- 通过则工作流自动推进到下一步并注入下一个 DO 提示。
- 未通过则你会收到失败原因并重做该步骤。

**重要**：完成时你**必须**在单独的最后一行输出 \`<promise>done</promise>\`。普通步骤不要调用 \`ralphflow_continue\`——验证是自动的。\`ralphflow_continue\` 只用于：批准手动审查、恢复暂停的工作流，或接管中断的实例。

## 暂停与恢复

**达到最大失败次数**：如果某步骤验证失败太多次（超过 \`max_fail_count\`），工作流会暂停。你需要：
1. 用 \`/ralphflow-status\` 查看失败原因
2. 手动修复问题
3. 调用 \`ralphflow_continue\` 恢复（这会重置失败计数并重试）

**手动步骤**：工作流 \`manual_step\` 里列出的步骤会在 **DO 阶段完成后、验证之前**暂停。会话会带一条 📋 消息停下，供用户审查。等待用户；他们的 \`/ralphflow-continue\` 会启动独立验证。如果用户要求修改，改完后再次输出 \`<promise>done</promise>\`——审查门会重新布防。

## 启动之后

工作流启动后，执行你收到的 DO 提示。完成实际工作（写代码、创建文件、运行命令），完成时在最后一行输出 \`<promise>done</promise>\`。

## 阶段播报

系统会通过注入的消息自动通知你阶段转换。收到这些通知时，简短地确认一下，让用户随时了解进度：

- **DO 阶段**：说明你正在做什么（例如「我现在处于 DO 阶段，正在处理 [任务]」）
- **CHECK 阶段**：告知用户验证正在进行（例如「CHECK 阶段已开始，等待验证」）
- **步骤完成**：检测到 done 标记时确认（例如「步骤完成，进入 CHECK」）

这能帮助用户跟踪工作流进度，无需手动查看状态。`;

export const RALPH_COMMANDS: Record<string, RalphCommandDef> = {
  "ralphflow-reset": {
    description: "手动重置工作流上下文——换一个干净的会话继续执行当前步骤",
    template: `调用 \`ralphflow_reset\` 工具在当前 DO 阶段创建一个全新的上下文。
    
用户输入：$ARGUMENTS

**何时用它**：
- 你觉得当前对话太长、模型开始跑偏或忘记需求
- 上下文质量明显下降（模型反复犯错、丢细节、忽视用户指令）
- 想换一个干净的会话，但保留已完成的工作产出

**执行后会发生什么**：
- 当前会话保留（聊天历史不丢，随时切回查看）
- 新会话自动被创建，模型在那里用干净的上下文重新执行当前步骤
- 产物目录和所有已完成的工作都保留，不受影响
- 失败计数**保留**——重置只换干净的上下文，不会重置工作流状态（想重算失败预算，先等工作流暂停再用 \`/ralphflow-continue\` 显式恢复）

调用 \`ralphflow_reset\`（不带参数对本会话的实例；本会话有多个实例时需指定 \`instance\` 参数，支持唯一前缀）。不要猜测——只在用户确实要求时调用。`,
  },

  "ralphflow-start": {
    description: "启动一个 ralph-flow 工作流",
    template: `启动一次 Ralph Flow 工作流执行。

用户输入：$ARGUMENTS

用户需要同时指定工作流名称和任务描述。如果信息不完整，向用户询问：

- 只有任务、没有工作流 → 询问用哪个工作流
- 只有工作流、没有任务 → 询问要做什么
- 两者都没有 → 两者都问

不要猜测该用哪个工作流——让用户来选。

可用工作流：用 \`ralphflow_list\` 工具查看。

信息齐全后，调用 \`ralphflow_start\` 工具启动工作流。

${SHARED_MECHANISM}`,
  },

  "ralphflow-continue": {
    description: "批准手动审查 / 标记步骤完成 / 恢复或接管一个 ralph-flow 工作流",
    template: `调用 \`ralphflow_continue\` 工具。它覆盖四种情况：

用户输入：$ARGUMENTS

**普通步骤是自动的**：你输出 \`<promise>done</promise>\` 标记后，系统会自动运行独立验证并推进——你**不要**调用本工具。\`ralphflow_continue\` 只用于下面三种情况。

**批准手动审查**：当用户在一次 📋 手动步骤审查后运行本命令时，调用 \`ralphflow_continue\` 就是他们的批准——它会启动独立验证。（手动审查期间，绝不要自作主张调用它。）

**恢复暂停的工作流**：如果工作流因达到最大失败次数而暂停：
1. 查看 \`/ralphflow-status\` 里显示的失败原因
2. 修复导致失败的问题
3. 调用 \`ralphflow_continue\`——它会重置失败计数并重试该步骤

**接管中断的实例（新会话）**：如果用户在本命令里提供了实例 id，把它作为 \`instance\` 参数传入（支持唯一前缀）。不带 id 时：
- 项目里只有一个实例 → 自动接管
- 存在多个实例 → 工具会返回实例列表；把它展示给用户并询问要接管哪个，然后带 \`instance\` 再次调用
- 接管一个中断于 DO 阶段的实例会返回 DO 提示——继续执行那个任务；如果它是在 done 之后中断的，验证会直接开始

## 阶段播报

调用 \`ralphflow_continue\` 后，系统会通知你下一个阶段。简短确认一下，让用户了解情况：

- 如果进入 DO 阶段：「已推进到步骤 [X]，现在处于 DO 阶段」
- 如果处于 CHECK 阶段：「步骤 [X] 正在验证」
- 如果工作流完成：「所有步骤完成，工作流结束」
- 如果暂停：说明原因以及接下来需要做什么`,
  },

  "ralphflow-status": {
    description: "显示 ralph-flow 工作流状态（本会话的实例或所有实例）",
    template: `显示 Ralph Flow 工作流状态。

用户输入：$ARGUMENTS

调用 \`ralphflow_status\` 工具：
- 不带参数时，显示本会话的实例；若本会话没有实例，则显示项目里所有活跃实例的概览（id、工作流、步骤、状态、属主会话、最后活动）。
- 如果用户指定了某个实例，把它作为 \`instance\` 参数传入（支持唯一前缀）以查看该实例。

每个实例显示：
- 工作流名称、当前步骤和阶段（do/check）
- 状态：执行中 / 验证中 / 等待手动审查 / 已暂停（含原因）
- 失败次数和上次失败原因（如有）
- 属主会话——属于其他（或已关闭）会话的实例，可通过 \`ralphflow_continue\` 接管`,
  },

  "ralphflow-list": {
    description: "列出可用的 ralph-flow 工作流和活跃实例",
    template: `列出所有可用的 Ralph Flow 工作流和活跃的工作流实例。

调用 \`ralphflow_list\` 工具，显示：
- 所有工作流名称，及每个的简短描述
- 本项目里所有活跃的工作流实例（id、工作流、步骤、状态、属主会话）

工作流按以下顺序解析（同名工作流，靠前的层级会遮蔽靠后的）：
1. 项目自定义（.opencode/ralph-flow/workflows/）——仅本项目
2. 全局自定义（~/.config/opencode/ralph-flow/workflows/）——所有项目，且插件更新不会覆盖
3. 插件内置（随插件打包）`,
  },

  "ralphflow-cancel": {
    description: "取消一个 ralph-flow 工作流实例",
    template: `取消一个 Ralph Flow 工作流实例。

用户输入：$ARGUMENTS

调用 \`ralphflow_cancel\` 工具来正确取消工作流：它会中止任何正在运行的验证会话，把最终报告归档到 \`.opencode/ralph-flow/reports/\`，并移除实例目录（包括子工作流状态栈）。

- 不带参数时，取消本会话的实例（或项目里唯一的实例）。
- 要取消特定实例（例如属于其他/已关闭会话的实例），传入 \`instance\` 参数（支持唯一前缀）。如果工具返回的是实例列表，把它展示给用户并确认要取消哪个。

不要手动删除文件——用工具来确保正确清理。`,
  },

  "ralphflow-doctor": {
    description: "诊断 ralph-flow 工作流定义和实例状态，解释问题并提供修复",
    template: `诊断所有 Ralph Flow 工作流定义（项目自定义 + 插件内置）和实例状态的健康状况。

## 步骤

1. 调用 \`ralphflow_doctor\` 工具。它是只读的，返回一份完整的诊断报告：
   - 每个工作流的结论（可启动 / 损坏），附**完整**的校验问题列表，而不只是第一个
   - 可启动工作流的警告：被静默跳过的步骤、不可达步骤、无法解析的 \`{{...}}\` 记号、损坏的子工作流引用、子工作流成环、被截断的 \`adversarial_check\` 字段
   - 遮蔽：当项目和插件定义了同名工作流时实际运行的是哪个文件，以及无效的项目文件何时会静默回退到内置文件
   - 因不是工作流结构而被忽略的 YAML 文件
   - state.json 缺失/损坏的实例目录

2. 把报告呈现给用户。对每个问题，用平实的语言解释根因及其后果（例如「这个步骤被静默丢弃了——工作流照常运行，但少了它」）。

3. **主动提出修复。** 如果用户同意（或一开始就要求修复），直接编辑有问题的 YAML 文件，然后再次调用 \`ralphflow_doctor\` 确认报告干净。重复直到没有问题。绝不要编辑插件内置的工作流文件——如果内置的需要不同行为，把它复制到 \`.opencode/ralph-flow/workflows/\` 再改副本（它会按名称遮蔽内置的）。

## 常见问题 → 修复

| 报告中的症状 | 修复 |
|---|---|
| 缺失/无效的 \`input\` / \`output\` / \`do\` / \`check\` / \`desc\` / \`on_pass\` / \`on_fail\` / \`max_fail_count\` | 给该步骤补上缺失的字段。每个非子工作流步骤都需要：\`id\`、\`desc\`、\`do\`、\`check\`、\`input\`、\`output\`、\`on_pass\`、\`on_fail\`、\`max_fail_count\`（数字 ≥ 1） |
| 步骤被静默跳过 | 同上——该步骤缺少必填字段；工作流其余部分仍通过校验，所以会**在没有这个步骤**的情况下运行 |
| \`on_pass\`/\`on_fail\` 引用了不存在的步骤 | 修正拼写，或用 \`done\`（仅 \`on_pass\` 可用，表示工作流完成） |
| \`manual_step\` 引用了不存在的步骤 | 修正顶层 \`manual_step\` 列表里的步骤 id（这是设计上的硬错误：拼错的审查门绝不能无门运行） |
| \`manual_step\` 用在了子工作流（复合）步骤上 | 把它改标到带 do/check 的最小步骤上；审查门只作用于最小步骤，标在子工作流步骤上会导致加载被拒 |
| 步骤不可达 | 通过某个步骤的 \`on_pass\`/\`on_fail\` 把它接入图，或删除它。执行从 \`steps\` 的**第一个**元素开始 |
| 没有任何可达步骤的 \`on_pass: done\` | 把最后一步的 \`on_pass\` 指向 \`done\` |
| 无法解析的模板记号 | 删掉它。引擎只解析一个记号 \`{{artifacts_dir}}\`（花括号内不能有空格），而且通常你连它都不需要——每个 DO/CHECK 提示都会自动带上「产出目录」一节 |
| 子工作流无法加载 | 修正 \`workflow:\` 名称或创建被引用的工作流文件 |
| 子工作流成环 | 打破环；嵌套上限为深度 5，运行时会报错 |
| 无效的项目文件回退到了内置 | 修复项目文件——现在用这个名字启动运行的是**内置的**，不是用户那份 |
| 损坏的实例 state.json | 该实例无法恢复；用户确认不需要后，删除 \`.opencode/ralph-flow/instances/<id>/\` |

要新建一个工作流而不是修复现有的，建议使用 \`/ralphflow-create\`。`,
  },

  "ralphflow-create": {
    description: "交互式设计并创建一个自定义 ralph-flow 工作流，经校验后即可运行",
    template: `和用户一起交互式设计一个自定义 Ralph Flow 工作流，把它写入 \`.opencode/ralph-flow/workflows/<name>.yaml\`，并用 \`ralphflow_doctor\` 工具校验，直到它干净且可启动。

用户输入：$ARGUMENTS

## 步骤

1. **理解要自动化的流程。** 询问用户（一轮问清，不要盘问）：
   - 要让工作流运行的是什么重复性流程？它有哪些阶段？
   - 他们希望在哪里设人工审查门（工作流在验证前停下等他们批准）？
   - 某个阶段是否要复用现有工作流作为子工作流？（\`ralphflow_list\` 显示已有哪些。）
   如果用户已经把这些都描述清楚了，跳过提问直接设计。

2. **设计步骤图并呈现**，在写文件前给出一个紧凑的概览（步骤 id → 它做什么 → on_pass/on_fail 目标）。根据反馈调整。

3. **写 YAML**（kebab-case 命名）。询问用户存放范围，或默认放项目：
   - 仅本项目 → \`.opencode/ralph-flow/workflows/<name>.yaml\`
   - 所有项目可用 → \`~/.config/opencode/ralph-flow/workflows/<name>.yaml\`（全局；插件更新不会覆盖）

   需要时创建目录。如果名字和内置工作流（\`loop\`、\`spec\`）相同，告诉用户它会遮蔽内置的，并确认这是有意为之。

4. **校验**：调用 \`ralphflow_doctor\` 工具，检查新工作流那一节。修复它为该工作流报出的每一个问题和警告，重新运行 doctor，重复直到它的结论是「可启动」且没有警告。

5. **交接**：把最终的步骤概览展示给用户，并告诉他们怎么运行：本会话里用 \`/ralphflow-start\`，工作流填 \`<name>\`，再加上他们的任务描述；从**下个会话**起，还可以直接用自动注册的 \`/<name>\` 快捷命令（补全列表里以 \`(ralph-flow)\` 标注）。

## YAML 结构（精确——引擎会校验以下全部内容）

\`\`\`yaml
description: 一行描述，显示在 ralphflow_list 里   # 可选，但建议填

manual_step:            # 可选：在 DO 之后、验证之前暂停以供人工审查的步骤 id
  - design

adversarial_check:      # 可选：独立 CHECK 会话的配置
  agent: ralph-check    # 可选：验证器使用的 opencode agent（默认 ralph-check，edit: deny + bash 全开）
  model:                # 可选：验证器模型；对象形式或 "provider/model" 字符串
    providerID: anthropic
    modelID: claude-sonnet-4-5
  timeout_ms: 3600000   # 上限 3600000（1 小时）
  # system_prompt: ...  # 可选：给验证器的额外 system 提示
  # 嵌套时逐字段继承：子工作流只覆盖它填了且有效的字段，其余回退父工作流
\`\`\`

\`\`\`yaml
steps:                  # 必填，非空；执行从**第一个**元素开始
  - id: step-id         # 必填，唯一字符串
    desc: 一句话说明     # 必填
    do: |               # 必填（除非这是子工作流步骤）
      由执行会话运行的 DO 阶段指令。
    check: |            # 必填（除非是子工作流步骤）
      由**独立**验证器会话运行的 CHECK 阶段指令。
    input: 上一步的产物或用户输入   # 必填：这一步消费什么
    output: "result.md"            # 必填：这一步必须产出什么
    on_pass: next-step-id          # 必填：步骤 id，或 "done" 表示结束工作流
    on_fail: step-id               # 必填：重试/回退到的步骤 id（不允许 "done"）
    max_fail_count: 3              # 必填，数字 ≥ 1：CHECK 失败这么多次后为用户暂停

  - id: delegate        # 子工作流步骤：用以下内容替代 do/check：
    workflow: loop      # 另一个工作流的名字（嵌套上限深度 5，不能成环）
    desc: ...
    input: ...
    output: ...
    on_pass: done
    on_fail: delegate
    max_fail_count: 3
\`\`\`

引擎强制的硬规则（违反会导致文件不可启动或静默丢弃步骤）：

- 上面标注必填的每个字段都是**每个步骤**必填——缺一个的步骤会被**静默跳过**，而工作流其余部分照常运行。绝不要省略 \`input\`/\`output\`。
- \`on_pass\`/\`on_fail\` 必须引用存在的步骤 id（\`done\` 仅 \`on_pass\` 有效）。
- \`manual_step\` 条目必须匹配存在的步骤 id——拼错是设计上的硬错误。
- \`manual_step\` 只能标在带 do/check 的最小步骤上，**不能**标在子工作流（复合）步骤上——否则加载即被拒绝。若要在子工作流后停下审查，把 manual_step 标在该子工作流内部最后一个普通步骤上。
- **没有模板变量。** 引擎除了内部的 \`{{artifacts_dir}}\` 转义记号什么都不解析，而你不需要它：每个 DO/CHECK 提示都会自动带上「产出目录」一节。在 \`output\` 里写裸文件名（例如 \`"plan.md"\`）；会话知道要把它们放进产出目录。

## 设计最佳实践（除非用户反对，都应用这些）

- **\`do\` 必须要求真实工作**，而不是分析：创建文件、运行命令、产出指定的输出。会话通过输出 \`<promise>done</promise>\` 结束 DO。
- **\`check\` 由一个没看过任何 DO 对话的独立会话执行。** 把它写成自包含的验证配方：打开哪些文件、运行哪些命令、具体的通过/失败标准。含糊的标准（「代码质量好」）会让 CHECK 形同虚设。
- **检查清单模式** 适合开放式任务：第一步把需求拆解成一份 \`checkpoints.md\`，其中每一项都客观可验证并标注验证方法；后续步骤执行并勾选；它们的 \`check\` 独立地重新验证每一项，而不是相信勾选。
- **在 \`check\` 里加轻量的角色暗示** 能让验证更犀利，例如开头写「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」保持一行——不要重量级的角色设定。
- **重试循环**：\`on_fail\` 通常指向步骤自身；只有当一次失败真的让早前的产出失效时，才指向更早的步骤。\`max_fail_count\` 对有界步骤取 3–5，对「磨到通过」的循环取大值（如 100）。
- **人工门** 用在方向错了代价很大的地方（方案、设计、破坏性操作）——把这些步骤 id 列进 \`manual_step\`。
- **语言**：\`do\`/\`check\` 的正文用用户的语言书写。`,
  },
};

// ─── 动态工作流命令（/loop、/spec……）──────────────────────────────────────────

/**
 * 把工作流名规范化为 slash 命令名：小写、非法字符折成连字符。
 * 返回 null 表示这个名字无法构成命令（例如全是中文/符号），该工作流只能走
 * /ralphflow-start。规范化只是命令名——模板里给 ralphflow_start 的 workflow
 * 参数始终是原始工作流名。
 */
export function workflowCommandName(workflowName: string): string | null {
  const slug = String(workflowName)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/**
 * 为单个工作流生成它的快捷命令定义（/loop、/spec……）。description 以
 * (ralph-flow) 前缀标注来源，对应补全列表里 "loop (ralph-flow) …" 的观感。
 * 模板与 /ralphflow-start 共享 SHARED_MECHANISM，唯一区别是工作流名已固定、
 * 只需要任务描述。
 */
export function buildWorkflowCommand(workflowName: string, desc: string): RalphCommandDef {
  return {
    description: `(ralph-flow) ${desc || `启动 ${workflowName} 工作流`}`,
    template: `启动 Ralph Flow 的 \`${workflowName}\` 工作流。

用户输入（任务描述）：$ARGUMENTS

调用 \`ralphflow_start\` 工具启动：
- \`workflow\` 参数固定填 \`"${workflowName}"\`——不要改成别的工作流名
- \`task\` 参数填用户输入的任务描述
- 如果用户没有给出任务描述（输入为空），先询问要做什么，再调用

${SHARED_MECHANISM}`,
  };
}

/**
 * 把每个可启动的工作流注册成一个快捷 slash 命令（直接改传入的 commands 表）。
 *
 * 这是启动时的快照：此后新建的工作流要到下个会话（或重启）才有命令，
 * 在此之前走 /ralphflow-start。
 *
 * 冲突策略：绝不覆盖——用户自己的命令、其他插件的命令、静态管理命令
 * （ralphflow-*，调用方先注册）都优先，撞名的工作流静默跳过，仍可用
 * /ralphflow-start <name> 启动。定义无效（invalid）的工作流不注册：
 * 启动必然失败，留给 /ralphflow-doctor 暴露。
 */
export function registerWorkflowCommands(
  commands: Record<string, { template: string; description?: string } | undefined>,
  workflows: Array<{ name: string; desc: string; invalid?: boolean }>,
): void {
  const taken = new Set<string>();
  for (const wf of workflows) {
    if (wf.invalid) continue;
    const cmdName = workflowCommandName(wf.name);
    if (!cmdName || taken.has(cmdName)) continue; // 规范化后撞名（如 My_Flow 与 my-flow）
    taken.add(cmdName);
    if (!commands[cmdName]) {
      commands[cmdName] = buildWorkflowCommand(wf.name, wf.desc);
    }
  }
}
