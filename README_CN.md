<div align="center">

# ralph-flow

**[opencode](https://opencode.ai) 工作流自动化插件**

让 AI 真正遵循复杂工作流 —— 执行、验证、重试，直到完成。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-green.svg)](https://opencode.ai)

[English](README.md) · [中文](README_CN.md)

</div>

---

## 问题

你对 AI 说："实现用户认证，写测试，更新文档，确保所有测试通过。"

实际发生的是：
- AI 写了点代码就停了
- 测试从来没跑过
- 文档被遗忘
- 没有任何验证

**即使你让 AI 自己验证，也不行：**
- AI 既当运动员又当裁判 —— 对自己的工作降低标准
- 过度自信 —— 没实际检查就说"看起来没问题"
- 甩锅外部因素 —— "测试环境坏了"、"现有代码有问题"

**AI 不会遵循多步骤工作流。** 它丢上下文、跳步骤、从不真正验证自己的工作。

## 解决方案

ralph-flow 强制 AI 遵循结构化工作流，**每一步都有独立验证**。这不只是提示词工程 —— 而是一个状态机，不允许 AI 跳过步骤，也不允许没有证据就宣称"完成"。

每个步骤分两个阶段：

1. **DO（执行）** —— 工作会话执行步骤任务，最后一行输出 `<promise>done</promise>` 标记
2. **CHECK（验证）** —— 一个**独立验证会话**（只读 `ralph-check` agent，全新上下文，完全没看过 DO 阶段的对话）按步骤的检查依据重新验证工作成果

通过 → 下一步。失败 → 带着具体失败原因重试。失败太多次 → 暂停等人介入。

---

## 特性

- **多实例并行**：同一项目里每个 opencode 会话可各跑一个工作流实例，完全隔离（`.opencode/ralph-flow/instances/<id>/`）
- **独立验证**：CHECK 在独立会话中用只读 agent 执行 —— AI 永远不给自己的作业打分
- **手动审查门**：`manual_step` 里列出的步骤在 **DO 完成后、验证开始前**停下来等人审查；只有用户的 `/ralphflow-continue` 才算批准
- **带失败上下文的重试**：重试的 DO 提示词携带验证者给出的具体失败原因；`max_fail_count` 限制重试次数，超限暂停
- **子工作流**：步骤可以委托给另一个工作流（嵌套上限 5 层，doctor 检测循环引用）
- **产出目录**：每个实例有独立的交付物目录（`.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`），工作流结束后保留
- **会话接管**：工作流跑到一半 opencode 关了？新会话运行 `/ralphflow-continue` 即可接管中断的实例，从断点继续
- **Doctor 诊断**：`/ralphflow-doctor` 诊断所有工作流定义 —— 被静默丢弃的步骤、不可达步骤、坏的子工作流引用、循环、遮蔽、损坏的实例
- **创建向导**：`/ralphflow-create` 和你一起设计自定义工作流，写出 YAML 并验证到无警告
- **最终报告**：完成/取消的实例把执行报告归档到 `.opencode/ralph-flow/reports/`

---

## 安装

```bash
cd ~/.config/opencode/plugins
git clone https://github.com/yibener/ralph-flow.git
cd ralph-flow
npm install && npm run build
```

重启 opencode。插件会注册工具、斜杠命令、`ralph-check` agent，并在首次使用时把自带 skills 同步到项目里。

### 从 1.x 升级

拉取代码重新构建即可。2.0 首次启动时自动：
- 把 1.x 中断的工作流（`ralph-flow.local.md`）迁移到新的多实例布局 —— 用 `/ralphflow-continue` 接管
- 把 1.x setup 拷贝进 `.opencode/ralph-flow/workflows/` 的内置工作流副本改名为 `*.pre-2.0-backup`（内置工作流现在始终从插件目录解析，永不过期）

注意：工具名从 `ralphflow-start` 风格改为 `ralphflow_start`（斜杠命令不变，仍是 `/ralphflow-start`）。

---

## 快速开始

```
/ralphflow-start loop 帮我把这个模块的测试覆盖率提到 90%
```

然后让它跑。工作流会：
1. 把你的需求拆解成可验证的检查点清单（`checkpoints.md`）
2. 循环执行直到每个检查点通过
3. 每一步推进前都独立验证

用 `/ralphflow-status` 看进度，`/ralphflow-cancel` 取消。

## 斜杠命令

| 命令 | 作用 |
|---|---|
| `/ralphflow-start` | 启动工作流（缺工作流名或任务描述会先询问） |
| `/ralphflow-continue` | 批准手动审查 / 恢复暂停的工作流 / 接管中断的实例 |
| `/ralphflow-status` | 查看本会话的实例，或项目内全部实例 |
| `/ralphflow-list` | 列出可用工作流和活跃实例 |
| `/ralphflow-cancel` | 取消实例（先归档报告） |
| `/ralphflow-doctor` | 诊断所有工作流定义和实例状态 |
| `/ralphflow-create` | 交互式设计自定义工作流，验证到无警告 |

## 内置工作流

| 工作流 | 用途 |
|---|---|
| `loop` | 检查点驱动循环：先把需求拆成可验证的检查点清单，再循环执行直到全部通过 |
| `spec` | 规格驱动开发：需求 → 设计（手动审查门）→ 实现 → 验证 |
| `c-to-rust` | C 项目迁移到惯用安全 Rust：分析 → TDD 基线 → 核心实现 → 审计 → 全量实现 → 审计 → 验收 |
| `everything2rust` | 任意语言系统重写为 Rust：勘察 → 行为契约 + golden 语料 → 方案设计（ADR）→ TDD 基线 → 实现 → 审计 → 验收 |

`c-to-rust` 和 `everything2rust` 由 12 个自带 skill 驱动（自动同步到 `.opencode/skills/`），覆盖规划、测试生成、实现模式、审计和最终验收。

---

## 工作原理

```
/ralphflow-start
      │
      ▼
┌───────────┐   <promise>done</promise>   ┌──────────────────────┐
│  DO 阶段  │ ──────────────────────────▶ │ 手动步骤？            │
│ （你的     │                             │  是 → 📋 停下，等用户  │
│  会话）    │ ◀─── 带失败原因重试 ─────── │  审查                 │
└───────────┘                             └──────────┬───────────┘
      ▲                                              │ 用户 /ralphflow-continue
      │ 失败                                          ▼ （普通步骤自动进入）
      │                                   ┌──────────────────────┐
      └────────────────────────────────── │ CHECK 阶段            │
                             通过 ──────▶ │ 独立只读验证会话       │──▶ 下一步 / 完成
                                          └──────────────────────┘
```

- 会话空闲但没输出 done 标记时，驱动器会重新注入 DO 提示词保活（有上限 —— 连续 5 次无进展后停止驱动，交还给你）
- 验证失败不是盲目重试：DO 提示词携带验证者的失败原因和重试次数
- CHECK 自身的基础设施故障（API 错误、超时）**不**计入失败次数 —— 工作流在 check 阶段暂停，`/ralphflow-continue` 只重跑验证

架构与 Claude Code 姊妹插件的映射见 [SYNC.md](SYNC.md)，细节见 [docs/](docs/README_CN.md)。

## 自定义工作流

把 YAML 放到 `.opencode/ralph-flow/workflows/<name>.yaml`（同名会遮蔽内置工作流），或者更省事：运行 `/ralphflow-create` 让它和你一起设计并验证。

```yaml
description: 实现、测试并文档化一个功能

manual_step: [design]        # 人工审查门（DO 之后、CHECK 之前）

steps:
  - id: design
    desc: 设计功能
    do: |
      写一份设计文档，覆盖数据模型、API 形态和错误处理。
    check: |
      打开 design.md，核对是否覆盖数据模型、API 形态、错误处理。
    input: 用户需求
    output: "design.md"
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: 按设计实现
    do: |
      按设计实现，跑全量测试直到全绿。
    check: |
      你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。
      自己跑测试套件；核对新代码与 design.md 一致。
    input: design.md
    output: 可工作的实现
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

每个非子工作流步骤**必须**有 `id`、`desc`、`do`、`check`、`input`、`output`、`on_pass`、`on_fail`、`max_fail_count` —— 缺任何一个的步骤会被*静默跳过*（用 `/ralphflow-doctor` 抓出来）。完整 schema 见 [docs/custom-workflows_CN.md](docs/custom-workflows_CN.md)。

## 文档

- [工作原理](docs/how-it-works_CN.md) —— 架构、状态机、验证机制
- [命令参考](docs/commands_CN.md) —— 命令与工具参考
- [自定义工作流](docs/custom-workflows_CN.md) —— 完整 YAML schema 与设计指南
- [SYNC.md](SYNC.md) —— 与 Claude Code 姊妹插件的结构映射

## License

MIT
