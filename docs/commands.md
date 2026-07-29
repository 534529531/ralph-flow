# 命令参考


## Slash 命令

### 工作流快捷命令（自动注册）

每个可启动的工作流都有自己的 slash 命令，名字就是工作流名，描述以 `(ralph-flow)` 标注来源：

```
/loop "用 JWT 和 refresh token 实现用户认证模块"
/spec "添加 OAuth2 用户认证功能"
/<你的自定义工作流> "任务描述"
```

输入 `/` 即可在补全列表里看到它们，和工作流名模糊匹配——不需要先 `/ralphflow-list` 查名字。机制说明：

- **自动注册**：插件加载时枚举项目、全局、内置三层工作流，各注册一个命令。新建的工作流在**下个会话**（或重启 opencode）后才有快捷命令，在此之前用 `/ralphflow-start <名字>`。
- **绝不覆盖**：与你自己定义的命令、其他插件的命令或下表中的管理命令撞名时，该工作流的快捷命令静默跳过（不影响 `/ralphflow-start` 启动它）。
- **无效定义不注册**：启动必然失败的工作流不会出现，用 `/ralphflow-doctor` 查看原因。
- **命名规范化**：命令名取小写、非法字符折成 `-`（如工作流 `My_Flow` → `/my-flow`，启动时仍按原名 `My_Flow` 加载）。全是中文/符号的名字无法构成命令，只能走 `/ralphflow-start`。

### 管理命令

| 命令 | 功能 |
|------|------|
| `/ralphflow-start` | 启动工作流（需要工作流名和任务描述）——快捷命令不可用时的通用入口 |
| `/ralphflow-continue` | 批准手动审查 · 发出 DO 完成信号 · 恢复暂停的工作流 · 接管中断的实例 |
| `/ralphflow-reset` | 当前会话太长/跑偏时**只重置当前步**的上下文——换一个干净会话重做当前步（状态机不动，失败计数不赦免） |
| `/ralphflow-rewind` | 回退到本工作流里**已通过 CHECK 的上游步骤**重做——状态机倒退、失败计数归零，下游产物保留；reason 必填，会跨会话注入新会话首条 DO 提示前 |
| `/ralphflow-status` | 查看本会话的实例、指定实例，或全部实例 |
| `/ralphflow-list` | 列出可用工作流和活跃实例 |
| `/ralphflow-cancel` | 取消实例（先归档报告） |
| `/ralphflow-doctor` | 诊断所有工作流定义和实例状态 |
| `/ralphflow-create` | 交互式设计自定义工作流，验证到无警告 |

### 使用示例

```
# 最快：直接用工作流快捷命令
/loop "实现用户认证"

# 交互式启动（询问工作流 + 任务）
/ralphflow-start

# 启动指定工作流（快捷命令被撞名跳过时的通用入口）
/ralphflow-start loop "实现用户认证"

# 任务源在项目外 —— 验证器需要读取权限
/spec "重构 ~/legacy 里的模块" extra_dirs=~/legacy

# 查看状态（本会话，或全部实例）
/ralphflow-status

# 暂停后恢复、批准手动审查，或接管中断的实例
/ralphflow-continue
/ralphflow-continue loop-260710-ab12     # 接管指定实例（支持唯一前缀）

# 上下文脏了只想重做当前步：换干净会话重做同一格步
/ralphflow-reset "模型一直把无关重构夹带进来，换干净上下文重来"

# 后期才发现早期步骤方向错了：倒退状态机到某个已通过 CHECK 的上游步骤重做
/ralphflow-rewind propose "第二步技术文档里 API 假设错了，得重设计"

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
| `ralphflow_reset` | `reason?`、`instance?` | 换一个干净会话重做**当前步**；状态机不动、失败计数不赦免 |
| `ralphflow_rewind` | `step`、`reason`、`keep_session?`、`instance?` | 倒退状态机到已通过 CHECK 的上游步骤重做；归零失败计数、清暂停、下游产物保留；reason 必填跨会话注入 |
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
| `rewind` | 用户用 `/ralphflow-rewind` 倒退状态机到上游已通过步骤（含 `from`/`to`/`keep_session`/`was_paused` 字段） |
| `context_reset` | 重置门触发：跨步骤转换或手动 reset 换入全新会话（含 `from`/`to`/`step` 字段） |
| `legacy_instance_migrated` | 1.x 工作流被迁移进实例布局 |

### 步骤事件

| 事件 | 说明 |
|------|------|
| `step_start` | 某步骤阶段开始 |
| `done_detected` | 检测到 `<promise>done</promise>` |
| `adversarial_check_start` / `_result` / `_timeout` | 独立验证生命周期 |
| `adversarial_check_request_failed` | 验证请求被服务端拒绝（如模型不存在/未授权），`error` 字段带真实原因 |
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
