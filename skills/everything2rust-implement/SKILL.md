---
name: everything2rust-implement
description: 按 plan.json 增量填充 Rust 桩，以行为契约为规格做 TDD 转绿。工程师式自治：编译器/测试报错即自愈信号，用 systematic-debugging 定位根因后修复，迭代到绿。在 everything2rust 工作流的 impl-core 和 impl-full 步骤触发。
---

桩和验收测试已就位（来自 baseline）。你是工程师：读原实现理解**行为语义**（不是抄结构），按 design.md 的架构写惯用安全 Rust，让当前范围的测试全部转绿。没有"试 N 次就放弃"——持续迭代直到全绿。不要主动放弃任何能力。

与逐函数翻译的根本区别：你的规格是 behavior-spec.md 的契约和它物化成的测试，不是源函数签名。源代码是**理解行为的资料**——读它搞懂"为什么这个边界返回空而不是报错"，然后用 design.md 定下的 Rust 架构自由地实现。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：当前范围的增量（plan.json increments）、Rust 桩与测试、源项目、behavior-spec.md、test-map.json
- 输出：范围内测试全绿，clippy 干净，unsafe < 预算且每处有 SAFETY 注释，每增量一个 commit

## 范围

- **impl-core**：plan.json 中 `phase: core` 的增量（walking-skeleton + 核心域）
- **impl-full**：其余 `phase: full` 的增量

## 核心规则

- **测试即契约** — 当前范围 test-map.json 映射的测试全绿 = 该能力完成。测试失败时修实现，不修断言；确信断言本身与 behavior-spec 冲突时，先对照语料和源系统行为取证，再改断言并在 commit message 说明
- **walking-skeleton 优先**（impl-core 第一件事）— 先让 smoke_cmd 端到端跑通，再填充功能。骨架期暴露的选型问题（crate API 与预期不符、架构走不通）要立即处理：小问题直接修，推翻 ADR 级别的问题更新 decisions.md 和 plan.json 后再继续
- **行为偏差只在白名单** — 实现中发现"Rust 里这样做更自然但行为会变"时，查 parity_exceptions：在白名单里就做，不在就保持原行为（想加白名单不是本步骤的职权）
- **git 是检查点** — 每增量达到 exit_criteria 后 commit（`e2r-core: <increment>` / `e2r-full: <increment>`），大增量分批（`e2r-full: <increment> batch n/m`）

## 实现顺序

### 增量间

严格按 plan.json increments 顺序——排序已经编码了"高风险选型先验证"和依赖关系。

### 增量内

类型与错误 → 构造/初始化 → 无依赖的纯逻辑 → 有状态逻辑 → IO/边界集成。每写完一块就 `cargo build`，早发现早修。

### 逐能力对照（强制）

每完成一个增量，对照清单：

```
增量 <id> 进度：
- [ ] 读源实现相关部分，理解每个能力的行为语义（含错误路径与边界）
- [ ] 按 design.md 架构实现（范式落差查 everything2rust-design/references/paradigm-map.md）
- [ ] 对照 test-map.json：本增量每个能力的测试全绿（golden 语料一个不剩）
- [ ] 确认实现非桩（不是空函数体、不是仅返回默认值/Ok(())）
- [ ] cargo build 通过；cargo clippy 本范围无 warning
- [ ] unsafe 在预算内且每处有 SAFETY 注释
- [ ] plan.json 中本增量能力 status 更新为 done
- [ ] git commit（e2r-core:/e2r-full: 前缀）
```

没有能力可以跳过——要么实现，要么在 plan.json 里显式记录卡点原因（并且不输出 done）。

### 崩溃恢复（步骤开始时）

```bash
jq -r '.capabilities[] | select(.status=="done") | .id' <产出目录>/plan.json
```

以 `cargo test` 实际结果为准：标记 done 但测试失败的能力，重置 status 重做。

## 自愈循环 = systematic-debugging（不是机械计数）

```
cargo build 2>&1 → 编译器告诉你哪错 → 修 → 重来，直到 Finished
cargo test 2>&1  → 失败 → 复现 → 对照 behavior-spec 与源实现定位语义偏差
                 → 改根因（不是改断言迁就）→ 重来，直到 ok
cargo clippy -- -D warnings → 修到干净
git commit
```

**同一个错误反复出现**（试了几次没动）时停止盲改，切根因分析：

1. **重读源实现** — 对行为语义的理解很可能有偏差；golden 失败时把语料的 input 喂给原系统亲眼看输出
2. **检查语料/归一化** — 偶发失败或平台相关失败，可能是归一化规则漏了易变字段（对照 oracle-strategies 的归一化节），修 harness 而不是实现——但要先证明是 harness 问题
3. **检查所有权/并发模型** — 源系统的隐式共享（GC/单线程事件循环）在 Rust 需要显式结构；借用冲突是重新设计数据归属的信号，不是加 `clone()`/`unsafe` 的信号
4. **检查选型假设** — crate API 与预期不符：读编译器建议 + docs.rs 确认当前 API，精准打补丁；必要时 Cargo.toml 固定兼容版本；架构级不符 → 更新 ADR

## Unsafe 规则

度量口径全工作流统一：**cargo geiger** 本 crate 行的 Expressions `used/total` < plan.json `target.unsafe_budget_pct`（默认 10%）。

- 默认零 unsafe——绝大多数源语言模式都有安全 Rust 等价物（查 paradigm-map）
- unsafe 仅用于：FFI、平台原语（mmap/ioctl/SIMD）、自引用结构（优先 `Pin`）
- 每个 `unsafe {` 前一行 `// SAFETY:` 说明维持的不变性；块尽量小（1-3 行）
- 禁止用 `unsafe fn` 包装安全代码刷低比例

## 完成标准（每增量）

- 本增量能力的全部测试通过（golden 全过）；实现非桩
- cargo build 通过；clippy 本范围无 warning；unsafe 在预算内
- plan.json status 已更新；有对应 commit

## 完成标准（impl-full 末，全项目）

- `cargo build --release` 通过；`cargo test --all` 全绿（无 FAILED、无 `#[ignore]` 逃逸——差分测试的 ignore 除外）
- `cargo clippy -- -D warnings` 无 error；无 `todo!()`/`unimplemented!()`/`dbg!()` 残留
- 全部能力 status=done；smoke_cmd 正常运行；geiger 在预算内
