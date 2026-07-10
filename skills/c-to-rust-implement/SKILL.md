---
name: c-to-rust-implement
description: 填充 Rust API 桩，逐模块把 C 翻译成惯用安全 Rust。工程师式自治：编译器/测试报错即自愈信号，用 systematic-debugging 定位根因后修复，迭代到绿。在 c-to-rust 工作流的 impl-core 和 impl-full 步骤触发。
---

桩和测试已就位（来自 baseline）。你是工程师：读原始 C 实现 → 理解语义 → 写出通过全部测试的惯用安全 Rust。没有"试 N 次就放弃"——持续迭代直到全部测试通过。不要主动放弃任何模块。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：当前范围的 C 源文件、Rust 桩、测试（baseline）、`plan.json`
- 输出：测试全绿，clippy 干净，unsafe 比例 < 10%（cargo geiger Expressions 口径）且每处有 SAFETY 注释，每模块一个 commit

## 范围

- **impl-core**：`difficulty` ∈ {trivial, owned}（通常 layer 1-2）
- **impl-full**：剩余 {stateful, callback, global}

## 核心规则

- **重写所有权，不是重写语法** — 用 Rust 所有权类型消除裸指针，而不是给 C 语法套 `unsafe`
- **测试即规格** — 全部测试（oracle + prop）通过 = 实现正确
- **签名可演进** — API 签名尽量稳定；确需调整时直接改，并同步更新调用方测试与 plan.json（这是正常工程，不是失败）
- **git 是检查点** — 每模块通过后 commit（`impl-core: <module>` / `impl-full: <module>`），让后续步骤可验证进度

## 实现顺序

### 模块顺序

1. 按 plan.json `layers` 自底向上：layer 1 最先。
2. 同层内被依赖最多的先实现。
3. **默认串行**（更可控）。仅当两个模块的 `depends_on` 与 `transitive_depends_on` **完全不相交**时，才可选 worktree 并行加速。

### 模块内顺序

错误类型 → 数据类型(derive 常用 trait) → 构造函数(C init) → 叶子函数(含 internal_functions) → 核心算法 → Drop(C deinit/free 的 RAII 替代)。每写完一个函数就 `cargo build`，早发现早修。

### 逐函数对照（强制）

每完成一个模块，对照 plan.json 验证：

```
模块 <name> 进度：
- [ ] 读 C 原实现，理解语义与所有权
- [ ] 写惯用安全 Rust（错误→类型→构造→叶子函数→核心→Drop）
- [ ] 对照 plan.json：public_functions 和 internal_functions 每个都有对应 Rust 实现
- [ ] 确认实现非桩（不是空函数体、不是仅返回默认值/Ok(())）
- [ ] cargo build 通过（编译器报错→定位根因→修，迭代到 Finished）
- [ ] 本模块 oracle + prop 测试全绿
- [ ] cargo clippy 本模块无 warning；unsafe<10% 且每处有 SAFETY
- [ ] git commit（impl-core:/impl-full:）+ plan.json completed_modules 更新
```

没有任何函数可以跳过——要么实现，要么在 plan.json 中显式记录原因。

### 大模块分批（impl-full 时重要）

若某模块函数数超过 20 个，分 2-3 批实现。每批：
1. 实现该批函数 → cargo build → cargo test → 修复
2. git commit（标注批次，如 `impl-full: <module> batch 1/3`）
3. 全部批次完成后做一次集成验证

分批原则：先基础设施（读写原语、状态编解码）、再核心算法、最后资源管理与异常恢复。

### 崩溃恢复（步骤开始时）

```bash
jq -r '.completed_modules[]' <产出目录>/plan.json   # 已完成的跳过
```

以 `cargo test` 实际结果为准：若某模块标记完成但测试失败，清掉它的 completed 标记重新实现。

### Worktree 并行（可选）

```
对每个可并行模块 M：EnterWorktree("impl-<M>") → 实现+测试+commit → ExitWorktree(keep)
全部完成后：git merge 各分支 → 解决 lib.rs/types.rs 冲突 → cargo build 验证集成 → 下一层
```

并行只是加速手段；拿不准就串行。

## 自愈循环 = systematic-debugging（不是机械计数）

Rust 编译器和测试是你最好的自愈工具。报错不是要数着次数放弃，而是**定位根因**：

```
cargo build 2>&1
  → 编译器精确告诉你哪错、怎么改 → 修 → 重来，直到 Finished
cargo test 2>&1
  → 失败 → 用 systematic-debugging：复现 → 对照 C 源码定位语义偏差 → 改根因（不是改断言迁就）→ 重来，直到 ok
cargo clippy -- -D warnings 2>&1
  → 修 warning，直到干净
git commit
```

