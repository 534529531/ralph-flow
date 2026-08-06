# CHECK 多验证者投票(check_voting)· 终版设计

> **版本**: v2.0 终版
> **日期**: 2026-08-05
> **状态**: 设计定稿,待实现

---

## 一、范围与目标

在现有 CHECK 单验证者机制上,新增**步骤级多验证者并行投票**能力:步骤声明 `check_voting`(1-5 个验证者,各自独立的检查依据/模型/超时),全部通过才放行,任一失败则聚合其理由反馈 DO 重试。

**明确不做**:
- 不做 DO 阶段 fan-out(那是提示词+模型能力问题,不是基础设施问题;验收驱动开发下,怎么干活是 DO 的事)
- 不做投票阈值配置(全过才算过,无条件——用户决策)
- 不做 vm 脚本沙箱 / background subagents(实验特性)

**设计原则**:
1. 不依赖实验特性,只用已验证的 `client.session.create + prompt`
2. 不改变核心状态机:DO→CHECK→on_pass/on_fail 循环不变,投票是 CHECK 内部增强
3. 向后兼容:不写 `check_voting` 的现有工作流行为零变化
4. 验证者独立性:每票独立会话、独立提示、不共享记忆、互不等待

---

## 二、现状代码路径(实现的锚点)

| 路径 | 位置 | 说明 |
|------|------|------|
| 单验证者执行 | `src/check.ts` `adversarialCheck()` | 创建会话→注册 activeChecks→prompt→解析→删会话 |
| CHECK 入口 | `src/driver.ts` `runCheckAndAdvance()` (265) | DO 完成→state=check→注入用户可见提示→调 adversarialCheck→聚合→handleCheckPassed/Failed |
| 状态竞争防御 | `driver.ts:332` | check 返回后 re-check 状态,变了就丢弃结果 |
| check_error 暂停 | `driver.ts:340` | infra→paused+check_error,不计失败 |
| continue 恢复 | `tools.ts:217` | check_error pause→清 paused→空闲时 idle 重跑验证 |
| 崩溃恢复 | `tools.ts:284-329` | continue 分支第 4 段:check 阶段无活跃验证→清 .adversarial-session→回 DO 重做 |
| idle 恢复 | `driver.ts:616` | check 阶段+未暂停+`!readAdversarialSession()`→重跑 runCheckAndAdvance |
| 活跃会话跟踪 | `check.ts:31` `activeChecks: Map<string, ActiveCheck>` | 内存态,进程重启即丢 |
| 跨进程取消锚点 | `engine.ts:531` `.adversarial-session` 文件 | 存单个 checkSessionId |
| 取消 | `engine.ts:729` destroyInstance→`platform.abortActiveCheck` | abort+删会话 |
| 模型解析 | `check.ts:167` | workflow model→agent 配置→owner session→全局 |
| 验证者系统提示 | `engine.ts:2202` `DEFAULT_ADVERSARIAL_SYSTEM_PROMPT` | edit:deny 铁律+输出格式 |
| 结果解析 | `engine.ts:1750` parseCheckResult / `1756` getAdversarialCheckReason | 末行 `<promise-check>` 标签 |
| DO 失败反馈 | `engine.ts:1356` buildDoPrompt / `1854` handleCheckFailed | retryContext=checkResult.reason |
| 检查依据继承 | `engine.ts:1590` getEffectiveAdversarialCheck | workflow+祖先链逐字段 pick |
| **加载校验** | **`engine.ts:824`** | **normal 步骤强制 `check: string`,缺则静默跳过——check_voting 必须改造此处(§3.4)** |

---

## 三、YAML Schema

### 3.1 步骤级新增字段(NormalStepDef)

