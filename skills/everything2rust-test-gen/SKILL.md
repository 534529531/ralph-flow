---
name: everything2rust-test-gen
description: 创建 everything2rust 迁移的 TDD 红阶段基线：按 plan.json 建 Rust 项目骨架，把行为契约变成验收测试（golden harness + 移植测试 + 属性测试），全部实现用 todo!() 占位。在 everything2rust 工作流的 baseline 步骤触发。
---

严格 RED 阶段。设计已定（plan.json + design.md），行为契约和 golden 语料已就位（behavior-spec.md + golden/）。你的任务：把契约物化成**会失败的测试**，让后续 implement 步骤有明确的转绿目标。

测试是契约的可执行形式——它们的忠实度决定整个重构的质量上限。断言弱化（把"输出精确等于语料"降级为"不 panic"）等于偷偷撕掉契约的一页，是本步骤最严重的失败模式。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：`<产出目录>/plan.json` + `behavior-spec.md` + `golden/` + 源项目测试套件
- 输出：
  - plan.json `target.output_dir` 下的 Cargo 项目：骨架 + 全桩 + tests/
  - `<产出目录>/test-map.json` — 能力 id → 测试名列表
- 目标状态：`cargo build` 通过；`cargo test` 因 `todo!()` panic 而 FAILED（不是编译错误）

## 执行流程

### 1. 项目骨架

按 plan.json target 与 design.md 建项目：crate 形态（bin/lib/workspace）、模块结构、核心类型与错误枚举（**完整定义，非桩**——类型是测试能编译的前提）、Cargo.toml 依赖 = stack 选型 + dev-deps（proptest、rstest，按需 insta/assert_cmd/wiremock）。

### 2. 实现桩

design.md 草图中的每个公开函数/方法建桩：签名完整，函数体 `todo!("module::fn")`。桩的签名要经得起测试调用——写测试时发现签名不合理，直接改签名并同步 design.md（这是设计验证，不是失败）。

### 3. 验收测试（每能力至少 1 个，按预言策略写）

harness 代码模式见 **[references/harness-patterns.md](references/harness-patterns.md)**，动手前按策略读对应小节。

- **golden**：写数据驱动 harness，读 `golden/<cap-id>/` 的 cases 逐个断言。语料从 meta.json 声明的路径加载（复制进 `tests/golden/` 并保留 meta.json 亦可），**禁止把期望值硬编码进测试代码**——语料文件是判据的单一来源
- **ported-tests**：逐个移植原测试，断言语义精确保留，不合并不降级。原测试名可追溯（注释标注源文件）
- **property**：契约的不变量 → proptest（round-trip、幂等、守恒、单调性）
- **differential**：可行时写 `#[ignore]` 标注的差分测试（运行时调原系统比对），并确保其不阻塞 `cargo test` 默认运行——它们是 audit/verify 的加验手段
- **checklist**：不写自动测试；在 test-map.json 中标注 `"checklist"`，把 behavior-spec 的清单项复制到 `tests/CHECKLIST.md` 供 audit/verify 逐条核对

归一化规则（behavior-spec 中定义的时间戳剥离、排序、浮点容差）实现为 harness 的 `normalize` 函数，测试比对一律走它。

### 4. test-map.json

```json
{
  "cap-save-load": { "tests": ["golden_save_load", "prop_save_load_roundtrip"], "kind": "auto" },
  "cap-render": { "tests": [], "kind": "checklist", "checklist": "tests/CHECKLIST.md#cap-render" }
}
```

每个 plan.json 能力都要出现；kind=auto 的能力 tests 非空。这份映射是后续 impl/audit/verify 判断"哪个能力算完成"的索引。

### 5. 红状态验证

```bash
cargo build          # 必须 Finished——编译错误说明骨架/桩/测试有问题，修到能编
cargo test 2>&1 | tail -20   # 必须 FAILED，失败原因是 todo!() panic
```

逐项确认：FAILED 数量 ≈ 测试总数（个别纯类型测试可能已过）；没有因语料路径错误而失败的测试（那是 harness bug，不是合法的红）。

## 完成标准

- Cargo 项目形态/依赖与 plan.json 一致，模块结构与 design.md 一致
- 每个能力在 test-map.json 有映射；auto 能力有 ≥1 个真实测试
- golden 测试从语料文件加载判据，断言忠实于 behavior-spec（未弱化）
- checklist 能力的清单落在 tests/CHECKLIST.md
- cargo build 通过；cargo test 因 todo!() 而 FAILED
