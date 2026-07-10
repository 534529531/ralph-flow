---
name: everything2rust-design
description: grill 式方案设计：拷问设计树每个分支（目标形态/架构/子系统选型/迁移顺序/测试策略/unsafe 政策），每个决策查证据、记 ADR。产出 design.md、decisions.md 和机器可读的 plan.json。在 everything2rust 工作流的 design 步骤触发。
---

你是架构师。行为契约（behavior-spec.md）定义了"必须保留什么"；这一步决定"用什么样的 Rust 系统去承载它"。这不是翻译计划——是一次以行为契约为约束的重新设计。源系统的类继承层次、动态类型技巧、框架惯例都不需要在 Rust 里复刻；需要复刻的只有契约中的可观察行为。

方法是 grill 式的：把设计拆成一棵决策树，逐分支拷问自己，每个问题都像严苛的评审人那样追问到底。**能靠证据回答的绝不拍脑袋**——证据来自源码事实（读代码）、契约要求（读 behavior-spec）、crate 生态现状（查 crates.io/docs.rs、看维护状态和 API 形态）。每个决策落成一条 ADR。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：`<产出目录>/behavior-spec.md` + `system-map.md` + `capabilities.md` + 源项目
- 输出（均写入 `<产出目录>/`）：
  - `design.md` — 架构方案（人读）
  - `decisions.md` — ADR 集（评审与追溯用）
  - `plan.json` — 增量计划（机器可读，驱动后续全部步骤）

## 参考资料（先读再设计）

- **[references/domain-playbooks.md](references/domain-playbooks.md)** — 按 system-map 判定的领域读对应 playbook：推荐技术栈、架构形态、领域坑
- **[references/paradigm-map.md](references/paradigm-map.md)** — 源语言范式 → Rust 惯用法映射；设计模块结构和处理"这个动态特性怎么办"时查

## Grill 协议：设计树逐分支拷问

对下面每个分支：**提出问题 → 列出 2-3 个真实可选项 → 查证据 → 下结论 → 记 ADR**。一个分支的结论会约束后续分支（先定形态再定架构，先定架构再选 crate），按序走。

```
设计树：
1. 目标形态     — bin / lib / workspace？CLI 还是守护进程？保持原接口还是借机调整？
2. 总体架构     — 分层？六边形？ECS？流水线？模块如何划分？（不必沿用源系统的划分）
3. 子系统选型   — 对 system-map 依赖清单中每个架构级依赖：Rust 生态用什么替代？
                  （web 框架、游戏引擎、GUI 框架、序列化、数据库、异步运行时……）
4. 范式落差处理 — 源系统重度使用的动态特性/继承/GC 模式，映射方案是什么？（查 paradigm-map）
5. 迁移顺序     — 增量如何切分？walking-skeleton 包含什么？哪些能力先做（高风险先行）？
6. 测试策略     — golden harness 怎么搭？differential 是否可行？checklist 项何时人工核对？
7. 性能与资源   — 契约中有性能要求吗？并发模型选什么？
8. unsafe 政策  — 预算多少（默认 <10%）？哪些位置预期需要 unsafe（FFI/SIMD）？
9. 范围取舍     — 有没有行为该故意不保留？（废弃功能、原系统 bug、平台特定行为）
                  → 每一条进 parity_exceptions，必须有 ADR
```

每个分支的拷问标准：如果一个评审人问"为什么不用 X？"、"这个选择在什么情况下会被证明是错的？"，你的 ADR 里要已经有答案。回答不了就去查——读源码、查 crate 文档、跑个小实验。

## 产出格式

### decisions.md — ADR 集

