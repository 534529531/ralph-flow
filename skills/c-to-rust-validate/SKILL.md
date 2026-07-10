---
name: c-to-rust-validate
description: 独立 QA 视角对 C→Rust 翻译做最终验收。逐 gate 取证，产出 report.md。在 c-to-rust 工作流的 verify 步骤触发。
---

以独立 QA 视角验收完成的 Rust 翻译。不信任实现过程，从头验证一切。每个 conclusion 必须有具体命令证据；发现问题立即修复。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：Rust 项目路径（output_dir）、`plan.json`、C 项目路径（source_c_dir）、function-contracts.md（如有）
- 输出：`<产出目录>/report.md`（逐条验收标准附证据）

## 执行流程

逐条验证以下标准，每条都跑实际命令、收集证据。不达标立即修复，不要等到 CHECK 来发现问题。

### 1. 可执行文件

```bash
cd <output_dir>
cargo clean && cargo build --release    # "Finished"，无 error
cargo run --release -- --help           # 不 panic 正常启动
```

### 2. 测试框架

检查所有测试使用 Rust 主流测试框架（#[test]、rstest、proptest 等），不依赖外部 C 测试框架或脚本。

```bash
grep -rn '#\[test\]' tests/           # 确认 Rust 测试注解
grep -rn 'proptest\|rstest' tests/    # 确认属性测试框架
```

### 3. 源码全量翻译

```bash
cd <output_dir>
grep -rn 'todo!\|unimplemented!()' src/ tests/ | grep -v '//'  # 无输出
grep -rn 'dbg!' src/ | grep -v '//'                             # 无输出
grep -rn '#\[ignore\]' tests/ src/                               # 无输出
```

手动抽查 src/ 下的函数体，确认没有空函数体或仅返回默认值的占位实现。

### 4. 编译与测试通过

```bash
cd <output_dir>
cargo test --all                 # 全 ok，无 FAILED，无 #[ignore]
cargo clippy -- -D warnings      # 零 warning
```

### 5. Unsafe 审计

```bash
cd <output_dir>
cargo geiger 2>&1 | tee /tmp/geiger.txt
# 取本项目 crate 行 Expressions used/total，要求 < 10%
```

- 每处 `unsafe {` 前一行有 `// SAFETY:` 注释
- 无巨型 unsafe 块（单块 > 50 行）

### 6. 业务逻辑验证

这是最核心的标准。对照 plan.json 每个模块的 public_functions 和 internal_functions，逐函数验证：

- C 原实现与 Rust 实现的语义等价性
- 错误路径是否完整保留
- 状态转换是否完整
- 资源管理是否正确

### 7. 单元测试覆盖

不只看行覆盖率数字，还要检查测试质量：

```bash
cd <output_dir>
cargo llvm-cov --summary-only 2>&1
```

- 每个模块的核心函数有针对性测试（不是间接调用到就算）
- happy path 和 error path 都有覆盖
- 边界条件有测试
- 有 property-based 测试覆盖数据变换

## 生成 report.md

写入 `<产出目录>/report.md`：

```markdown
# C→Rust 翻译验收报告

## 总体结论：[PASS / FAIL]

## 关键指标
- 项目：<output_name>_rust
- Unsafe：cargo geiger Expressions used/total = X/Y ≈ Z%（目标 <10%）
- 测试：N 通过（oracle N1 + prop N2 + golden N3）
- 代码规模：C Nc 行 → Rust Nr 行
- C 函数覆盖：已实现 M / 总计 T

## 验收标准逐条结果
### 1. 可执行文件 — [PASS/FAIL]
### 2. 测试框架 — [PASS/FAIL]
### 3. 源码全量翻译 — [PASS/FAIL]
### 4. 编译与测试通过 — [PASS/FAIL]
### 5. Unsafe 审计 — [PASS/FAIL]
### 6. 业务逻辑验证 — [PASS/FAIL]
### 7. 单元测试覆盖 — [PASS/FAIL]

## 保留 Unsafe 的理由（摘录每处 // SAFETY:）
## 遗留问题及修复建议
```

## 完成标准

- 7 条验收标准全部通过
- report.md 生成，每条附实际命令输出证据