```yaml
steps:
  - id: implement
    desc: 实现功能
    do: 按 design.md 实现,跑测试到全绿
    input: design.md
    output: 测试通过的代码
    # 与 check 互斥:二选一。医生(doctor)检测同写则拒绝启动。
    check_voting:
      - check: "打开 design.md,逐条核对功能覆盖度;跑测试确认全绿"   # 必填,非空
        model: anthropic/claude-sonnet        # 可选
        timeout_ms: 600000                     # 可选,覆盖全局
        system_prompt: "..."                   # 可选,覆盖全局验证者系统提示
      - check: "安全性:硬编码密钥、SQL注入、XSS、越权"
        model: openai/gpt-4o
      - check: "性能:N+1 查询、内存泄漏、未分页大列表"
    # 单验证者(check)场景的步骤级模型覆盖(可选增强):
    # check_model: anthropic/claude-haiku
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### 3.2 规则

- `check_voting`:数组,**长度 1-5**(doctor 校验:0 报错、>5 报错,上限常量 `MAX_VOTERS = 5`)
- 条目 `check`:必填非空字符串
- 条目 `model`/`timeout_ms`/`system_prompt`:可选,缺省走继承链(见 §7)
- 条目**不配** `agent` 字段:验证者角色(edit:deny)由 effective.agent 决定(默认 ralph-check),所有票共享
- 仅 `check_voting` 有 1 个条目且无 model → doctor 警告"等同单验证者,建议直接用 check 或多视角"
- `check` 与 `check_voting` 至少提供一个;都缺 → 加载期静默跳过(与现有一致),doctor 警告
- `check_model`(步骤级,单 check 场景的模型覆盖):与 `check_voting` 互斥使用——写 check_voting 时 check_model 无意义(doctor 警告)

### 3.3 类型定义

```typescript
export interface CheckVotingEntry {
  check: string;
  model?: string | { providerID?: string; modelID?: string };
  timeout_ms?: number;
  system_prompt?: string;
}

// NormalStepDef 改造:
check?: string;                 // 改为可选:与 check_voting 至少提供一个(见 §3.4 加载校验)
check_voting?: CheckVotingEntry[];  // 新增,与 check 互斥
check_model?: string | { providerID?: string; modelID?: string };  // 新增,仅 check 场景生效
```

### 3.4 加载校验改造(必做,否则功能不可达)

现有 `engine.ts:824` 强制 normal 步骤必须写 `check: string`,缺则 `skipStep(...); continue;`(静默跳过该步骤)。若 check_voting 步骤不写 check,会被此校验直接跳过,投票路径永远不可达。**必须改造**:

```
loadWorkflow 步骤校验(normal 步骤,无 workflow 字段),按序执行,先命中先生效:

  1. step.check 与 step.check_voting 都写          → problem,硬错返回 null(互斥冲突,与重复 id 同级)
       —— 互斥优先于类型检查:即使 check 类型错,只要两字段都在就按互斥硬错,
          不让配置错误被静默 skip 掩盖
  2. step.check_voting 存在且非法(非数组/超上限/
     条目 check 缺失或非空串)                     → problem,硬错返回 null
  3. step.check 存在但类型非 string(如 check: 123) → skipStep,与现有一致
  4. step.check 与 step.check_voting 都没有        → skipStep(与现有"缺 check 跳过"语义一致,doctor 会额外提示)
  5. 仅 step.check 合法                            → 单验证者路径(现有行为)
  6. 仅 step.check_voting 合法                     → 投票路径
```

> 互斥冲突(规则 1)用 `problem()` 硬错(参照重复 id,engine.ts:833),不用 `skipStep`——静默跳过会掩盖配置错误。doctor 同时系统性报告(§3.5)。

### 3.5 doctor 校验规则

| 规则 | 判定 |
|------|------|
| `check` 与 `check_voting` 同写 | 报错,拒绝启动 |
| `check_voting` 空数组 | 报错 |
| `check_voting` 长度 > 5 | 报错(上限 MAX_VOTERS) |
| 条目 `check` 空串/缺失 | 报错 |
| 条目 `model` 格式非法 | 报错(`provider/model` 或 `{providerID,modelID}`) |
| 条目数 = 1 且无 model | 警告:等同单验证者,建议直接 check 或多视角 |
| 写 `check_voting` 又写 `check_model` | 警告:check_model 仅单 check 场景生效 |
| 条目 `timeout_ms` ≤ 0 或非数字 | 报错 |
| 条目含未知字段(如 `agent`) | 警告 |
| `check` 与 `check_voting` 都缺 | 警告:步骤会被静默跳过(与现有行为一致,建议显式检查) |

---

## 四、运行时流程

### 4.1 总览

```
DO 完成,<promise>done</promise> 检测到
  → driver.ts runCheckAndAdvance:
      进度文件生命周期:按入口 phase 决策(§5.3:phase="do" 删 / phase="check" 存续或全投)
      注入用户可见提示(§9 场景1)
      若 step.check_voting:  → 投票路径(§4.2,读进度文件决定跑哪些票)
      若 step.check:         → 现有 adversarialCheck(零改动)
      聚合完成 → re-check 状态(driver.ts:332 模式)
      → infra?  check_error 暂停(§4.4,保留进度文件,不计 fail_count)
      → fail?   删进度文件 → 合并 reason → handleCheckFailed → DO 重试(§4.5)
      → pass?   删进度文件 → handleCheckPassed → 推进
