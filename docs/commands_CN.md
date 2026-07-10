# 命令参考

[English](commands.md) · [中文](commands_CN.md)

## Slash 命令

| 命令 | 功能 |
|------|------|
| `/ralphflow-start` | 启动工作流。需要工作流名和任务描述，缺哪个先问哪个。 |
| `/ralphflow-continue` | 四种用途：收到提示后发出 DO 完成信号、批准手动审查、恢复暂停的工作流、接管中断的实例（可带实例 ID，支持唯一前缀）。 |
| `/ralphflow-status` | 查看本会话的实例、指定实例，或全部活跃实例概览。 |
| `/ralphflow-list` | 列出可用工作流（项目 + 内置）和活跃实例。 |
| `/ralphflow-cancel` | 取消实例：中止运行中的验证、归档最终报告、删除实例目录。 |
| `/ralphflow-doctor` | 诊断所有工作流定义和实例状态，并可代为修复。 |
| `/ralphflow-create` | 交互式设计自定义工作流，写出 YAML 并用 doctor 验证到无警告。 |

## 工具（由模型调用）

| 工具 | 参数 | 功能 |
|------|------|------|
| `ralphflow_start` | `workflow`、`task`、`extra_dirs?` | 创建并绑定新工作流实例。`extra_dirs`：项目外验证器需要读取的目录（启动时校验存在）。 |
| `ralphflow_continue` | `instance?` | DO 完成信号 → 运行独立 CHECK 并推进；也用于恢复暂停实例和接管中断实例。 |
| `ralphflow_cancel` | `instance?` | 取消实例（先归档报告）。 |
| `ralphflow_status` | `instance?` | 单个实例详情或全部实例概览。 |
| `ralphflow_list` | — | 可用工作流 + 活跃实例。 |
| `ralphflow_doctor` | — | 只读的完整诊断报告。 |

## 实例模型

- 每次 `ralphflow_start` 在 `.opencode/ralph-flow/instances/<id>/` 下创建一个实例。
- 一个会话最多驱动一个实例；同一项目的多个会话各驱动各的。
- 属主记录在实例的 `owner-session` 文件里。属主会话消失（opencode 重启）后，任何会话的 `/ralphflow-continue` 都可以接管 —— 只有一个实例时自动接管，多个时需显式传 `instance`。
- 接管中断于 DO 中途的实例会重发 DO 提示词；中断于 done 标记之后的直接进入验证。

## 实例目录内容

| 文件 | 用途 |
|------|------|
| `state.json` | 工作流状态（步骤、阶段、失败计数、暂停原因） |
| `state-stack.json` | 子工作流嵌套栈 |
| `owner-session` | 驱动会话 ID |
| `artifacts-dir` | 本实例产出目录的名字 |
| `.manual-step-active` / `.manual-gate` | 手动审查门标记 |
| `.done-tag-detected` | DO 已完成，等待 `ralphflow_continue` |
| `.do-prompt-cache` | 当前 DO 提示词（保活时重新注入） |
| `.adversarial-session` | 运行中的验证会话 ID |
| `logs/execution.log` | JSON Lines 事件日志（10 MB 轮转） |
| `logs/step-records.json` | 步骤执行记录，用于生成最终报告 |

实例目录之外：

- `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/` —— 交付物，工作流结束后保留
- `.opencode/ralph-flow/reports/<id>-final-report.md` —— 归档的最终报告
- `.opencode/ralph-flow/workflows/` —— 项目自定义工作流（同名遮蔽内置）

## 日志事件

`execution.log` 中的关键事件：`workflow_start`、`step_start`、`done_detected`、`adversarial_check_start/response/result/timeout`、`fail_count_increment`、`workflow_paused`、`workflow_resumed`、`sub_workflow_end`、`workflow_end`、`workflow_cancelled`、`crash_recovery`、`legacy_instance_migrated`。
