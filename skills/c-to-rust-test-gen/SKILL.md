---
name: c-to-rust-test-gen
description: 创建 C-to-Rust 迁移的 TDD 红阶段基线：Rust binary 骨架、API 桩、按 C 测试框架移植全部测试、属性测试。在 c-to-rust 工作流的 baseline 步骤触发。
---

你在搭 TDD 的红阶段。产出一个 Rust 项目：每个 C 测试都有对应的 Rust `#[test]`，所有 API 桩编译通过，测试因 `todo!()` 而运行时失败。这个基线是**契约**——实现正确时测试自动转绿。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：`plan.json`（含 project_layout、test_framework、build_system）、C 源码与测试
- 输出：
  - `<output_name>_rust/` — Cargo binary 项目：`src/main.rs`、`src/lib.rs`、`src/types.rs`（完整定义）、
    `src/error.rs`、`src/<module>.rs`（桩）、`tests/oracle_*.rs`、`tests/prop_*.rs`
  - 状态：`cargo build` 通过，`cargo test` 有 FAILED（红阶段，todo!() panic）

## 核心原则（superpower TDD）

- **先看 C 测试变绿** — 移植前用 build_system 跑通 C 测试套件；红阶段的"红"必须来自我们的 Rust 桩，不是来自坏掉的 C 基线
- **100% 测试覆盖移植** — 每个 C 测试用例 → 一个 Rust `#[test]`，断言含义逐一保留
- **API 签名在此确定** — 桩签名是给实现阶段的契约。若实现中发现签名确需调整，那是正常工程演进，直接改签名并同步更新依赖它的测试与 plan.json（不必推倒重来）
- **错误路径必须测** — 每个 Err 变体都有触发场景
- **属性测试兜底** — 对数据变换函数用 roundtrip/确定性/空输入不崩溃做 proptest；对有状态 API 用操作序列状态机保证不 panic

## 执行流程

复制此清单并随进度勾选：

```
RED 基线进度：
- [ ] 1. C 测试套件确认全绿
- [ ] 2. cargo new binary 项目，Cargo.toml 配好依赖
- [ ] 3. types.rs / error.rs 完整定义；lib.rs 声明全部模块
- [ ] 4. 每个公开函数 + internal_function 建 todo!("module::fn") 桩
- [ ] 5. 按框架移植全部 C 测试 → oracle_*.rs（断言精度保留）
- [ ] 6. 补属性测试 prop_*.rs
- [ ] 7. 验证红阶段：cargo build 通过、cargo test FAILED、桩数≥函数数
```

### 1. 确认 C 测试套件全绿

用 plan.json `build_system` 的命令编译并运行 C 测试：

```bash
cd <source_c_dir>
<build_cmd> && <test_cmd>; echo "exit=$?"
```

退出码必须为 0。若不通过：先修 C 项目，或在 plan.json 标注排除的损坏测试（记 notes）。

### 2. 初始化 Rust binary 项目

```bash
cargo new <output_name>_rust            # 在工作区内，cargo 会自动 git init
cd <output_name>_rust
```

`Cargo.toml`：
```toml
[package]
name = "<output_name>_rust"
edition = "2021"

[dependencies]
thiserror = "1"
# 仅在 plan.json recommended_crates 出现时才加（bitflags/bytemuck/smallvec/...）

[dev-dependencies]
proptest = "1"
rstest = "0.18"
```

`src/main.rs`：薄入口，解析 `--help` 与子命令，转调 lib。
`src/lib.rs`：`pub mod` 声明 plan.json 的全部模块。

### 3. 定义共享类型与错误（完整，非桩）

- `src/types.rs`：把头文件中跨模块共享的 struct/enum 翻译成完整 Rust 定义。模块私有类型放各自模块文件。
- `src/error.rs`：从 plan.json `api_inventory[].error_variants` 汇总，thiserror 派生：

```rust
use thiserror::Error;
#[derive(Error, Debug, PartialEq)]
pub enum AppError {
    #[error("codec: invalid input")] CodecInvalid,
    #[error("codec: output buffer overflow")] CodecOverflow,
    // 每个 C 错误码一个变体
}
```

### 4. 创建 API 桩

每个模块 `src/<module>.rs`：用 plan.json `api_inventory[].rust_signature` 写正确签名，函数体 = `todo!("<module>::<fn>")`。internal_functions 同样建桩。桩签名是契约。

### 5. 按测试框架移植 C 测试

读 plan.json `test_framework`，把每个 C 测试用例映射成 `tests/oracle_<module>.rs` 里的 `#[test]`。
各框架的用例声明、断言宏，以及"断言语义精确归一表"（精度不降级）见
**[references/test-porting.md](references/test-porting.md)**。
错误路径：对每个 error_variant，确认至少一个测试触发它。

### 6. 属性测试

`tests/prop_<module>.rs`：数据变换函数 → roundtrip / 确定性 / 空输入不崩溃；有状态 API → 操作序列状态机 proptest（保证不 panic）。
模板与模式见 **[references/proptest-patterns.md](references/proptest-patterns.md)**。

### 7. 验证红阶段状态

```bash
cargo build      # 必须通过——所有桩编译
cargo test 2>&1  # 必须出现 FAILED——红阶段（todo!() panic，不是编译错误）

# 红阶段完整性：桩数 ≥ 函数数
TODO_COUNT=$(grep -rc 'todo!' src/ --include='*.rs' | awk -F: '{s+=$2} END{print s}')
FUNC_COUNT=$(jq '[.api_inventory|length] + [.modules[].internal_functions|length] | add' <产出目录>/plan.json)
echo "stubs=$TODO_COUNT funcs=$FUNC_COUNT"   # 需 TODO_COUNT >= FUNC_COUNT
```

若 `cargo test` 全绿，说明桩写错了（应有 `todo!()`）。每个 `todo!()` 必须含 `"module::fn"` 标签便于实现阶段定位。

## 完成标准

- `cargo build` 通过；`cargo test` 有 FAILED（todo!() panic，非编译错误）
- Cargo.toml 是 binary target，含 thiserror + proptest/rstest
- `src/main.rs`、`src/lib.rs`（声明全部模块）、`src/types.rs`（字段完整）、`src/error.rs` 存在
- 每个 C 测试用例都有对应 Rust `#[test]`，断言精度保留
- `TODO_COUNT >= FUNC_COUNT`，每个 `todo!()` 含 `module::fn` 标签
- 每个公开函数至少被一个 oracle 或 property 测试覆盖；每个 error_variant 至少有一个触发测试
- 每个模块有对应的 `tests/oracle_<module>.rs` 和 `tests/prop_<module>.rs`