```

### 4.2 投票执行(并发)

```typescript
// src/check-voting.ts(新文件)

export interface VoterVerdict {
  index: number;
  entry: CheckVotingEntry;
  status: "passed" | "failed" | "infra" | "cancelled";
  reason: string;          // 验证者原始输出(标签前文本)或 infra/cancel 说明
}

/**
 * 并发执行一轮投票。每票 = 一个独立 adversarialCheck 会话(复用 check.ts
 * 的会话创建/取消/超时机制,只是并发 N 个、各自注入条目 prompt)。
 * 返回原始票结果,不做任何状态变更——状态机只能由聚合层触碰。
 */
async function runVotingRound(
  client: Client,
  engine: Engine,
  instId: string,
  ownerSessionId: string | null,
  step: NormalStepDef,
  userTask: string | undefined,
  entries: CheckVotingEntry[],
  effective: AdversarialCheckConfig,      // getEffectiveAdversarialCheck 结果
  round: number,
): Promise<VoterVerdict[]>
```

执行要点:

- 每票调用精简版 `adversarialCheck`(从 check.ts 抽出的 `runSingleVoter`):`client.session.create({title: "Ralph Check: <step> [i/N] <视角摘要>", parentID, query})` → `session.prompt({model, agent, system, parts})` → 解析 → 删会话
- `activeChecks` 改为 `Map<string, ActiveCheck[]>`(instId → 该轮所有在跑票的 handle);`isCheckSession` 遍历所有数组;`hasActiveCheck` = 数组非空
- 每票独立超时(entry.timeout_ms → effective.timeout_ms → 全局默认),超时按 infra 处理(§4.4)
- 每票独立 keepalive 日志,带 `{voterIndex, perspective}`(从 check.ts 的 60s interval 提取复用)
- 会话标题: `Ralph Check: ${step.id} [${i}/${N}] ${entry.check 摘要前 30 字符}`

### 4.3 聚合语义(全过才算过)

```typescript
// 一轮完成后(含 infra 重试轮):
const passed = verdicts.filter(v => v.status === "passed");
const failed = verdicts.filter(v => v.status === "failed");
const infra  = verdicts.filter(v => v.status === "infra");
const cancelled = verdicts.filter(v => v.status === "cancelled");

// 决策表(按优先级自上而下):
// 1. 有 cancelled(用户取消/实例被删)          → 丢弃整轮结果,不写状态(driver.ts:332 已防御)
// 2. failed 非空                              → 整体失败,聚合 reason(§4.5)。
//      注意:即使同时有 infra 票,也直接判失败——工作问题是确定性的,
//      不应被基础设施故障遮蔽;infra 票在下一轮(DO 修复后跨轮)自然重投
// 3. 无 failed 且 infra 非空                  → 自动重试一轮,只重跑 infra 票(§4.4)
// 4. 全 passed                                → 整体通过
```

**聚合优先级 `failed > infra`**:第 1 轮票 A=failed(工作问题)、票 B=infra 时,直接判整体失败并反馈 DO——A 的问题是确定的,B 的 infra 不阻塞它。DO 修复后跨轮重投,B 自然重新参与。只有**全部票都不判失败、但有票 infra** 时,才触发 infra 自动重试。

**关键:任何单票完成都不碰状态机,全部终态(含 infra 重试轮)后才聚合一次,并执行 driver.ts:332 的状态 re-check。**

### 4.4 infra 处理(自动重试,最多一次)

**重试预算按"暂停会话"计,不跨 continue 累计**——每次 check_error 暂停后用户 continue,该票视为**新的赦免**,重置为 `pending` 重新投票(§5.3);之后仍最多自动重试 1 次,再失败再暂停。因此 continue 永不死锁。

| 阶段 | 行为 |
|------|------|
| 第 1 轮 | 某票 infra(超时/API 错/会话创建失败/空响应)→ 持久化为 `infra_pending`,不判失败 |
| 第 2 轮(自动) | 仅重跑 `infra_pending` 票,已 `passed` 的票不重跑;并发度 ≤ MAX_VOTERS。注:此时必无 `failed` 票——有 failed 已在 §4.3 优先级 2 判整体失败,不会进入本轮 |
| 第 2 轮仍 infra | 该票持久化为 `infra_failed`;**若此时无其他 failed 票** → 整体 `check_error` 暂停(与单验证者一致的 pause_reason=check_error,不计 fail_count);**若有 failed 票** → 直接判整体失败(§4.3 优先级 2),infra_failed 不遮蔽工作失败 |
| 用户 continue | tools.ts:217 清 paused → idle 重跑 → 读进度文件,**将 `infra_failed` 票重置为 `pending`**(新赦免,预算清零,§5.3);非终态票(`pending`/`running`,含重置后的)全部重跑,`passed` 不动 |
| 重跑后出判定 | 并入聚合,全过才放行 |

**为什么自动重试 1 次**:单票 API 抖动概率远大于 N 票同时抖动,一次抖动就暂停整个工作流不公平;重试成本低(只重跑故障票)。

**为什么 continue 重置预算而非无限重试**:用户每次显式 continue 就是一次新的赦免("基础设施现在好了,再试")。之后最多自动重试 1 次,防止基础设施持续故障时无限空转——连续两次失败会再次暂停,把控制权交回用户。

**超时判定**:每票独立超时,超时票 abort 其会话后按 infra 记。

### 4.5 失败反馈聚合(给 DO 的 reason)

```markdown
多验证者检查 2/3 通过,全过才放行(第 2 次重试,上限 5 次):

