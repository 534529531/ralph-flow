<div align="center">

# ralph-flow

**[opencode](https://opencode.ai) 工作流自动化插件**

自动执行多步骤工作流，将复杂任务转化为自动化流水线。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-green.svg)](https://opencode.ai)

[English](README.md) | [中文](README_CN.md)

</div>

---

## 功能特性

- **多步骤工作流** - 定义包含顺序步骤的复杂工作流
- **执行/检查阶段** - 每个步骤都有执行和验证阶段
- **自动重试** - 自动重试失败的步骤，可配置重试次数
- **手动控制** - 需要时可暂停等待人工干预
- **YAML 定义** - 简单易读的工作流定义格式
- **执行日志** - 详细的日志记录，便于调试和审计

## 安装方式

### 方式一：npm

在 opencode 配置中添加：

```json
{
  "plugin": ["@yibener/ralph-flow"]
}
```

### 方式二：本地插件

克隆仓库到 opencode 插件目录：

```bash
git clone https://github.com/your-username/ralph-flow.git ~/.config/opencode/plugins/ralph-flow
```

在该文件夹执行`npm run build`

之后在plugins目录新建**ralph-flow.ts**文件，粘贴以下内容

```ts
export { RalphFlow } from "./ralph-flow/dist/index.js";
```

## 快速开始

### 1. 启动工作流

```
/ralphflow-start
```

或直接指定工作流和任务：

```
/ralphflow-start loop "构建一个带认证的 REST API"
```

### 2. 查看工作流状态

```
/ralphflow-status
```

### 3. 继续已暂停的工作流

```
/ralphflow-continue
```

### 4. 取消工作流

```
/ralphflow-cancel
```

### 5. 列出可用工作流

```
/ralphflow-list
```

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│                      工作流启动                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  步骤：执行阶段（DO）                                         │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ AI 执行任务                                           │  │
│  │ 输出：<promise>done</promise>                         │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  步骤：检查阶段（CHECK）                                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ AI 验证工作成果                                        │  │
│  │ 输出：<promise-check>true/false</promise-check>       │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
        ┌─────────┐                     ┌─────────┐
        │   通过   │                     │   失败   │
        └─────────┘                     └─────────┘
              │                               │
              ▼                               ▼
    ┌─────────────────┐            ┌─────────────────────┐
    │  on_pass 步骤   │            │  fail_count++       │
    │ （或完成工作流）  │            │  on_fail 步骤       │
    └─────────────────┘            └─────────────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │  是否达到 max_fail_count │
                                  └─────────────────────────┘
                                           │
                                 ┌─────────┴─────────┐
                                 ▼                   ▼
                           ┌─────────┐         ┌─────────┐
                           │   否    │         │   是    │
                           └─────────┘         └─────────┘
                                 │                   │
                                 ▼                   ▼
                           ┌─────────┐         ┌─────────┐
                           │  继续   │         │  暂停   │
                           │  执行   │         │（手动）  │
                           └─────────┘         └─────────┘
```

1. `/ralphflow-start` 初始化工作流
2. 插件注入第一步的**执行阶段**提示词
3. AI 执行任务，完成后输出 `<promise>done</promise>`
4. 插件检测到完成标记，转入**检查阶段**
5. AI 验证工作成果，输出 `<promise-check>true</promise-check>` 或 `<promise-check>false</promise-check>`
6. 根据结果判断：
   - **通过**：跳转到 `on_pass` 步骤（或当 `on_pass: done` 时完成工作流）
   - **失败**：`fail_count` 递增，跳转到 `on_fail` 步骤（携带失败上下文）
7. 如果 `fail_count` 达到 `max_fail_count`，工作流**暂停**等待人工干预
8. 使用 `/ralphflow-continue` 重置 `fail_count` 并继续执行
9. 最后一步检查通过后，工作流完成

## 工作流定义

在 `.opencode/workflows/` 目录下创建 YAML 文件。默认工作流 `loop.yaml` 是单步骤自动循环：

```yaml
manual_phase:

steps:
    - id: loop
      desc: 自动循环执行任务
      do: 执行用户指定的任务，持续工作直到任务完全完成
      input: 用户输入的任务描述
      output: 任务完成的证明（代码、文件、测试结果等）
      check: 严格审查模式，使用独立审查和工具验证
      on_pass: done
      on_fail: loop
      max_fail_count: 100
```

多步骤工作流示例：

```yaml
manual_phase: analyze.do, execute.check

steps:
  - id: analyze
    desc: 任务分析
    do: 分析用户需求，创建设计文档
    input: 用户需求描述
    output: design.md, task.md
    check: 验证设计文档是否清晰完整
    on_pass: execute
    on_fail: analyze
    max_fail_count: 5

  - id: execute
    desc: 代码开发
    do: 根据设计文档实现代码
    input: design.md 和 task.md
    output: 开发总结报告
    check: 验证代码实现是否符合设计
    on_pass: done
    on_fail: problem_fix
    max_fail_count: 5

  - id: problem_fix
    desc: 问题修复
    do: 分析并修复检查失败的问题
    input: 失败报告
    output: 修复总结报告
    check: 运行单元测试验证修复
    on_pass: execute
    on_fail: problem_fix
    max_fail_count: 5
```

### 步骤字段说明

| 字段               | 类型     | 必填  | 说明                        |
| ---------------- | ------ | --- | ------------------------- |
| `id`             | string | ✅   | 步骤唯一标识                    |
| `desc`           | string | ✅   | 步骤描述                      |
| `do`             | string | ✅   | 任务执行提示词                   |
| `input`          | string | ✅   | 预期输入说明                    |
| `output`         | string | ✅   | 预期输出说明                    |
| `check`          | string | ✅   | 验证标准                      |
| `on_pass`        | string | ✅   | 通过后的下一步（步骤 id 或 `"done"`） |
| `on_fail`        | string | ✅   | 失败后的下一步（步骤 id）            |
| `max_fail_count` | number | ✅   | 最大失败次数                    |

### 完成标记

| 阶段  | 标记                                     | 说明   |
| --- | -------------------------------------- | ---- |
| 执行  | `<promise>done</promise>`              | 任务完成 |
| 检查  | `<promise-check>true</promise-check>`  | 验证通过 |
| 检查  | `<promise-check>false</promise-check>` | 验证失败 |

> **注意**：标记不区分大小写，允许空格。`<promise>DONE</promise>` 是有效的。

### 手动阶段

指定需要手动继续的阶段：

```yaml
manual_phase: analyze.do, execute.check
```

此列表中的阶段在会话空闲时**不会**自动继续。

## 项目结构

所有生成文件统一放在 `.opencode/ralph-flow/` 目录下：

```
.opencode/
└── ralph-flow/            # 插件生成文件统一目录
    ├── ralph-flow.local.md    # 工作流状态文件
    ├── workflows/             # 工作流定义
    │   └── *.yaml
    ├── logs/                  # 执行日志
    │   ├── execution.log      # 主执行日志（JSON Lines）
    │   ├── step-*.log         # 分步骤日志（JSON Lines）
    │   └── final-report.md    # 工作流完成报告
    └── package.json           # 依赖文件
```

## 配置说明

### 状态文件

工作流状态存储在 `.opencode/ralph-flow/ralph-flow.local.md`：

```markdown
---
active: true
workflow_name: loop
current_step: loop
current_phase: do
fail_count: 0
user_task: 构建一个带认证的 REST API
---
```

### 日志

日志以 JSON Lines 格式存储在 `.opencode/ralph-flow/logs/`：

```json
{"ts":"2026-05-25T10:30:00.000Z","level":"info","event":"workflow_start","workflow":"loop"}
{"ts":"2026-05-25T10:30:05.000Z","level":"info","event":"step_start","step":"loop","phase":"do"}
{"ts":"2026-05-25T10:35:00.000Z","level":"info","event":"done_detected","step":"loop","phase":"do"}
{"ts":"2026-05-25T10:35:10.000Z","level":"info","event":"check_result","step":"loop","phase":"check","passed":true}
```

#### 日志事件类型

| 事件                     | 说明              |
| ---------------------- | --------------- |
| `workflow_start`       | 工作流开始           |
| `workflow_end`         | 工作流结束           |
| `step_start`           | 步骤阶段开始          |
| `done_detected`        | 检测到完成标记         |
| `check_result`         | 检查结果            |
| `fail_count_increment` | 失败计数增加          |
| `workflow_paused`      | 工作流暂停（达到最大失败次数） |
| `workflow_resumed`     | 工作流被用户恢复        |
| `workflow_cancelled`   | 工作流被用户取消        |

### 最终报告

工作流完成时，会在 `.opencode/ralph-flow/logs/final-report.md` 生成最终报告：

```markdown
# 工作流执行报告

## 执行摘要

- **工作流**: loop
- **状态**: completed
- **总步骤数**: 3
- **失败次数**: 1
- **总耗时**: 25分钟

## 步骤执行情况

### 1. loop (do) ✓
- 状态：通过
- 耗时：5分钟

### 2. loop (check) ✓
- 状态：通过
- 耗时：5分钟

## 建议

（由 LLM 生成）
```

## 开源协议

本项目基于 MIT 协议开源 - 详见 [LICENSE](LICENSE) 文件。

---

<div align="center">

**[⬆ 回到顶部](#ralph-flow)**

</div>