**当同一个错误反复出现**（你试了几次都没动），停止盲改，切换到根因分析：
1. **重读 C 原实现** — 你对业务语义的理解很可能有偏差（测试失败时尤其如此）
2. **检查 C 是否本身有 UB/旧 bug** — Rust 更严格，会暴露 C 里隐藏的问题；记入模块 notes，Rust 沿用等价的防御性行为
3. **检查所有权/生命周期模型** — C 的隐式所有权约定在 Rust 可能需要 `Rc`/`Arc` 或重构数据结构，而不是硬塞 `unsafe`
4. **检查 plan.json 依赖图** — 类型冲突往往是漏标了隐式依赖（补 `transitive_depends_on`，按正确顺序重做该模块）

**库 API 变更导致的语法不兼容**（requirement：精准自愈）：当某 crate 版本的 API 与预期不符（编译器报"no method/field"、签名不匹配），读编译器建议 + `cargo doc`/源码确认新 API，按报错精准打补丁；必要时在 Cargo.toml 固定到兼容版本。这类修复走同一个"读报错→改→重编"循环。

常见 C→Rust 模式（详见 `references/c-to-rust-patterns.md`）：
- `malloc/free` → `Vec`/`Box` + Drop 自动释放
- `return -1`/`ERR_CODE` → `Err(AppError::...)`；出参 `int* err` → `Result<T, AppError>`
- `goto cleanup` → RAII
- 函数指针表 → `trait` + `Box<dyn Trait>`
- `static mut STATE` → `OnceLock<Mutex<T>>`
- `#ifdef` → `#[cfg(...)]` / feature flag
- 内联汇编 → 优先 `std::arch` 内联函数，否则 `asm!()` + unsafe（见 `references/inline-asm.md`）

## Unsafe 使用规则

### 度量标准（全工作流统一：cargo geiger 是唯一权威）

不要手写行计数脚本。unsafe 比例统一用 **cargo geiger** 度量（已由 setup-env 步骤安装好）。
口径 = geiger 输出中本项目 crate 行的 **Expressions** 列 `used/total`，要求 `used/total < 10%`：

```bash
cd <output_dir>
RATIO=$(cargo geiger 2>/dev/null | grep -m1 -F "$(basename "$PWD") " | grep -oE '[0-9]+/[0-9]+' | sed -n '2p')
U=${RATIO%/*}; T=${RATIO#*/}
awk -v u="$U" -v t="$T" 'BEGIN{ if(t==""||t+0==0){print "geiger 解析失败（确认 setup-env 已装 geiger）"; exit 2} r=u*100/t; printf "unsafe expr %d/%d = %.1f%% (target <10%%)\n",u,t,r; exit (r<10?0:1) }'
```

geiger 报告里 `unsafe fn` / `unsafe impl` / `unsafe trait` / `extern "C"` 声明计入 Functions/Impls/Traits 列，**不计入** Expressions 列——这正是我们想要的：度量真正的不安全代码量，而非声明标记。

### 规则

- **默认零 unsafe** — 设计所有权类型消除裸指针；多数 C 模式都有安全 Rust 等价物
- unsafe 仅用于：FFI 调用（plan.json 声明）、平台原语（mmap/ioctl/SIMD）、自引用结构（优先 `Pin`）
- 每个 `unsafe {` 前一行必须有 `// SAFETY:` 注释，说明维持了什么不变性、外围如何保证
- unsafe 块尽量小（1-3 行），禁止把整个函数体塞进大 `unsafe {}`
- **禁止用 `unsafe fn` 包装安全代码来刷低行数百分比**（unsafe fn 不计入行数但污染 API）

## 完成标准（每模块）

- `cargo build` 通过；本模块 oracle + prop 测试通过
- 对照 plan.json：本模块所有 public_functions + internal_functions 均已实现（非桩）
- `cargo clippy` 本模块无 warning
- unsafe 比例 < 10%（cargo geiger Expressions used/total），每处有 SAFETY 注释
- `git commit`（impl-core:/impl-full: 前缀）；plan.json completed_modules 已更新

## 完成标准（全项目，impl-full 末）

- `cargo build --release` 通过；`cargo test --all` 全绿（无 FAILED、无 `#[ignore]`）
- `cargo clippy -- -D warnings` 无 error
- 全局 unsafe < 10%（cargo geiger Expressions used/total），每处有 SAFETY；无 `todo!()`/`unimplemented!()`/`dbg!()` 残留
- 无 libc 依赖（FFI 边界模块除外）；每模块有 impl-core:/impl-full: commit