### ✗ 未通过的验证者(必须修复)

**验证者 2/3 · 安全性 · openai/gpt-4o**
检查依据:硬编码密钥、SQL注入、XSS、越权
问题:
[auth.service.ts:47] JWT 密钥硬编码,应走环境变量
[login 接口] 未限流,存在暴力破解风险

**验证者 3/3 · 性能 · google/gemini-2.5-pro**
检查依据:N+1 查询、内存泄漏、未分页大列表
问题:
/users 接口未分页,N+1 查询在 UserController:88

### ✓ 已通过的验证者(修复时不要破坏)

验证者 1/3 · 功能完整性:测试全绿,design.md 覆盖度完整
```

规则:
- 失败者在前(完整 reason),通过者在后(一句话摘要)
- 每票标注"检查依据原文"——DO 没看过 check_voting 配置,必须知道该票的判定标准
- 通过者摘要带上:DO 需要知道哪些部分已被确认,避免修复时改坏
- 长度:验证者输出已受输出契约约束(§8,每票 ≤10 行),聚合总长天然有界;仍保留总兜底截断 8000 字符
- 此 reason 作为 `checkResult.reason` 传给 handleCheckFailed → buildDoPrompt 的 retryContext(engine.ts:1361),现有链路不动

### 4.6 通过反馈

```markdown
## 检查结果:通过 ✓ (3/3 验证者全过)

[✓] 1/3 功能完整性:测试全绿,覆盖度完整
[✓] 2/3 安全性:无硬编码密钥、SQL 注入、越权风险
[✓] 3/3 性能:无 N+1 查询,分页正常

---

