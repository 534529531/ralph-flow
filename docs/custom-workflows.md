# 自定义工作流


把 `.yaml` 文件放到下面两个位置之一即可定义自己的工作流，或运行 `/ralphflow-create` 交互式设计并验证：

| 位置 | 作用范围 |
|------|----------|
| `.opencode/ralph-flow/workflows/` | **仅本项目** |
| `~/.config/opencode/ralph-flow/workflows/` | **全局** —— 所有项目可用，插件更新不会覆盖 |

解析顺序是**项目 → 全局 → 插件内置**：同名工作流靠前的层**遮蔽**靠后的（所以你可以在全局覆盖某个内置，或在某个项目覆盖你的全局版本）。线上安装时插件包本身是不可编辑的托管目录，这时全局层就是你想要的。

> 写完后运行 **`/ralphflow-doctor`**。它会在下面这些坑咬到你之前抓出来：缺必填字段的步骤会被**静默跳过**（其余工作流照常运行）、不可达步骤永不执行、没有通往 `done` 的路径的工作流永远无法完成、无法解析的 `{{...}}` 记号原样进入提示词。

---

## 快速示例

```yaml
description: 先分析再实现

steps:
  - id: analyze
    desc: 任务分析
    do: 分析需求，产出设计文档。
    input: 用户需求
    output: "design.md"
    check: 打开 design.md，核对是否完整、技术上合理。
    on_pass: execute
    on_fail: analyze
    max_fail_count: 3

  - id: execute
    desc: 实现
    do: 按设计实现，跑测试直到全绿。
    input: design.md
    output: 测试通过的可工作代码
    check: 自己跑测试套件，核对实现与 design.md 一致。
    on_pass: done
    on_fail: execute
    max_fail_count: 5
```

执行从**第一个**步骤开始。`on_pass: done` 结束工作流。

---

## 步骤字段参考

