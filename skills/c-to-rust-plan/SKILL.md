---
name: c-to-rust-plan
description: 分析 C 项目，探测真实布局/测试框架/构建系统，提取 API，划分依赖分层，产出 plan.json、api-inventory.md 和 function-contracts.md。在 c-to-rust 工作流的 analyze 步骤触发。
---

你是接手一个陌生 C 代码库的工程师。目标：先**探测**项目的真实形态（不要假设目录结构），再产出机器可读的实现计划（plan.json）、人类可读的 API 参考（api-inventory.md）和语义参考（function-contracts.md）。这份计划驱动后续全部步骤：测试基线、TDD 实现顺序、独立审查、最终验收。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：C 项目路径（source_c_dir）、输出项目名（默认 = 源码目录名 + `_rust`）
- 输出：
  - `<产出目录>/plan.json` — 探测结果 + 模块/分层/API/难度/crate
  - `<产出目录>/api-inventory.md` — 人类可读：每个 C 公开函数 → 拟议 Rust 签名
  - `<产出目录>/function-contracts.md` — 复杂函数的语义要点，给后续 audit 步骤用

## 核心原则

- **先探测再假设** — 目录布局、测试框架、构建系统都从项目实际情况探测，不硬编码 `src/`、`inc/`、`test_`
- **头文件是公开 API 的权威来源**；**源文件是内部(static)函数的权威来源**
- **按内聚性分组** — 共享类型/数据结构的函数归入同一 Rust 模块
- **简单模块优先** — 无依赖的纯数据变换放 layer 1，先积累惯性
- **传递闭包** — 递归解析 #include 链构建依赖图
- **优先标准库** — 能用 std 就不引外部 crate

## 执行流程

所有探测/提取的精确命令见 **[references/detection-commands.md](references/detection-commands.md)**。下面只讲每步要产出什么。

### 1. 探测项目布局（不要假设）

用 find 列出真实的源/头/测试文件位置，归纳出源码目录、头文件目录、测试目录（可能是 `src/`+`include/`、`lib/`、扁平根目录等任意组合），写入 `project_layout`。测试文件特征：在 `test/`、`tests/`、`t/` 目录或文件名含 `test`/`spec`/`check`。

### 2. 探测测试框架（决定 baseline 如何移植测试）

grep 框架特征识别 Unity / CMocka / Check / CuTest / 自定义 main / 朴素 `test_` 约定，写入 plan.json `test_framework`：
`{ "name": "unity|cmocka|check|cutest|custom|plain", "test_files": [...], "assert_macros": [...], "test_decl_pattern": "...", "runner_entry": "..." }`。

### 3. 探测构建系统（决定如何编译 C 测试）

识别 Makefile / CMake / meson 等，写入 plan.json `build_system`：`{ "type", "build_cmd", "test_cmd", "test_binary", "include_flags", "cc" }`。无构建系统则给出手动编译命令（含正确的 `-I<headerdir>`）。

### 4. 提取公开 API（从头文件）

ctags 主方案 + grep 兜底，对探测到的头文件目录提取每个公开函数：名称、返回类型、参数、错误约定（返回码 / errno / 出参）。额外识别回调签名（函数指针类型）和条件编译块（`#ifdef`/`#if`，记录宏名）。

### 5. 提取内部函数 + 检测高级特性

grep 提取 static 内部函数；检测内联汇编（→ difficulty=global，记入 inline_asm_modules）与 C11/C17 高级特性（_Generic/_Atomic/_Alignas/restrict/setjmp/longjmp/alloca/VLA/volatile/signal）。结果记入每个模块的 `c_advanced_features`（见第 8 步 schema）。

### 6. 构建模块依赖图

按 .c 的 `#include` 关系建有向图：A.c include B.h ⇒ A 直接依赖 B；取传递闭包。
叶子模块（无人 include 其头）→ layer 1；只依赖 layer 1 → layer 2；以此类推。无环。

### 7. 难度分级 + crate 推荐

| 难度 | C 特征 | 实现顺序 |
|------|--------|---------|
| **trivial** | 纯数据变换，无堆分配无状态 | 最先 |
| **owned** | malloc/free 对，单一所有者 → Box/Vec/Drop | 早期 |
| **stateful** | init/deinit + 内部状态 → struct+Drop | 中期 |
| **callback** | 函数指针控制反转 → FnMut/trait 对象 | 后期 |
| **global** | static 可变 / 内联汇编 → OnceLock/Mutex 或重构 | 最后 |

crate 仅在 C 源码存在对应模式时引入，优先 std：位域→`bitflags`；字节转换→`bytemuck`；小数组/VLA→`smallvec`；解析器→`winnow` 或手写；FFI 边界→`libc`（仅 FFI 用）。

### 8. 写出 plan.json