下一步:**next** - 描述
```

通过时每个验证者一行确认(其输出契约的通过证据行直接可用)。

### 4.7 跨轮语义(关键区分)

| 场景 | 缓存? | 说明 |
|------|-------|------|
| **同一轮内** infra 自动重试 | 缓存已判定票 | 没轮到 DO,工作没变,只补跑故障票 |
| **跨轮**(DO 修复后重新进入 check) | **不缓存,全部重跑** | DO 改了代码,上次 pass 的视角现在可能 fail;进入 check 时**删除进度文件** |

---

## 五、进度持久化 `.check-voting-progress.json`

### 5.1 为什么需要

投票进度横跨:多票并发、infra 自动重试、check_error 暂停、用户 continue。这些事件都可能在**不同进程/会话**里发生,内存 Promise 结果不可靠——必须落盘。

> **进程重启不在此列**:重启后 plugin load 钩子(§6.2)清理孤儿会话并删除进度文件,全部重新投票——上一进程的判定随进程丢失,不跨重启恢复(与崩溃恢复回 DO 的语义一致,见 §12.2)。进度文件的生命周期仅覆盖"同一次 check 阶段的同轮/续跑"。

### 5.2 文件位置与结构

`instances/<instId>/.check-voting-progress.json`:

```json
{
  "stepId": "implement",
  "workflowName": "my-flow",
  "entries": [
    { "index": 0, "check": "功能完整性...", "model": "anthropic/claude-sonnet",
      "status": "passed", "reason": "[...] 测试全绿" },
    { "index": 1, "check": "安全性...", "model": "openai/gpt-4o",
      "status": "failed", "reason": "[auth.service.ts:47] JWT 密钥硬编码..." },
    { "index": 2, "check": "性能...", "model": null,
      "status": "infra_pending", "reason": "验证请求失败: 429 rate limit" }
  ],
  "updatedAt": "2026-08-05T10:00:00.000Z"
}
```

`status` 枚举:`pending`(未开始)/ `running`(在跑)/ `passed` / `failed` / `infra_pending`(本轮自动重试前,需重跑)/ `infra_failed`(自动重试后仍失败,导致暂停;**用户 continue 后重置为 `pending` 重新投票**,§4.4)/ `cancelled`

> **重试预算**:持久化状态里不显式存"已重试次数"——以 `infra_pending → infra_failed` 两次状态表达"本轮预算已耗尽"。用户 continue 时把 `infra_failed` 重置为 `pending`,即预算清零、新一轮赦免开始(§4.4)。

### 5.3 生命周期

**跨轮与同轮续跑的区分机制**:`runCheckAndAdvance` 是 check 阶段唯一入口,由两种路径进入,靠**入口时 `state.current_phase` + 进度文件是否存在**双条件区分(driver.ts:278 已有 `if (state.current_phase === "do")` 判断):

| 入口 phase | 进度文件 | 语义 | 操作 |
|-----------|---------|------|------|
| "do"(DO 刚完成,正常进入) | 任意 | 跨轮,DO 已修改产物 | **删除文件**,全部重新投票 |
| "check"(check_error 暂停被 continue 清除后 idle 重跑,driver.ts:616) | **存在** | 同轮续跑 | 保留文件;**`infra_failed` 重置为 `pending`**(§4.4 预算清零),跑 `pending/running` 票 |
| "check"(同上路径) | **不存在**(如 plugin load 钩子已清) | 重启后重投 | 初始化全 pending,全部重投票(无缓存票可续) |

**决策函数**:`phase === "do" → 删;phase === "check" → 文件存在则续跑(infra_failed 重置 pending),不存在则全投`。跨轮重做仍是同一 stepId,靠 phase 区分,与 stepId 无关。

**续跑重跑集合**:进入续跑时,`infra_failed` 重置为 `pending`,与原有 `pending`/`running` 一起构成重跑集合;`passed`/`failed` 为终态不动。

| 事件 | 入口 phase | 文件 | 操作 |
|------|-----------|------|------|
| DO 完成 → 进入 check(driver.ts:278 路径) | "do" | — | 删除文件(跨轮,全部重投票) |
| check_error 暂停 → continue → idle 重跑(driver.ts:616 路径) | "check" | 存在 | **保留**文件;`infra_failed` 重置 `pending`;跑 `pending/running` 票 |
| plugin load 清理孤儿会话后 idle 重跑(§6.2) | "check" | 已删 | 全部重投票 |
| 每票开始/完成 | — | — | 更新对应条目 status/reason,原子写 |
| 聚合完成(出判定,pass 或 fail) | — | — | 删除文件(本轮结束;fail 则 DO 重试,下次 phase="do" 重新初始化) |
| check_error 暂停 | — | — | 保留文件(continue 续跑靠它) |
| 崩溃恢复(tools.ts:292 回 DO) | — | — | 删除文件(回 DO 全部重来) |
| reset/rewind/cancel | — | — | 删除文件 |

### 5.4 消费者

- **TUI/status**:读文件显示 `验证中 (2/3) ✓✓ ✗`、各票状态与 reason 摘要
- **continue**:check_error 恢复时靠它决定重跑哪些票
- **idle/driver**:重跑投票时靠它续跑
- **报告**:完成报告附每票 verdict(从文件读,聚合后归档进 report)

---

## 六、取消与重启

### 6.1 取消(现有 destroyInstance 路径)

- `activeChecks` 改 `Map<string, ActiveCheck[]>`;`abortActiveCheck(instId)` abort **全部**在跑票会话,逐个 delete
- `.adversarial-session` 文件从"单 id"改为 **JSON 数组**(跨进程取消可见全部);读时兼容单值字符串(旧实例)
- `isCheckSession` / `hasActiveCheck` / driver.ts:616 的 `readAdversarialSession()` 全部按"数组非空"语义适配
- destroyInstance 时删进度文件

### 6.2 进程重启与 plugin load 孤儿清理

**核心原则**:进程重启后,上一进程创建的验证会话已成孤儿(无人再收其 Promise 结果)。清理必须在 **plugin 初始化时主动做**(用户要点 8:plugin load 钩子,顺带修单验证者的"重启后 idle 卡死"问题),而不是等用户 continue 触发崩溃恢复。

**plugin load 钩子**(`src/index.ts` 工厂函数,紧跟 `setup()` 之后,`setupDirs` 同款防重):

```
for each 活跃实例(instId):
  if state.current_phase === "check" && readAdversarialSession(instId) 数组非空:
    for each orphanSessionId:  try client.session.delete({path:{id}}) catch {}
    clearAdversarialSession(instId)      // 清数组文件
    delete .check-voting-progress.json   // 删进度文件
    logEvent "orphan_verifier_cleaned"   // 记录被清理的会话数