### 普通步骤

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 步骤唯一标识 |
| `desc` | ✅ | 人类可读描述（状态里会显示） |
| `do` | ✅ | 任务提示词 —— 工作会话要做什么 |
| `input` | ✅ | 本步骤消费什么 |
| `output` | ✅ | 本步骤必须产出什么 |
| `check` | ✅ | 独立会话执行的验证配方 |
| `on_pass` | ✅ | 通过后的下一步 id，或 `"done"` 表示完成 |
| `on_fail` | ✅ | 失败后重试/回退到的步骤 id（不允许 `"done"`） |
| `max_fail_count` | ✅ | 暂停前的最大 CHECK 失败次数（数字 ≥ 1，每步独立） |
| `reset` | ❌ | `true` 时，**进入**本步骤前换入一个全新的上下文会话（见[上下文重置门](#上下文重置门reset)） |

> ⚠️ **上面每个字段都是逐步骤必填的。** 缺任何一个的步骤会被**静默丢弃**，其余工作流照常运行。绝不要省略 `input`/`output`。`/ralphflow-doctor` 会报告每个被丢弃的步骤。

### 子工作流步骤

步骤可以用 `workflow:` 代替 `do`/`check` 调用另一个工作流：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 步骤唯一标识 |
| `desc` | ✅ | 人类可读描述 |
| `workflow` | ✅ | 要调用的工作流名称 |
| `input` | ✅ | 本步骤消费什么 |
| `output` | ✅ | 本步骤必须产出什么 |
| `inputs` | ❌ | 合并进子工作流任务的键值对 |
| `on_pass` | ✅ | 通过后的下一步 id，或 `"done"` |
| `on_fail` | ✅ | 失败后重试/回退到的步骤 id |
| `max_fail_count` | ✅ | 暂停前的最大失败次数 |
| `reset` | ❌ | `true` 时，**进入**该子工作流前换入全新上下文会话（大工作流尤其推荐） |

详见[工作流嵌套](#工作流嵌套)。

---

## 产出目录与模板变量

每个工作流实例有一个隔离的交付物目录 ——
`.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/` —— 工作流结束后**保留**。每个 DO 和 CHECK 提示词都自动携带指向它的 产出目录 一节，所以：

- 在 `output` 里写**裸文件名**（如 `"design.md"`、`"plan.json"`）。工作会话和验证者都知道往产出目录里放/找。
- 你**不需要**模板变量。引擎只解析一个记号 `{{artifacts_dir}}`（字节精确 —— 花括号内不能有空格），而且你几乎用不到它。
- 其他任何 `{{...}}` 记号会原样进入提示词。`/ralphflow-doctor` 会标记出来。

---

## 工作流级选项

### `description`

`/ralphflow-list` 里显示的一句话描述。可选（不填则回退到第一个步骤的 `desc`）。

```yaml
description: 实现、测试并文档化一个功能
```

### `manual_step`

需要**人工审查**的步骤 id。列表或逗号字符串两种写法都行：

```yaml
manual_step: [design]
# 或
manual_step: design, review
```

手动步骤在 **DO 完成后、验证开始前**暂停：会话用 📋 消息停下，好让你审查工作成果。你运行 `/ralphflow-continue` 之前工作流**不会**推进 —— 这条命令**就是**启动独立验证的批准。你要改，会话就改并再次输出 `<promise>done</promise>`，审查门重新武装。

> `manual_step` 里对不上真实步骤 id 的条目是**硬错误** —— 工作流无法加载。打错字绝不能静默跳过你指望的审查门。

> `manual_step` **不能标子工作流步骤**（`workflow:` 形式的复合步骤）——它们没有 DO 阶段，审查门永远不会触发。标了也是硬错误。要在子工作流之后停下审查，把 `manual_step` 标在**那个子工作流内部**的最后一个普通步骤上。

### `auto_reset`

`true` 时，等价于给每个步骤都标 `reset: true`——进入任何步骤都换入全新的上下文会话（含失败重试），与步骤级 `reset` 语义完全一致。缺省 `false`。

```yaml
auto_reset: true
```

适合多步长程工作流（每一步都在干净上下文里发挥最佳质量，失败重试同样换新上下文），代价是每步重建现场的 token 成本。粒度更细的控制用步骤级 `reset: true`（见[上下文重置门](#上下文重置门reset)）。纯线性工作流（每步 `on_fail` 都指回自身）开 `auto_reset` 时 doctor 会给成本提示（失败重试也会换会话）。

**完整示例** —— `manual_step` 里的 id 必须对应 `steps` 里的某个步骤：

```yaml
description: 带设计审查门的功能开发

manual_step: [design]        # design 步骤 DO 完成后停下审查

steps:
  - id: design
    desc: 技术设计
    do: 写 design.md，覆盖数据模型、API 形态、错误处理。
    input: 用户需求
    output: "design.md"
    check: 打开 design.md，核对是否覆盖数据模型、API 形态、错误处理。
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 实现
    do: 按批准的设计实现，跑测试直到全绿。
    input: design.md
    output: 测试通过的可工作代码
    check: 自己跑测试套件，核对代码与 design.md 一致。
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

运行时会发生什么：

1. **design** 步骤跑 DO 阶段，最后输出 `<promise>done</promise>`。
2. 因为 `design` 在 `manual_step` 里，会话**停下**并显示 📋 消息，而不是去验证 —— 你去读 `design.md`。
3. 你运行 `/ralphflow-continue`。*这时*独立验证者才检查 `design.md`；通过后工作流推进到 **implement**。
4. **implement** 是普通步骤，会自动验证，不会为你停下。

### `adversarial_check`

配置独立验证会话。默认 CHECK 阶段用 `ralph-check` agent（`edit: deny` 硬约束不修改 + `bash` 全开可执行任何验证命令）和它的默认模型。可自定义其中任意项：

```yaml
adversarial_check:
  agent: build                      # 换一个 agent（默认 ralph-check，edit 被硬拒绝）
  model:                            # 验证模型（对象形式）
    providerID: anthropic
    modelID: claude-haiku-4-5
  # model: anthropic/claude-haiku-4-5   # "provider/model" 字符串形式也可以
  system_prompt: |                  # 给检查者的额外 system prompt
    你是一个严格的代码审查员。检查：
    - 所有函数都有错误处理
    - 没有硬编码密钥
    - 测试覆盖边界情况
  timeout_ms: 1800000               # 检查超时（毫秒）；默认 900000（15 分钟），上限 3600000（1 小时）
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `agent` | 用哪个 agent 验证 | `ralph-check`（`edit: deny` + `bash: allow`） |
| `model` | `{providerID, modelID}` 对象或 `"provider/model"` 字符串 | 见下方「默认模型解析顺序」 |
| `system_prompt` | 给检查者的额外 system prompt | 内置验证提示词 |
| `timeout_ms` | 检查超时（毫秒，上限 `3600000`） | `900000`（15 分钟） |

> **不配 `model` 时验证用哪个模型？** 按顺序取第一个命中的：
> 1. 你在 opencode 配置里给验证 agent 显式指定的模型（如 `agent.ralph-check.model`）
> 2. **工作会话当前正在使用的模型** —— 你在 TUI 里切到什么，验证就跟着用什么
> 3. opencode 全局默认模型
>
> 所以多数情况无需配置：验证自动跟你当前会话同一个模型。想省钱（Haiku 查 Sonnet 的活）或换更强的验证模型时再显式配。

> **裸**模型名（如 `sonnet`、`Opus`）无法解析到 provider，会静默回退到 agent 的默认模型 —— 请用对象形式或 `"provider/model"` 字符串。对象形式则必须 **`providerID` 和 `modelID` 都填**（缺一个整个 `model` 被忽略）。`/ralphflow-doctor` 对这两种情况都会警告。

> **模型配错不会静默失败**：模型不存在或未授权时，CHECK 会以基础设施故障暂停，失败信息里带服务端返回的真实原因（如 `Model not found: ...`）——修好配置后 `/ralphflow-continue` 重新验证即可，不消耗失败次数。

**使用场景：**
- 用**更便宜的模型**验证（如用 Haiku 检查 Sonnet 的工作）
- 用**更严格、`edit` 被硬拒**的 agent
- 为特定领域自定义 **system prompt**
- 为需要更长验证的任务增大**超时**

### 子工作流里的继承

`adversarial_check` 沿子工作流调用链**逐字段继承**（类似 Java 的字段覆写）：子工作流里每个**填了且有效**的字段覆盖父工作流；没填或填了但无效（裸模型名、缺 `providerID` 的对象）的字段回退到父工作流，逐层向外直到内置默认。

```yaml
# 父工作流
adversarial_check:
  model: anthropic/claude-haiku-4-5
  timeout_ms: 1800000

# 子工作流（只覆盖 model）
adversarial_check:
  model: openai/gpt-5
# → 子工作流内的 CHECK：model 用 gpt-5，timeout_ms 继承父的 1800000
```

所以常见做法是在**最外层**工作流统一配置验证模型/超时，子工作流只在确有必要时覆盖个别字段。

---

## 工作流嵌套

步骤可以调用其他工作流，实现组合与复用。子工作流步骤同样需要 `input`/`output`（和每个步骤一样）。

### 基本用法

```yaml
# workflows/full-dev.yaml
steps:
  - id: analyze
    desc: 需求分析
    workflow: analyze              # 调用 workflows/analyze.yaml
    input: 用户需求
    output: 分析产物
    inputs:
      task: "分析需求"
    on_pass: build
    on_fail: analyze
    max_fail_count: 3

  - id: build
    desc: 实现
    workflow: build                # 调用 workflows/build.yaml
    input: 分析产物
    output: 可工作代码
    on_pass: done
    on_fail: build
    max_fail_count: 3
```

### 传递输入

用 `inputs` 向子工作流的任务传参：

```yaml
steps:
  - id: analyze
    desc: 分析功能
    workflow: analyze
    input: 功能请求
    output: 设计文档
    inputs:
      task: "设计认证模块"
      context: "我们用带 refresh token 的 JWT"
    on_pass: done
    on_fail: analyze
    max_fail_count: 3
```

`inputs` 会合并进子工作流的 `user_task`，其会话可以读到。

### 多层嵌套

工作流最多嵌套 **5 层**：

```
full-dev.yaml
  └── analyze.yaml
       └── research.yaml
            └── ...
```

引擎为每个实例维护一个状态栈保存嵌套时的父级上下文；循环由 `/ralphflow-doctor` 检测。

### 工作原理

1. 父工作流到达子工作流步骤
2. 父状态被压入栈
3. 子工作流以组合上下文（inputs + 原始任务）启动
4. 子工作流完成后，父状态被恢复
5. 父级根据子工作流结果（通过/失败）继续

---

## 上下文重置门（reset）

长工作流跑到后半段，主会话的上下文已经塞满前面步骤的探索、试错和验证记录——模型开始丢需求、跑偏、重复犯错。重置门让你在步骤边界**换一个全新的会话**继续工作流：上下文干净了，质量回来了。

### 三种触发方式

| 方式 | 写法 | 适用 |
|------|------|------|
| 步骤级 | 步骤上标 `reset: true` | 在进入最重的步骤前切一刀（推荐，如 `implement`） |
| 工作流级 | 顶部 `auto_reset: true` | 多步长程流，每步都换（等价于给所有步骤标 `reset`） |
| 手动 | 随时运行 `/ralphflow-reset`（可选传 `reason`） | 感觉当前会话"脏了"，立即换个干净的重做当前步骤 |

> `reason` 参数（**可选**）来自用户、说明"为什么重置、重做时注意什么"。传入后会跨会话注入新会话首条 DO 提示前并随空闲保活保留；不传时行为与旧版字节级一致。

### 触发规则

**一条规则**：标了 `reset` 的步骤（`auto_reset: true` = 所有步骤），**任何方式进入都触发**——包括同步骤失败重试（`on_fail` 指回自身）。失败原因经 `retryContext` 文本通道注入 DO 提示，重试换会话不丢现场。

- 未标 `reset` 的步骤：同步骤重试**不触发**（轻量步骤的现场记忆有用），跨步骤转换也不触发。
- 嵌套工作流完整适配：标记可以打在 **`workflow:` 复合步骤上**（进入该子工作流前换会话），也可以打在**子工作流内部**的普通步骤上（子工作流自己就是个工作流，规则相同）。子工作流失败沿 `on_fail` 回炉重进复合步骤时同样判定。
- 手动重置只能在 **DO 阶段**进行（CHECK 阶段有独立验证在跑），且实例**暂停时拒绝**（`paused` 会随状态带进新会话，新会话的空闲驱动对暂停实例静默——先 `/ralphflow-continue` 恢复）；`fail_count` **不赦免**——想清零失败预算走「暂停 → `/ralphflow-continue`」的显式路径。

### 重置时发生什么

1. 创建**新的顶级会话**（`/session` 列表可见，标题 `🔄 工作流名 · 步骤`），TUI 自动跳转过去；
2. 旧会话正在进行的回合被中止（防止新旧会话同时改工作区），历史完整保留，随时可切回查看；
3. 新会话的第一条注入带**会话交接说明**（为什么接手、步骤进度、产出目录、done 约定）+ 完整 DO 提示——之前步骤的产出都在项目和 artifacts 目录里，模型直接读取，不重做；
4. 工作流状态（当前步骤、`fail_count`、失败原因）原样延续，模型跟随旧会话当前使用的模型。

> 首步标 `reset` 时启动不触发（启动时本来就是新会话），但**每次失败重试（`on_fail` 回本步）与后续步骤 `on_fail` 回首步都会触发**——单步骤 loop 任务会频繁重置，token 成本较高（自定义工作流 doctor 会提示成本；插件内置的 `loop` 工作流默认就标了 `reset`，跳过该提示）。

---

## 中途回退（rewind）

`on_pass`/`on_fail` 是工作流**作者**预设的静态路由——只有当 CHECK 判定失败时引擎才按图跳另一格步。**用户在运行时主观判断"前面某步方向错了、要回去重做"** 则是另一回事——这正是 `/ralphflow-rewind`，它**与工作流 YAML 完全解耦**：rewind 不读 `on_fail`、不改 workflow 定义，只把状态机运行时的 `current_step` 倒退一格。

```
/ralphflow-rewind propose "第二步的技术文档里 API 假设错了，得回过去重设计"
```

| 限定 | 说明 |
|------|------|
| **目标** | 必须是本工作流里**已通过独立 CHECK** 的上游步骤（用每实例 step records 判定）。回退到没通过过的步骤、未来步骤、当前步骤（用 `/ralphflow-reset`）、子工作流（复合）步骤、不属于本工作流的步骤都会被拒绝并提示可选清单 |
| **状态机** | 倒退到目标步骤的 DO 阶段；`fail_count` **归零**；`paused` **清除**；`last_failure_reason` 清掉（避免误导模型认为是 CHECK 重试）——与 `/ralphflow-continue` 的"显式赦免"语义一致 |
| **下游产物** | 已落盘的代码/文档**保留**——插件**不会自动删除**任何产物，按用户给的 `reason` 决定保留、调整还是让模型覆盖旧产出 |
| **`reason`** | **必填**、来自用户（"为什么回退、重做时要注意什么"）；跨会话注入新会话首条 DO 提示前并随空闲保活重注入保留——这是新会话冷启动时唯一的重做方向指引 |
| **会话** | 默认换入干净会话（与 reset 门同路径：新顶级会话、`/session` 可见、TUI 自动跳转、旧会话被中止、带会话交接说明）；`keep_session: true` 在当前会话继续，只倒退状态机 |
| **paused 实例** | 允许 rewind——很多用户正是发现卡死之后才决定换个方向重来，回退顺便清掉暂停 + 归零 fail_count |
| **跨子工作流栈帧** | 当前在子工作流里（state stack 非空）时一律拒绝——回到父工作流步骤需要决定弹栈到哪一层、把哪几层进度作废，第一版留白；更直接的做法是 `/ralphflow-cancel` + 重新 `/ralphflow-start` |

rewind 与 reset 的边界对照见 [工作原理 → 中途回退与上下文重置](how-it-works.md#中途回退与上下文重置)。设计细节见 `docs/reset-gate-design.md`。

---

## 完成标记

会话用 XML 式标记表示完成：

| 阶段 | 标记 | 含义 |
|------|------|------|
| DO | `<promise>done</promise>` | 任务完成 |
| CHECK | `<promise-check>true</promise-check>` | 通过 |
| CHECK | `<promise-check>false</promise-check>` | 失败 |

> 标记大小写不敏感、容忍空白。done 标记须在最后一行（或最后 100 字符内）；check 标记须独占验证者的最后一行。代码围栏或行内代码里的标记会被忽略。

---

## 多步骤流程设计

> 下面每个示例都是完整、合法的工作流 —— 每个普通步骤都带 `input` 和 `output`。

### 线性流程

最简单的模式 —— 步骤顺序执行：

```yaml
steps:
  - id: design
    desc: 设计阶段
    do: 创建技术设计。
    input: 用户需求
    output: "design.md"
    check: 核对 design.md 是否完整、合理。
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 实现阶段
    do: 按 design.md 写代码。
    input: design.md
    output: 可工作代码
    check: 跑测试并核对通过。
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### 分支流程

根据检查结果跳到不同步骤：

```yaml
steps:
  - id: analyze
    desc: 分析问题
    do: 判断这是 bug 修复还是新功能。
    input: 用户报告
    output: "analysis.md（对任务的分类）"
    check: analysis.md 的分类是否有报告依据支撑？
    on_pass: implement
    on_fail: clarify
    max_fail_count: 2

  - id: clarify
    desc: 请求澄清
    do: 向用户询问缺失细节并记录回答。
    input: analysis.md
    output: "clarification.md（含回答）"
    check: clarification.md 是否含有足以推进的细节？
    on_pass: analyze
    on_fail: clarify
    max_fail_count: 3

  - id: implement
    desc: 实现修复
    do: 写代码。
    input: analysis.md
    output: 可工作代码
    check: 是否能构建并通过测试？
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### 恢复流程

用 `on_fail` 路由到专门的恢复步骤：

```yaml
steps:
  - id: build
    desc: 构建项目
    do: 运行构建。
    input: 源码树
    output: 构建产物
    check: 构建成功了吗？
    on_pass: test
    on_fail: fix-build
    max_fail_count: 2

  - id: fix-build
    desc: 修复构建错误
    do: 阅读错误输出并修复问题。
    input: 构建错误输出
    output: 能构建的源码树
    check: 现在构建能过吗？
    on_pass: test
    on_fail: fix-build
    max_fail_count: 5

  - id: test
    desc: 跑测试
    do: 执行测试套件。
    input: 构建产物
    output: 测试结果
    check: 所有测试都通过吗？
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 3

  - id: fix-tests
    desc: 修复失败的测试
    do: 分析失败并修复。
    input: 测试失败输出
    output: 通过的测试套件
    check: 现在测试通过吗？
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 5
```

### 循环流程（回环）

把 `on_fail` 指向更早的步骤形成环：

```yaml
steps:
  - id: design
    desc: 设计
    do: 创建技术设计。
    input: 需求
    output: "design.md"
    check: 设计是否完整、合理？
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 实现
    do: 按 design.md 写代码。
    input: design.md
    output: 能编译、lint 干净的代码
    check: 代码能编译并通过 lint 吗？
    on_pass: test
    on_fail: design          # 实现暴露出设计缺陷则回到 design
    max_fail_count: 3

  - id: test
    desc: 测试
    do: 跑全量测试套件。
    input: 实现
    output: 测试结果
    check: 所有测试都通过吗？
    on_pass: done
    on_fail: implement       # 测试失败则回到 implement
    max_fail_count: 5
```

形成环 `design → implement → test → implement → test → …`。实现暴露设计缺陷就回到 `design`；测试失败就回到 `implement`。工作流自然收敛到可工作的解。

---

## 建议

- **步骤要聚焦** —— 每个步骤把一件事做好。
- **写自包含的 `check` 配方** —— 验证者完全没看过 DO 对话，所以要写明打开哪些文件、跑哪些命令、具体的通过/失败标准。模糊标准（"代码质量好"）让 CHECK 失效。
- **轻量 persona 助推验证** —— `check` 开头加一句如「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」很有用。保持一行，别搞重型角色设定。
- **合理设 `max_fail_count`** —— 有界步骤 3–5，磨到全绿的循环设大（如 100）。
- **在错误方向代价高的地方用 `manual_step`** —— 方案、设计、破坏性操作。
- **用子工作流复用** —— 通用模式（分析、构建、测试）可以共享。
- **验证用更便宜的模型** —— `adversarial_check.model` 能在保持质量的同时省钱。
- **`do`/`check` 正文用用户的语言写。**
