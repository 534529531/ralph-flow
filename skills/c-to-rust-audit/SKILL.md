---
name: c-to-rust-audit
description: 独立审计 C→Rust 翻译质量。逐模块逐函数对照 plan.json 和 C 源码，验证完整性与语义等价。发现遗漏或偏差立即修复。在 c-to-rust 工作流的 audit-core 和 audit-full 步骤触发。
---

你是审计师，不是实现者。你的任务是审查已有翻译的质量，而不是从头实现。对照 plan.json 和 C 原实现，逐模块逐函数验证 Rust 实现的完整性和正确性。发现遗漏或偏差，立即修复。

## 输入 / 输出

- 输入：plan.json、Rust 项目、C 源码、function-contracts.md（如有）
- 输出：所有审计范围内的函数确认完整且语义等价；发现的问题已修复

## 范围

- **audit-core**：`difficulty` ∈ {trivial, owned} 的模块
- **audit-full**：全部模块（重点在 stateful/callback/global）

## 审查方法

对范围内的每个模块，逐函数审查：

### 第一步：完整性检查

对照 plan.json 中该模块的 `public_functions` 和 `internal_functions`，在 Rust 源码中找到每个函数的实现。

- 函数存在且非桩？→ 继续
- 函数缺失？→ 实现它
- 函数是空函数体或仅返回默认值？→ 读 C 原实现，补全它

### 第二步：语义等价检查

对每个已存在的函数，对照 C 原实现验证语义等价性：

- 读 C 源码，理解该函数做什么
- 读 Rust 实现，判断是否产生相同行为
- 关注：
  - 错误路径：C 的每个错误分支在 Rust 中是否有对应处理
  - 边界条件：C 的 NULL/0/MAX 检查是否被保留
  - 状态转换：C 中的状态机是否完整
  - 副作用：C 中对全局状态、文件、内存的修改是否等效
  - 返回值：C 的返回码/出参语义是否被正确映射

### 第三步：专项审查（audit-full 重点）

对 stateful/callback/global 模块，额外关注：

- **资源管理**：C 中有 init/alloc/open，对应的 deinit/free/close 在 Rust 中是否正确（Drop 还是显式方法）
- **多阶段操作**：C 中通过中间状态标记实现的操作序列，Rust 是否保留了全部阶段
- **异常恢复**：C 中有从异常状态恢复的逻辑，Rust 是否保留
- **控制反转**：C 中通过函数指针实现的回调，Rust 是否正确建模
- **二进制布局**：C 结构体的 repr 在 Rust 中是否一致（尤其注意 struct padding 和 enum 大小）
- **活代码**：Rust 中定义但从未被调用的函数/结构体/缓存——可能是 C 中使用了但 Rust 遗漏了调用方

### 第四步：修复

发现遗漏或偏差，立即修复——不要只标注问题留给后续步骤。

- 缺失函数：读 C 原实现，补全 Rust 版本
- 语义偏差：重写 Rust 实现，匹配 C 语义
- 死代码：补全调用方，或删除无用的定义

## 完成标准

- 审计范围内的每个模块：所有 public_functions + internal_functions 均已实现且语义等价
- cargo build 通过
- cargo test 通过（修复可能引入的测试失败）
- 任何确实无法修复的问题，在 plan.json 对应模块的 notes 中记录原因