```

清理后:`.adversarial-session` 为空 → 下次 idle(driver.ts:616)看到 `!readAdversarialSession()` → 自动重跑 runCheckAndAdvance → 进来时 `current_phase === "check"`(实例仍在 check 阶段)→ 按 §5.3 续跑语义**全部重投票**(进度文件已删,无缓存票)。

> **安全前提**:同一进程内,check 会话也是本进程创建的;plugin 初始化时本进程不可能有"正在正常运行的 check"(工厂是进程级初始化)。因此这些 session id 必是孤儿,删除无副作用。多次调用由 `setupDirs` 防重保证只清一次。

> **行为改进说明**:这同时修复单验证者的既有卡死——旧行为是重启后 idle 卡住(driver.ts:616 见 .adversarial-session 非空不重跑),只能靠用户 continue 触发崩溃恢复;新行为是 idle 自动重跑验证。属改进,非破坏(重启后结果本就不可信)。

**钩子之后的分层恢复**:

| 场景 | 行为 |
|------|------|
| plugin 初始化,实例在 check 阶段 + 有孤儿会话 | 钩子清理 → idle 自动重跑验证 |
| 钩子清理后用户手动 continue | continue 走 tools.ts:284 崩溃恢复:hasActiveCheck 假 → 清 .adversarial-session → 回 DO 重做 → 删进度文件(兜底,与单验证者语义一致) |
| 钩子清理前用户 continue(竞态) | tools.ts:288 hasActiveCheck 假(内存空)→ 走崩溃恢复,同上 |
| check_error 暂停(运行中,非崩溃) | 钩子不涉及(钩子只在 plugin 初始化跑一次,此时无暂停实例);进度文件由 §5.3 保留,continue 后 `infra_failed` 重置 `pending` 重跑(§4.4) |

> **为何崩溃恢复回 DO 而非续跑**:崩溃时验证结果随进程丢失,连"哪些票已判定"都不可信,宁可重做。这是现有单验证者的既定语义,多验证者保持一致——不跨进程恢复已判定票,那需要把完整验证结果落盘并重连 server 会话,复杂度远超收益。

### 6.3 与 reset/rewind/manual_step 的交互

- **manual_step**:审查门在 check 前,与投票无冲突;门放行后 idle 触发投票
- **reset**:abort 全部在跑票 + 删进度文件,新会话重做当前步
- **rewind**:同上(回退到上游已通过步骤)

---

## 七、模型优先级链

```
条目 model(最强) > 步骤 check_model(仅单 check 场景) > effective adversarial_check.model(workflow+祖先链)
  > 验证者 agent 配置 > owner session 当前模型 > opencode 全局默认
```

- 抽取纯函数 `resolveVerifierModel(entryModel, stepModel, effective)`(复用 check.ts:167 现有解析,插入两级),可单测
- `effective` 来自现有 `getEffectiveAdversarialCheck`(engine.ts:1590,含子工作流祖先链继承)
- 条目缺 `timeout_ms` → effective.timeout_ms → 全局默认(900s);缺 `system_prompt` → effective.system_prompt → DEFAULT_ADVERSARIAL_SYSTEM_PROMPT
- `agent` 恒为 effective.agent(默认 ralph-check),条目级不提供

---

## 八、验证者输出契约(精炼,写入 system prompt)

### 8.1 为什么改

现有 `DEFAULT_ADVERSARIAL_SYSTEM_PROMPT` 只要求"每项依据的独立证据+失败原因",**无精炼约束** → 输出可能很长 → 聚合/反馈需要粗暴截断 → 边界信息不足。

### 8.2 新输出格式段(全局生效,单验证者也受益)

```markdown
## 输出格式(精炼,结构化)