```json
{
  "output_name": "<project>_rust",
  "output_dir": "<projectDir 下的绝对路径>/<project>_rust",
  "source_c_dir": "/abs/path/C-project",
  "c_test_dir": "/abs/path/探测到的测试目录",
  "project_layout": {
    "source_dirs": ["src"], "header_dirs": ["include"], "test_dirs": ["tests"]
  },
  "test_framework": {
    "name": "unity", "test_files": ["tests/test_codec.c"],
    "assert_macros": ["TEST_ASSERT_EQUAL", "TEST_ASSERT_TRUE"],
    "test_decl_pattern": "void test_<name>(void)", "runner_entry": "RUN_TEST"
  },
  "build_system": {
    "type": "make", "build_cmd": "make clean && make", "test_cmd": "./test_runner",
    "test_binary": "./test_runner", "include_flags": "-Iinclude", "cc": "gcc"
  },
  "layers": [["codec"], ["storage", "network"], ["api"]],
  "modules": [
    {
      "name": "codec", "c_files": ["src/codec.c"], "c_headers": ["include/codec.h"],
      "target_file": "src/codec.rs", "layer": 1,
      "depends_on": [], "transitive_depends_on": [],
      "difficulty": "trivial",
      "public_functions": ["encode", "decode", "checksum"],
      "internal_functions": ["validate_header", "calc_padding"],
      "types": ["codec_ctx_t"],
      "error_codes": ["CODEC_ERR_INVALID", "CODEC_ERR_OVERFLOW"],
      "recommended_crates": [],
      "c_advanced_features": {
        "has_generic": false, "has_atomic": false, "has_alignas": false,
        "has_restrict": false, "has_setjmp": false, "has_alloca": false,
        "has_vla": false, "has_volatile": false, "has_signal": false
      },
      "notes": ""
    }
  ],
  "api_inventory": [
    {
      "c_name": "codec_encode", "rust_name": "encode",
      "c_signature": "int codec_encode(const uint8_t* in, size_t in_len, uint8_t* out, size_t* out_len)",
      "rust_signature": "fn encode(input: &[u8], output: &mut [u8]) -> Result<usize, CodecError>",
      "module": "codec", "error_variants": ["CodecInvalid", "CodecOverflow"],
      "condition": null, "notes": "in_len/out_len 由切片长度替代"
    }
  ],
  "conditional_compilation": {
    "detected_macros": ["_WIN32", "__linux__", "USE_SSL"],
    "feature_flags": { "use_ssl": { "c_macro": "USE_SSL", "rust_cfg": "feature = \"ssl\"" } }
  },
  "inline_asm_modules": [],
  "completed_modules": []
}
```

字段约束：
- 所有路径绝对路径；`output_dir` 必须在工作区（projectDir）下，确保后续步骤可访问
- `layers`：数组的数组，下标 0 = layer 1（无依赖），每个模块名恰好出现在一层
- `depends_on` 只引用更低层（无环）；`transitive_depends_on` 是传递闭包
- `difficulty` ∈ {trivial, owned, stateful, callback, global}
- `internal_functions`：该模块全部 static 函数名（可空）
- `c_advanced_features`：全部字段初始化为布尔
- `project_layout`、`test_framework`、`build_system` 必须反映**探测结果**，非默认值
- `completed_modules` 初始化为空数组
- modules 覆盖每个非测试、非 vendor/third_party 的 .c

### 9. 写出 api-inventory.md

人类可读表格：公开 API 表（C 签名 → Rust 签名 → 错误变体）、内部函数表、推荐 crate 表、依赖分层表。

### 10. 写出 function-contracts.md

对 difficulty 为 **stateful**、**callback**、**global** 的模块中**最有翻译风险的函数**，记录其语义要点。不必逐函数全部记录——关注那些逻辑复杂、有多阶段操作、有非平凡状态转换、或有容易遗漏的错误路径的函数。

对每个记录的函数，包含：
- **做什么**（一句话）
- **核心逻辑**（自然的语言描述，不是伪代码）
- **关键不变性**（该函数保证的、调用方依赖的）
- **错误/异常分支**（不只是 happy path）
- **与其他函数的协作**（谁调用它、它调用谁、共享什么状态）

trivial 和 owned 难度的模块通常不需要逐函数记录，模块级概述即可。

这个文件是给后续 audit 步骤用的——让审计师知道 "这个函数应该做什么"，然后去 Rust 实现中验证它确实做了这些。

## 完成标准

- plan.json 合法 JSON，modules 覆盖所有非测试/非 vendor 的 .c
- 每模块含 public_functions、internal_functions、difficulty、recommended_crates、transitive_depends_on、c_advanced_features
- plan.json 含 output_name、output_dir(工作区内绝对路径)、source_c_dir、c_test_dir、project_layout、test_framework、build_system、conditional_compilation、inline_asm_modules、completed_modules
- project_layout/test_framework/build_system 来自真实探测
- 依赖分层无环，传递闭包正确
- api-inventory.md 列出所有 C 公开函数及拟议 Rust 签名
- function-contracts.md 对复杂函数记录了语义要点
- 三个文件写入 `<产出目录>/`
