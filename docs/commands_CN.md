# 命令参考

## Slash 命令

| 命令 | 工具 | 功能 |
|------|------|------|
| `/ralphflow-start` | `ralphflow-start` | 启动工作流 |
| `/ralphflow-continue` | `ralphflow-continue` | 恢复暂停的工作流 |
| `/ralphflow-cancel` | `ralphflow-cancel` | 取消并生成报告 |
| `/ralphflow-status` | `ralphflow-status` | 查看当前工作流状态 |
| `/ralphflow-list` | `ralphflow-list` | 列出可用工作流 |

### 使用示例

```
# 交互式启动
/ralphflow-start

# 启动指定工作流
/ralphflow-start loop "实现用户认证模块"

# 查看当前状态
/ralphflow-status

# 暂停后恢复
/ralphflow-continue

# 取消并获取报告
/ralphflow-cancel

# 列出所有工作流
/ralphflow-list
```

---

## 日志事件

事件以 JSON Lines 格式记录到 `.opencode/ralph-flow/logs/execution.log`。

### 工作流事件

| 事件 | 说明 |
|------|------|
| `workflow_start` | 工作流开始 |
| `workflow_end` | 工作流结束 |
| `workflow_paused` | 工作流暂停（达到最大失败次数） |
| `workflow_resumed` | 工作流被用户恢复 |
| `workflow_cancelled` | 工作流被用户取消 |

### 步骤事件

| 事件 | 说明 |
|------|------|
| `step_start` | 步骤阶段开始 |
| `done_detected` | 检测到完成标记 |
| `check_result` | 检查结果 |
| `fail_count_increment` | 失败计数增加 |

### 日志格式

每行是一个 JSON 对象，包含通用字段：

```json
{
  "event": "step_start",
  "step": "loop",
  "phase": "do",
  "timestamp": "2024-01-15T10:30:01Z"
}
```

### 查看日志

```bash
# 查看所有日志
cat .opencode/ralph-flow/logs/execution.log

# 按事件类型过滤
grep '"event":"check_result"' .opencode/ralph-flow/logs/execution.log

# 查看最后 10 条事件
tail -10 .opencode/ralph-flow/logs/execution.log
```

---

## 最终报告

工作流完成或取消时，会在 `.opencode/ralph-flow/logs/final-report.md` 生成总结报告。

报告包含：
- 工作流名称和耗时
- 已完成的步骤
- 总失败和重试次数
- 最终状态