**判定**:最后一行输出标签:
- 通过 → `<promise-check>true</promise-check>`
- 不通过 → `<promise-check>false</promise-check>`

**证据与原因,每条一行,最多 10 行**,位置前缀按情况选用:
- 具体代码问题:`[文件:行号] 问题一句话`
- 模块级问题:`[模块名] 问题一句话`
- 架构级/跨文件问题:直接写问题一句话,不加前缀

示例:
- `[auth.service.ts:47] JWT 密钥硬编码`
- `[payment] 与 auth 共享全局可变状态,耦合过高`
- `缺少统一错误处理层,各模块异常处理散落`

不要复述检查依据原文,不要写结论性空话。
```

### 8.3 收益

- 输出天然有界:每票 ≤10 行 → 3 票 ~30 行,聚合无需逐票截断,只留总兜底 8000
- 信息密度高:`[文件:行号] 问题` 一眼可定位;架构问题裸写不受位置格式约束
- 解析逻辑不变:`getAdversarialCheckReason` 仍取标签前全文;`parseCheckResult` 仍查末行标签
- 单验证者 reason/通过反馈顺带更精炼(行为改进,非破坏)

### 8.4 投票专属注入(验证者 prompt 尾部)

```markdown
## 你是 N 个验证者之一

- 你**只负责你自己的检查依据**(上方"检查依据"段),不要试图覆盖其他验证者的视角
- 其他验证者正在并行检查其他方面,各有独立会话
- 你的结论不受任何其他验证者影响,也不要等待或引用它们
```

> 这条是投票有效的关键:不写它,验证者会各自跑偏查全部,三票趋同,投票失去意义。

---

## 九、提示词场景清单(8 处)

| # | 场景 | 注入目标 | 触发位置 | 多验证者版本 |
|---|------|---------|---------|-------------|
| 1 | 验证开始(自动) | owner 会话(noreply) | driver.ts:311 | 表格:N 票的视角/模型/超时;说明"互不共享记忆,全过才放行" |
| 2 | 单票 infra 自动重试 | 无(静默) | 新增 | 不打扰用户,日志+TUI 显示 `(验证者 3 API 抖动,自动重试中)` |
| 3 | infra 重试仍失败→暂停 | owner 会话(noreply) | driver.ts:344 变体 | "验证者 k/N 重试后仍无法运行:{reason};非工作成果问题,不计失败;已通过的 k1,k2 结果保留,continue 后将重新验证验证者 k" |
| 4 | 聚合层异常崩溃 | owner 会话(noreply) | driver.ts:323 | 措辞:"多验证者检查崩溃:{err}" |
| 5 | continue 恢复(check_error) | 工具返回(tools.ts:217 现有) | tools.ts | "验证基础设施故障已清除,空闲时自动重新验证" → 保留;若有 `infra_failed` 票,追加"将重新验证验证者 k/N(基础设施故障票)" |
| 6 | 失败→DO 反馈 | DO 会话 | buildDoPrompt retryContext | §4.5 聚合格式:失败者完整+通过者摘要+各自检查依据 |
| 7 | 验证者 prompt | 验证者会话 | buildCheckPrompt 变体 | 共享段(用户需求/DO 任务/产出目录)+ 该票检查依据 + §8.4 "只查自己视角" |
| 8 | 通过汇总 | owner 会话 | handleCheckPassed | §4.6:N 票各一行确认 |

---

## 十、doctor 校验规则

见 §3.5(doctor 规则已在上方 YAML Schema 章节完整定义,此处不再重复)。

---

## 十一、文件级改动清单

| 文件 | 改动 |
|------|------|
| `src/check.ts` | 抽 `runSingleVoter`(原 adversarialCheck 主体);`activeChecks` 改数组;`abortActiveCheck` abort 全部;会话标题带 `[i/N]`;keepalive 带 voterIndex |
| `src/check-voting.ts`(新) | `runVotingRound`(并发 N 票)、聚合决策、infra 重试轮 |
| `src/voting-progress.ts`(新) | `.check-voting-progress.json` 读写(原子写)、status 枚举、生命周期工具 |
| `src/engine.ts` | **加载校验改造(§3.4,engine.ts:824:check/check_voting 至少一个、互斥同写硬错)**;NormalStepDef 加 `check_voting`/`check_model`(check 改可选);`resolveVerifierModel` 纯函数;`.adversarial-session` 改 JSON 数组(读兼容单值);`DEFAULT_ADVERSARIAL_SYSTEM_PROMPT` 输出格式段改精炼版;buildCheckPrompt 的 voting 变体(共享段+条目+§8.4);聚合 reason 格式化;doctor 规则(§3.5);MAX_VOTERS |
| `src/driver.ts` | runCheckAndAdvance 按步骤分流(check/voting);聚合后状态 re-check(沿用 332 模式);**进度文件生命周期按入口 phase 区分(§5.3:phase="do" 删、phase="check" 续跑)**;提示词场景 1/3/4/8 注入;idle 续跑读进度文件 |
| `src/tools.ts` | continue 的 check_error 恢复读进度文件只重跑未判定票;崩溃恢复(tools.ts:284)补 abort+delete 孤儿会话+删进度文件;status 显示投票进度;cancel/reset 删进度文件 |
| `src/index.ts` | **plugin load 孤儿清理钩子(§6.2,紧跟 setup,setupDirs 防重)**;stop hook 的 isCheckSession 兼容(遍历数组) |
| `src/__tests__/` | 见 §十三 |

---

## 十二、向后兼容与风险

### 12.1 向后兼容

- 不写 `check_voting` → 全部走原路径,行为零变化
- `DEFAULT_ADVERSARIAL_SYSTEM_PROMPT` 输出格式改精炼 → 现有单验证者的 reason 变精炼(改进,非破坏);解析逻辑不变
- `.adversarial-session` 数组格式 → 读时兼容旧单值

### 12.2 风险与缓解

| 风险 | 缓解 |
|------|------|
| 成本:N 票 ≈ N 倍 token | 每票可配便宜模型;验证者只查自己视角(更聚焦);上限 5 票 |
| 一个视角持续失败卡流程 | max_fail_count 兜底;失败反馈标注视角/模型,用户可精准调整该条目 |
| 并发票受 provider 限流(429) | 上限 5;429 计入 infra → 自动重试 1 次;重试仍失败 → check_error 暂停(计 infra 不计失败) |
| 状态竞争(取消/continue/崩溃在投票中发生) | 沿用 driver.ts:332 re-check;任何单票完成不碰状态;cancelled 票丢弃整轮 |
| 进程重启丢已判定票 | 接受:崩溃恢复回 DO 重做(与单验证者语义一致),不跨进程恢复 |

---

## 十三、测试计划

| 测试 | 覆盖 |
|------|------|
| `check-voting.test.ts` | 并发 N 票执行;聚合决策(全过/有失败/混合);**failed 优先于 infra(混合票判失败不判暂停)**;infra 重试轮只重跑未判定票;重试仍 infra 且无 failed → check_error;**continue 后 infra_failed 重置 pending 重跑(不死锁)**;**连续两次 infra 后无 failed → 暂停 → continue → 重跑 → 仍 infra → 再暂停(预算不跨 continue 累计)** |
| `voting-progress.test.ts` | 文件初始化/更新/删除生命周期;跨轮删除;check_error 保留;`infra_failed` 重置 `pending`;**崩溃恢复删除**;并发原子写 |
| `resolve-verifier-model.test.ts` | 优先级链:条目 > check_model > effective > agent 配置 > owner session > 全局;无效值回退 |
| `aggregate-reason.test.ts` | 失败者完整+通过者摘要;检查依据标注;8000 兜底截断;全过格式;混合 failed+infra 时只列 failed 给 DO |
| `output-contract-parse.test.ts` | 精炼格式解析兼容(末行标签);10 行上限(doctor 提示,运行时不强制) |
| `doctor-rules.test.ts` | §3.5 全部规则;**互斥同写硬错优先于类型检查(§3.4 规则 1)** |
| `cancel-restart.test.ts` | abort 全部票;.adversarial-session 数组读写/兼容旧值;崩溃恢复清孤儿会话;进度文件清理 |

---

## 十四、实现顺序

1. `check.ts` 重构:抽 `runSingleVoter` + activeChecks 数组(现有单验证者行为不变,先绿)
2. `engine.ts`:类型、DEFAULT_ADVERSARIAL_SYSTEM_PROMPT 精炼版、resolveVerifierModel
3. `voting-progress.ts` + `check-voting.ts`:并发投票 + 聚合 + infra 重试 + 进度持久化
4. `driver.ts` + `tools.ts`:分流、提示词、continue/崩溃恢复/status 适配
5. `index.ts` + doctor 规则
6. 测试补齐(§十三)