```markdown
## ADR-3: 渲染子系统用 macroquad 而非 bevy
- **问题**：原游戏用 canvas 2d 即时渲染，约 30 个 draw call/帧，无复杂场景图。Rust 侧渲染栈选什么？
- **选项**：bevy（全家桶 ECS）/ macroquad（轻量即时模式）/ 手写 wgpu
- **证据**：源码 src/render.ts 仅 400 行、纯 2d 图元；契约 cap-render 是 checklist 项无精确像素要求；bevy 引入 ECS 会迫使全部游戏逻辑重构进 ECS 范式，与"模拟核心已按纯函数设计"（ADR-2）冲突
- **选择**：macroquad
- **推翻条件**：若后续发现需要复杂场景图/骨骼动画/shader 管线，升级到 bevy 并重评 ADR-2
```

关键分支（形态、架构、每个子系统、迁移顺序、测试策略、unsafe 政策）每个至少一条 ADR。理由必须引用证据，"业界流行"不是理由。

### design.md — 架构方案

模块划分与职责、数据流、核心类型与 trait 草图（签名级即可）、错误处理策略、与契约的映射（每个模块承载哪些能力）。覆盖全部能力，同时警惕过度设计：契约不要求的扩展点、抽象层，一个都不加。

### plan.json — 增量计划

```json
{
  "source": {
    "dir": "/abs/source", "languages": ["typescript"], "domain": "game",
    "build_cmd": "npm run build", "test_cmd": "npm test", "run_cmd": "npm start", "runnable": true
  },
  "target": {
    "output_name": "<project>_rust",
    "output_dir": "<工作区内绝对路径>/<project>_rust",
    "crate_kind": "bin",
    "rust_edition": "2021",
    "smoke_cmd": "cargo run --release -- --version",
    "unsafe_budget_pct": 10
  },
  "stack": [
    { "subsystem": "rendering", "source_tech": "canvas 2d", "rust_choice": "macroquad", "adr": "ADR-3" },
    { "subsystem": "serialization", "source_tech": "JSON.stringify", "rust_choice": "serde + serde_json", "adr": "ADR-4" }
  ],
  "capabilities": [
    { "id": "cap-save-load", "increment": "inc-2", "oracle": "golden", "status": "pending" }
  ],
  "increments": [
    {
      "id": "inc-1", "name": "walking-skeleton", "phase": "core",
      "capabilities": ["cap-startup", "cap-config"],
      "exit_criteria": "smoke_cmd 端到端可运行；inc-1 能力测试全绿"
    },
    {
      "id": "inc-2", "name": "core-domain", "phase": "core",
      "capabilities": ["cap-game-state", "cap-save-load"],
      "exit_criteria": "核心域测试全绿，含 golden 全过"
    }
  ],
  "parity_exceptions": [
    { "behavior": "原系统崩溃于超长玩家名（已知 bug）", "replacement": "返回 ValidationError", "adr": "ADR-9" }
  ]
}
```

字段约束：
- 每个能力恰好属于一个 increment；`increments[0]` 必须是 walking-skeleton——**先让系统端到端跑起来**（哪怕只有启动+一个最小能力），骨架通了才知道选型能不能落地
- phase ∈ {core, full}：core = walking-skeleton + 核心域（系统的存在理由），full = 其余
- 增量排序原则：高风险/高不确定选型早验证（渲染栈、异步运行时这类"选错要翻工"的放前面）；依赖别人的能力排后
- `parity_exceptions` 是全工作流唯一允许行为偏离的白名单，spec 步骤标注的"原系统 bug"候选在这里裁决
- `smoke_cmd` 与领域匹配：服务类用"启动+健康检查+关停"，游戏/GUI 类允许 `--version` 级（真运行留给 checklist）
- 所有路径绝对路径；output_dir 在工作区内

## 完成标准

- decisions.md 覆盖设计树全部关键分支，每条 ADR 有证据引用和推翻条件
- design.md 覆盖全部能力、无契约不要求的抽象
- plan.json 合法且满足上述字段约束
- 三个文件写入 `<产出目录>/`

（本步骤是手动步骤：CHECK 通过后工作流会暂停，供用户审查选型与架构后再继续。）
