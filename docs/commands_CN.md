# 命令参考

[English](commands.md) · [中文](commands_CN.md)

## Slash 命令

| 命令 | 功能 |
|------|------|
| `/ralphflow-start` | 启动工作流（需要工作流名和任务描述） |
| `/ralphflow-continue` | 批准手动审查 · 发出 DO 完成信号 · 恢复暂停的工作流 · 接管中断的实例 |
| `/ralphflow-status` | 查看本会话的实例、指定实例，或全部实例 |
| `/ralphflow-list` | 列出可用工作流和活跃实例 |
| `/ralphflow-cancel` | 取消实例（先归档报告） |
| `/ralphflow-doctor` | 诊断所有工作流定义和实例状态 |
| `/ralphflow-create` | 交互式设计自定义工作流，验证到无警告 |

### 使用示例

```
# 交互式启动（询问工作流 + 任务）
/ralphflow-start

# 启动指定工作流
/ralphflow-start loop "实现用户认证"

# 任务源在项目外 —— 验证器需要读取权限
/ralphflow-start spec "重构 ~/legacy 里的模块" extra_dirs=~/legacy

# 查看状态（本会话，或全部实例）
/ralphflow-status

# 暂停后恢复、批准手动审查，或接管中断的实例
/ralphflow-continue
/ralphflow-continue loop-260710-ab12     # 接管指定实例（支持唯一前缀）

# 取消并归档报告
/ralphflow-cancel

# 列出工作流 + 活跃实例
/ralphflow-list

# 诊断每个工作流定义
/ralphflow-doctor
```

### 工具（由模型调用）

斜杠命令驱动这些下划线命名的工具；模型也可以直接调用它们。

| 工具 | 参数 | 功能 |
|------|------|------|
| `ralphflow_start` | `workflow`、`task`、`extra_dirs?` | 创建并绑定新实例 |
| `ralphflow_continue` | `instance?` | DO 完成 → 跑 CHECK 并推进；也用于恢复/接管 |
| `ralphflow_cancel` | `instance?` | 取消实例 |
| `ralphflow_status` | `instance?` | 单实例详情或概览 |
| `ralphflow_list` | — | 工作流 + 实例 |
| `ralphflow_doctor` | — | 只读诊断报告 |

---

## 实例模型

- 每次 `ralphflow_start` 在 `.opencode/ralph-flow/instances/<id>/` 下创建一个实例。
- 一个会话最多驱动一个实例；同一项目的多个会话各驱动各的。
- 属主是实例 `state.json` 里的 `session_id` 字段。任何会话的 `/ralphflow-continue` 都可接管某个实例 —— 项目内只有一个实例时自动接管，多个时需显式传 `instance`（支持唯一前缀）。（没有会话存活探测，所有权是建议性的。）
- 接管中断于 DO 中途的实例会重发 DO 提示词；中断于 done 标记之后的直接进入验证。

---

## 日志事件

每实例事件记录到 `.opencode/ralph-flow/instances/<id>/logs/execution.log`，JSON Lines 格式（10 MB 轮转）。

### 工作流事件

| 事件 | 说明 |
|------|------|
| `workflow_start` | 工作流启动 |
| `workflow_end` | 工作流完成 |
| `workflow_paused` | 暂停（最大失败 / 配置错误 / 验证基础设施故障） |
| `workflow_resumed` | 用户恢复 |
| `workflow_cancelled` | 用户取消 |
| `legacy_instance_migrated` | 1.x 工作流被迁移进实例布局 |

### 步骤事件

| 事件 | 说明 |
|------|------|
| `step_start` | 某步骤阶段开始 |
| `done_detected` | 检测到 `<promise>done</promise>` |
| `adversarial_check_start` / `_result` / `_timeout` | 独立验证生命周期 |
| `fail_count_increment` | 某步骤失败计数增加 |
| `sub_workflow_end` | 子工作流完成 |
| `crash_recovery` | 状态卡在 check 阶段，已重置到 DO |

### 日志格式

每行是一个 JSON 对象，含通用字段：

```json
{
  "ts": "2026-07-10T10:30:01.000Z",
  "level": "info",
  "event": "step_start",
  "step": "loop",
  "phase": "do"
}
```

### 查看日志

```bash
# 某个实例的日志（替换 <id>）
cat .opencode/ralph-flow/instances/<id>/logs/execution.log

# 在某实例内按事件类型过滤
grep '"event":"adversarial_check_result"' .opencode/ralph-flow/instances/<id>/logs/execution.log

# 最后 10 条事件
tail -10 .opencode/ralph-flow/instances/<id>/logs/execution.log
```

---

## 最终报告

工作流完成或取消时，摘要报告归档到
`.opencode/ralph-flow/reports/<id>-final-report.md`。

报告包含：
- 工作流名、最终状态、总耗时
- 每个步骤的阶段、通过/失败、重试次数、失败原因、耗时
- 若产出目录有交付物，附上其路径

---

## 实例目录内容

| 文件 | 用途 |
|------|------|
| `state.json` | 工作流状态（步骤、阶段、失败计数、暂停原因） |
| `state-stack.json` | 子工作流嵌套栈 |

| `artifacts-dir` | 本实例产出目录的名字 |
| `.manual-step-active` / `.manual-gate` | 手动审查门标记 |
| `.done-tag-detected` | DO 已完成，等待 `ralphflow_continue` |
| `.do-prompt-cache` | 当前 DO 提示词（保活时重新注入） |
| `.adversarial-session` | 运行中的验证会话 id |
| `logs/execution.log` | JSON Lines 事件日志 |
| `logs/step-records.json` | 逐步骤记录，用于生成最终报告 |
