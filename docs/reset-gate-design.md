# 重置门（Reset Gate）技术方案

> 状态：**已实施（v2.6.0）**。本文档记录原始设计方案及实施后的多次修正。
> §9 汇总了验证中发现的全部问题与修正（可见性、自动跳转、toast、abort、交接简报、嵌套判定）。
>
> 要解决的问题：长工作流后半段，主会话上下文膨胀导致模型质量下降（丢需求、跑偏、
> 重复犯错）。CHECK 机制能保证最终验收，但中间会走很多弯路、烧很多 token。

---

## 1. 方案概述

在步骤边界**给用户换一个新的主会话**，替换掉上下文已经臃肿的旧会话：

```
CHECK 通过/失败 → 状态机算出目标步骤（现有逻辑，不动）
    ↓
判定：目标步骤标了 reset（或工作流 auto_reset；任何方式进入都触发，含同步骤重试）
    ↓
session.create（新会话，parentID=旧会话，title 带约定前缀）
    ↓
state.session_id 改为新会话（claimOwnership，现有机制）
    ↓
旧会话注入告别消息（noReply）；新会话注入 DO 提示（promptAsync）
    ↓
现有 idle 驱动在新会话里照常接管（零改动）
```

**为什么是这个方案而不是"完整子会话架构"（DO 搬进插件拥有的子会话）**：

| | 完整子会话架构 | 重置门（本方案） |
|---|---|---|
| 上下文隔离 | 每步全新 | 每个门段全新（粒度工作流作者控制） |
| 用户可见性 | 需跳转/进度播报系统 | 天然可见——DO 还在用户面前的会话里 |
| 插话 | 需消息转发机制 | 原生插话 |
| driver.ts | 重写 | 新增一个函数 |
| 权限/崩溃恢复 | 需适配 | 现有逻辑零改动 |
| TUI 工程 | 状态区+响铃+跳转 | 可选的自动跳转，没有也能用 |

约 1/3 的工程量拿到绝大部分收益，且是纯增量（additive）：不标 reset 的工作流行为零变化。

与 ralph-flow-pi 的关系：pi 版"每步全新会话"等价于本方案的 `auto_reset: true`。
本方案粒度更细（只在重步骤前换）。v2.7.2 起重试也换新会话（pi 版每步重试同样是新会话）。

---

## 2. YAML 设计

```yaml
description: 规格驱动开发

# 方式一：工作流级（可选）——等价给所有步骤标 reset，进入任何步骤（含失败重试）都换新会话
auto_reset: true          # 缺省 false

steps:
  - id: propose
    ...

  - id: implement
    desc: 实现
    reset: true           # 方式二：步骤级（可选）——进入本步 DO 前换新会话
    do: ...
    input: ...
    output: ...
    check: ...
    on_pass: verify
    on_fail: implement
    max_fail_count: 5
```

- `steps[].reset: boolean`，缺省 false。可标在普通步骤和**子工作流（composite）步骤**上
  （composite 的语义 = "进入子工作流前换会话"，触发点在 push 子工作流栈之前）。
- `auto_reset: boolean`，缺省 false。等价于给所有步骤标 `reset`，与步骤级语义完全一致
  （v2.7.2 统一；早期版本仅跨步骤转换触发）。
- 两字段对 Claude 版插件完全兼容：其 `parseWorkflowFile` 透传未知字段，旧 YAML 不加字段行为不变。
- doctor（lintWorkflow）新增提示：
  - `reset`/`auto_reset` 非 boolean → 校验错误（与其他字段同级处理）；
  - `auto_reset: true` 且无任何步骤 `on_fail` 指向他步 → 信息级提示（纯线性流每次失败重试也换会话，成本提示）；
  - 无需禁止任何组合。

## 3. 已验证技术事实（实施前必读，勿重复验证）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `client.session.create({body:{parentID}})` 创建的子会话，`await client.session.prompt(...)` 会阻塞到**多轮工具调用全部完成**，返回后 `session.messages` 可读回最终文本；`session.children` 可列出会话树 | spike 实测（opencode 1.18.5，SDK 1.17.17）：一次 prompt 内模型完成 write+bash 两次工具调用并输出 `<promise>done</promise>`，61.5s 返回，文件真实落盘 |
| F2 | 插件 `event` 钩子与 SDK 事件订阅收全事件总线：`message.part.updated`（带 sessionID+part+delta）、`session.status`、`session.idle` 等 | SDK 类型 `EventMessagePartUpdated`/`EventSessionStatus`（types.gen.d.ts:354/602） |
| F3 | `permission.ask` 钩子的 input 带 `sessionID`，插件可识别并 `output.status="allow"` 放行；无人应答时该会话挂起，`POST /session/{id}/permissions/{permissionID}`（SDK `postSessionIdPermissionsPermissionId`，body `{response:"once"|"always"|"reject"}`）可代答 | SDK 类型 `Permission`（types.gen.d.ts:366）、sdk.gen.d.ts:381 |
| F4 | 权限现状：`permission.ask` 钩子对"拥有活跃实例的会话"auto-allow（index.ts:84-94）。新会话转移 owner 后**自动落入此逻辑，零改动** | src/index.ts |
| F5 | `ralphflow_status`/`ralphflow_cancel` **不** bindInstance；只有 `ralphflow_continue` 会 bind（tools.ts:154）。重置后旧会话里调 status/cancel **不会抢回 owner**；continue 接管是既有显式语义，保留 | src/tools.ts:332,349 |
| F6 | server 端可直接调 `client.tui.showToast()/openSessions()/executeCommand({command})` 控制已连接 TUI；但 executeCommand 无参数，**不能精确跳转到指定会话**（命令列表只有 session.new/next/previous） | sdk.gen.d.ts:328-368；二进制命令字符串 |
| F7 | TUI 精确跳转需要 TUI 插件入口：`route.navigate("session", {sessionID})`；TUI 插件的 `event` 总线可直接订阅 `session.created`——**不需要 server→TUI 跨进程通信** | @opencode-ai/plugin/dist/tui.d.ts:472,407 |
| F8 | 插件包可同时提供 server 与 tui 两个入口：package.json `exports["./tui"]`（npm 插件必须显式声明，否则 TUI 端不加载）；**单个入口文件** default export 不允许同时含 server 和 tui（加载器强制） | opencode 二进制内插件加载器源码（`vJ`/`lJ`/`rQ` 函数） |
| F9 | 项目级插件自动发现目录：`.opencode/{plugin,plugins}/*.{ts,js}` | 同上（`cJ` 函数） |
| F10 | 新会话模型延续：`readOwnerSessionModel`（check.ts:124）读旧会话最近 user 消息的 model，传给新会话首个 prompt 的 `body.model`——check.ts 已证明 `session.prompt` body 支持 model 字段；promptAsync 同路径 | src/check.ts:124-138,245-253 |
| F11 | DO 提示自包含：`buildDoPrompt(instId, step, userTask, retryContext?, retryCount?)` 含任务/输入/输出/产出目录/失败原因，不依赖会话历史——新会话冷启动无损 | src/engine.ts:1297,1786,1898 |

**唯一未跑过运行验证的路径**（机制已从源码确认，留 smoke test）：
- V-a：TUI 插件入口真实加载 + `route.navigate` 效果（§6 阶段二交付后人工验证）；
- V-b：`tui.showToast` 在无 TUI 连接（headless）时的行为——实现时 try/catch + 短超时包裹即可，不阻塞主流程；
- V-c：`promptAsync` 驱动插件自建会话（F1 验证了阻塞 `prompt`；`promptAsync` 仅是不等返回，现有代码对所有会话均用它，风险低）。

## 4. 详细设计

### 4.1 触发规则（核心，一张表）

> **一条规则：标了 `reset` 的步骤，任何方式进入都触发（含 on_fail 回本步的重试）；`auto_reset` = 给所有步骤标 `reset`，语义完全一致，没有第二种豁免。**

理由：重试需要现场记忆，但那是**轻量步骤**的假设——重量级步骤一次 DO 就把
上下文撑爆，重试时现场记忆的收益小于膨胀的损失；失败原因（retryContext）
走文本通道（F11）注入 DO 提示，同步骤重置不丢现场。未标 `reset` 的步骤
重试不触发，轻量任务保留现场。（v2.7.2 起 `auto_reset` 与 `reset` 统一，
避免两种豁免规则分叉；纯线性流配 `auto_reset` 的成本由 doctor 提示兜底。）

| 场景 | 转换 | 触发 | 说明 |
|---|---|---|---|
| A fail → on_fail: A（重试，A 未标 reset） | 同步骤 | ❌ | 轻量步骤保留现场；fail_count 同段累计（≤max_fail_count 次，污染有限） |
| A fail → on_fail: A（重试，A 标 reset） | 同步骤 | ✅ | 重量级步骤换干净上下文；失败原因随 buildDoPrompt 注入新会话 |
| A fail → on_fail: A（重试，auto_reset 流） | 同步骤 | ✅ | 与 reset 一致 |
| C fail → on_fail: A（回炉，A 标 reset） | 跨步骤 | ✅ | 失败原因随 buildDoPrompt 注入新会话 |
| A pass → B（B 标 reset） | 跨步骤 | ✅ | 正常前进 |
| 进入子工作流步骤 S（S 标 reset） | 跨步骤 | ✅ | push 子工作流栈之前换会话 |
| max_failures 暂停 → continue 恢复重试 | 同步骤 | ❌ | **关键**：暂停期间用户在会话里的指导是有价值上下文，绝不能自动重置；想干净重试用 `/ralphflow-reset` 手动 |
| manual gate 审查通过 → CHECK → 下一步（标 reset） | 跨步骤 | ✅ | 审查发生在旧会话，CHECK 是独立会话（不受影响），通过后进新会话 |
| check_error 暂停 → continue 重跑验证 | 无步骤转换 | ❌ | 仅重跑 CHECK |

### 4.2 实现落点：全部在注入层，engine 状态机零改动

**关键设计决策**：reset 判断不放进 `handleCheckPassed`/`handleCheckFailed`/`resolveSubWorkflowEntry`。
这三个函数与 Claude 版镜像（SYNC.md 约束），保持纯净。它们照常只返回 `TransitionResult.text`。

判断与执行放在**注入层**（driver.ts / tools.ts），即"拿到 transition text 之后、注入之前"：

```
engine 纯函数：
  shouldResetOnTransition(workflow, sourceStepId, targetStepId): boolean
    = workflow.auto_reset === true
        || getStep(workflow, targetStepId)?.reset === true
    // 统一语义：auto_reset = 给所有步骤标 reset。任何方式进入标 reset 的
    // 步骤都触发，含同步骤重试；未标 reset 的步骤重试保留现场。
```

v2.7.2 语义统一：`auto_reset` 从"仅跨步骤"改为与步骤级 `reset` 完全一致
（任何方式进入都触发，含 on_fail 回本步的重试）。注入层的
`runCheckAndAdvance` guard 相应放宽：同步骤转换（失败重试）不再被跳过，
照常过 `shouldResetOnTransition`。continue（max_failures/check_error 恢复）
是手动路径，不经过重置门，行为不变。

注入层共有三处转换文本出口，全部汇到同一个执行函数：

1. `driver.ts runCheckAndAdvance` 末尾（line ~224）：`injectPrompt(client, sessionId, result.text, ...)`
2. `tools.ts ralphflow_continue` DO 恢复路径（line ~231/276/305 的 buildDoPrompt 注入）
3. `tools.ts ralphflow_start`（line ~121，首步标了 reset 时——见 §4.6 讨论）

统一执行函数（新增，建议放 driver.ts）：

```ts
/**
 * 重置门执行：创建新会话、转移 owner、旧会话告别、新会话注入 DO 提示。
 * 返回 true 表示已走重置路径（调用方不再向旧会话注入 transitionText）。
 */
export async function executeContextReset(
  client: Client,
  engine: Engine,
  instId: string,
  oldSessionId: string,
  transitionText: string,          // 转换结果全文（检查结果+下一步+DO 提示，自包含）
  opts?: { navigate?: boolean }
): Promise<boolean>
```

**owner 转移时序（必须严格按序，否则驱动权落空）**：

```
1. （调用方已完成）状态机写好新 state（current_step=目标步），markers 照常
2. readOwnerSessionModel(client, oldSessionId)   ← 趁旧会话还在，取模型
3. client.session.create({ body: { title: `🔄 ${workflow} · ${targetStep}`, parentID: oldSessionId } })
4. engine.claimOwnership? —— 用 writeState 把 state.session_id 改为新会话
   （复用 claimOwnership(instId, newSessionId)；此后旧会话 idle 被 owned 过滤天然静默，
     新会话 idle 开始驱动——现有 handleSessionIdle 逻辑零改动）
5. 旧会话：injectPrompt(告别消息, noReply=true)
6. 新会话：injectPrompt(transitionText, noReply=false, model=上一步读的模型)
   —— promptAsync 发出即驱动，模型开始干活
7. 尽力而为：client.tui.showToast({...})（catch 吞掉，headless 容错）
8. 记日志：engine.logEvent(instId, "info", "context_reset", {from, to, step})
```

新会话 title 约定前缀 `🔄` + 工作流名——TUI 插件靠它识别并自动跳转（§4.3），
用户在会话列表也能一眼认出。

**index.ts 的 `session.deleted/error` 处理**：新会话被删/abort → `handleSessionGone` 按 owner
匹配暂停实例（现有逻辑，零改动）；用户从任何会话 `/ralphflow-continue` 接管（现有逻辑）。

### 4.3 用户可见性（三层降级，逐层可选）

| 层 | 机制 | 依赖 | 交付阶段 |
|---|---|---|---|
| L0 文本 | 旧会话告别消息（含新会话 title）+ 新会话完整转换文本 | 无 | 阶段一 |
| L1 toast | `client.tui.showToast("工作流已在干净会话继续")` | server 端 SDK，TUI 连接时生效 | 阶段一（try/catch 容错） |
| L2 自动跳转 | TUI 插件入口订阅 `session.created`，title 前缀匹配 → `route.navigate("session",{sessionID})` | `exports["./tui"]` 新入口 | 阶段二 |

L2 的 TUI 入口骨架（`src/tui.ts`，独立文件，与 server 入口分离——F8）：

```ts
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

export default {
  id: "ralph-flow",
  tui: async (api) => {
    api.event.on("session.created", (evt) => {
      const info = (evt as any).properties?.info;
      if (info?.title?.startsWith("🔄") && info?.parentID) {
        api.route.navigate("session", { sessionID: info.id });
        api.ui.toast({ variant: "info", message: "工作流已在干净上下文中继续" });
      }
    });
  },
} satisfies TuiPluginModule;
```

package.json 增加：

```json
"exports": {
  ".": "./dist/index.js",
  "./tui": "./dist/tui.js"
}
```

（`tsc` 编译 src/tui.ts → dist/tui.js；`files` 字段已含 dist/，无需改。）

### 4.4 引擎改动清单（精确到函数）

| 文件 | 改动 | 量 |
|---|---|---|
| engine.ts `NormalStepDef`/`SubWorkflowStepDef` | 加 `reset?: boolean` | 2 行 |
| engine.ts `WorkflowDef` | 加 `auto_reset?: boolean` | 1 行 |
| engine.ts `parseWorkflowFile` | 校验两字段为 boolean（非 boolean → problems 报错，与其他字段同级）；step 透传 `reset` | ~15 行 |
| engine.ts 新增 `shouldResetOnTransition`（纯函数）+ 导出 | 见 §4.2 | ~10 行 |
| engine.ts `lintWorkflow` | §2 的 doctor 提示 | ~15 行 |
| engine.ts Engine 接口/返回对象 | 导出 `shouldResetOnTransition` | 2 行 |
| driver.ts 新增 `executeContextReset` + runCheckAndAdvance 末尾接线 | §4.2 | ~70 行 |
| driver.ts `injectPrompt` | body 增加可选 `model` 透传 | ~5 行 |
| check.ts | `readOwnerSessionModel` 改为 export（现私有） | 1 行 |
| tools.ts `ralphflow_continue` | 三处 buildDoPrompt 注入点汇到 executeContextReset 判断 | ~20 行 |
| tools.ts 新增 `ralphflow_reset` 工具 | 手动重置：当前 DO 阶段中途也可触发——见 §4.5 | ~40 行 |
| commands.ts | `/ralphflow-reset` slash 命令注册 | ~10 行 |
| index.ts | 无改动（permission.ask/session 事件均自动覆盖新会话） | 0 |
| src/tui.ts 新建 + package.json exports + tsconfig | §4.3 | ~30 行 |

### 4.5 手动重置 `/ralphflow-reset`（新工具）

用户感觉当前会话脏了，随时手动换。语义：**立即**换会话，当前步骤 DO 在新会话里重来
（用 `.do-prompt-cache` 里的缓存提示 + `last_failure_reason`，与 idle keep-alive 的
nudge 同源，保证自包含）。

```
ralphflow_reset 执行：
  1. resolveInstance（须 owner 是本 session，否则报"属主是别的会话"）
  2. state.current_phase === "do" 才允许（check 阶段有验证在跑，拒绝并提示稍候）
  3. 读 .do-prompt-cache + last_failure_reason 拼提示文本
  4. 走 executeContextReset（与自动门同一函数）
  5. fail_count 不变（state 原样，只换 session_id）
```

边界：DO 阶段模型正在干活时调用 → ~~promptAsync 注入新会话即可，旧会话正在跑的回合
让它自然结束（idle 时被 owned 过滤静默）；不 abort 旧会话（用户可能还想回看完）~~

> **【已修正，见 §9 第 4 条】** 实测证明"自然结束"不符合预期：旧回合继续跑完期间与
> 新会话并发改同一工作区。现改为 owner 转移后立即 abort 旧会话回合。

### 4.6 边界与明确不做的事

- **ralphflow_start 首步标 reset**：启动时首次进入不需要（本来就是用户新开的会话）。
  但**后续步骤失败 `on_fail` 回到首步时仍会触发**——此时旧上下文已被前面步骤的记录撑满，
  reset 是换入干净会话重新开始的好时机。不是"不生效"，而是"只在回退路径生效"。
- **不 abort/删除旧会话**：历史保留，用户随时切回；旧会话里继续聊天是用户自由
  （不再驱动工作流，因为 owner 已转走）。
- **不重置 CHECK 会话**：CHECK 本来就是独立短会话（check.ts），与 reset 无关。
- **agent 延续**：新会话用全局默认 agent（不传 body.agent）。若实现时确认 user message
  info 带 agent 字段，可作为增强延续用户当前 agent；第一版不做。
- **不做进度播报系统、不做消息转发**：重置门架构下用户面前就是干活现场，均不需要。
- **暂停（paused）状态的实例不自动重置**：continue 恢复路径按 §4.1 判定表走
  （max_failures 恢复=同步骤=不触发）。

### 4.7 与 SYNC.md 的关系

- `shouldResetOnTransition` 与 YAML 新字段：工作流逻辑层的**纯增量**，Claude 版
  parseWorkflowFile 透传未知字段，YAML 双向兼容；建议随后同步到 Claude 版（其运行时
  无 SDK 会话，可用"提示用户 /clear 后 continue"的降级语义，或不支持——另行决策）。
- handleCheckPassed/Failed/resolveSubWorkflowEntry 保持镜像不动（§4.2 决策）。
- 实施完成后更新 SYNC.md：注明 reset/auto_reset 为 opencode 原生扩展字段。

## 5. 测试矩阵（vitest，沿用现有 engine.test.ts/driver.test.ts 风格）

**纯函数/解析（engine.test.ts）**
1. `shouldResetOnTransition`：同步骤无标记 false / 同步骤+reset true（v2.7.2 起）/
   跨步骤+reset true / 跨步骤无标记 false / auto_reset 任何转换 true（含同步骤，
   v2.7.2 起）/ composite 步骤 reset true（含同步骤重进）
2. `parseWorkflowFile`：`reset: "yes"`（非 boolean）→ problems 报错；`auto_reset: 1` → 报错；
   合法值透传；缺省字段 undefined
3. `lintWorkflow`：首步 reset 提示；auto_reset 纯线性流信息提示

**driver（driver.test.ts，mock client）**
4. runCheckAndAdvance：通过+目标标 reset → 旧会话收到告别（noReply）、
   新会话收到 transition 全文（含 DO 提示）、state.session_id=新会话、
   旧会话后续 idle 不再驱动、logEvent 有 context_reset
5. 失败+on_fail 回本步（标 reset）→ **创建**新会话，重试提示（含失败原因）注入新会话
   （v2.7.2 起：同步骤重试也触发；旧行为=不创建，轻量步骤未标 reset 时保持）
6. 失败+on_fail 回炉他步（标 reset）→ 创建新会话，重试提示（含失败原因）注入新会话
7. manual gate：审查通过 → CHECK → 通过 → 目标标 reset → 重置发生（告别进旧会话）
8. continue 恢复 max_failures（同步骤）→ 不重置
9. 子工作流入口步骤标 reset → push 前换会话
10. `ralphflow_reset`：do 阶段中途 → 新会话收到缓存 DO 提示+失败原因，fail_count 不变；
    check 阶段调用 → 拒绝；非 owner 调用 → 拒绝
11. 多实例：A 实例重置不影响 B 实例 owner
12. tui.showToast 抛错 → 流程不受影响（catch）
13. 模型延续：mock 旧会话消息含 model → 新会话 prompt body 带同 model；
    无 → 不传（全局默认）

**headless/降级**
14. 无 parentID 场景（ownerSessionId 为 null 的接管实例）→ create 不带 parentID，正常

## 6. 分阶段实施（每阶段独立可交付、可发布）

**阶段零（30 分钟，可选）**：跑 §7 验证脚本，确认 V-c（promptAsync 驱动自建会话）。
不做也行——风险低，失败时阶段一会立刻暴露。

**阶段一（MVP，可发布）**：YAML 字段 + 校验 + `shouldResetOnTransition` +
`executeContextReset` + runCheckAndAdvance/continue 接线 + `/ralphflow-reset` +
L0/L1 可见性 + 测试矩阵全部。**此时功能已完整可用**（手动切会话）。
改动面：engine.ts、driver.ts、tools.ts、commands.ts、check.ts（1 行）。

**阶段二（体验，可单独发布）**：src/tui.ts + exports["./tui"] + L2 自动跳转 +
真实 TUI smoke test（V-a/V-b）。

**阶段三（打磨，可选）**：agent 延续；内置工作流示范（spec 的 implement 标 reset、
everything2rust 标 auto_reset）；SYNC.md/README/docs 更新；CHANGELOG。

**建议内置工作流标注**（阶段三）：
- `loop`（v2.7.2 起单步）：标 `reset: true`——默认每轮失败重试换干净上下文；
  lint 对内置工作流跳过 reset 成本警告（设计决定，无需提示用户）；
- `spec`（7 步）：`implement` 标 `reset: true`——最重的步骤前一刀切；
- `c-to-rust`/`everything2rust`（多步长程）：`auto_reset: true`。

## 7. 附录：已跑通的验证脚本（spike 证据）

F1 的验证脚本保留在 `/tmp/opencode/ralph-spike/v1-core.mjs`（可直接重跑）。
实测输出（2026-07-28，opencode 1.18.5）：

```
[02:52:07] server up: http://127.0.0.1:4199
[02:52:08] model: {"providerID":"opencode-go","modelID":"kimi-k3"}
[02:52:08] parent session: ses_0595cfe5fffePv4AlfqgUidHgT
[02:52:08] child session:  ses_0595cfe24ffebkoLX8YzQhLnY2
[02:53:10] prompt returned after 61.5s
[02:53:10] 判据b 文件已创建: true
[02:53:10] 判据a 多轮工具调用次数: 2 OK
[02:53:10] 判据c done tag: OK
[02:53:10] 判据d session.children: OK
[02:53:10] ==> V1 全部通过
```

V-c（promptAsync 驱动自建会话）验证脚本骨架——把 v1-core.mjs 的 prompt 调用换成：

```js
await client.session.promptAsync({
  path: { id: childId },
  body: { model, parts: [{ type: "text", text: "写文件后输出 <promise>done</promise>" }] },
});
// 然后轮询 client.session.messages({path:{id:childId}}) 直到出现 done tag（超时 120s）
// 判据：文件落盘 + done tag 出现 = promptAsync 驱动成立
```

## 8. 风险登记表

| 风险 | 等级 | 缓解 |
|---|---|---|
| TUI 插件入口真实行为与源码解读有出入（V-a） | 低 | 阶段二才依赖；L0/L1 已够用；smoke test 兜底 |
| `tui.showToast` headless 行为未知（V-b） | 低 | try/catch + 不 await 其结果 |
| promptAsync 驱动自建会话（V-c） | 低 | F1 已证同族 API；阶段零脚本兜底 |
| 用户在旧会话 `/ralphflow-continue` 把 owner 抢回 | 设计内 | 既有显式接管语义，保留；文档注明"想回旧会话继续就这样做" |
| auto_reset 每步换会话的 token 成本（每步重建现场） | 用户选择 | doctor 信息提示；默认 false；工作流作者自负 |
| 新会话被用户手动删除 → 实例暂停 | 已覆盖 | 现有 handleSessionGone + continue 接管链路 |
| Claude 版不同步导致 YAML 语义分叉 | 低 | 字段纯增量透传兼容；SYNC.md 登记 |

---

## 9. 实施后修正（2026-07-28，实测 aitest 后）

**§1 对比表的"用户可见性：天然可见"假设被推翻，parentID 决策撤回。**

实测（opencode 1.18.5 + aitest 项目）发现 reset 会话创建后用户在 `/session` 列表里
根本看不到它、TUI 也不跳转——工作流在后台隐藏会话里跑完全程，用户视角"什么也没发生"。
三个叠加原因：

1. **`parentID` 子会话被所有会话列表过滤**。TUI 源码实证：
   `packages/tui/src/component/dialog-session-list.tsx`（两处 `.filter((x) => x.parentID === undefined)`）、
   `packages/app/src/context/global-sync/home-session-index.ts`（`if (item.parentID || ...) return []`）、
   `packages/app/src/pages/layout/helpers.ts`（同条件）。§1 假设"DO 还在用户面前的会话里"不成立——
   子会话恰恰是为了 subagent 隐藏而设计的。check.ts 的验证器会话用 parentID 是对的（临时、用后即删），
   reset 会话是工作流的长期新家，必须可见。
2. **L2 自动跳转（src/tui.ts）在 file 插件形态下从未加载**。`~/.config/opencode/plugins/ralph-flow.ts`
   是单文件 server 入口；TUI 端按 `kind: "tui"` 解析时入口直接是该文件本身（无 package.json →
   `resolvePluginEntrypoint` 原样返回），`readV1Plugin(..., "tui")` 要求 default export 含 `tui()` 而抛错，
   静默失败（加载器同时强制"单文件 default 不能同时含 server 和 tui"）。npm 包形态（exports["./tui"]）不受影响。
3. **`showToast` 少了 hey-api v1 的 `body` 包装**（`{variant, message}` 直传 → 空请求体 → 400 静默），L1 也失效。

**修正（已全部落地）**：

- `executeContextReset` 创建会话**不再传 `parentID`**（顶级会话，列表天然可见）；
- 创建后由 **server 端直接 `tui.publish({ type: "tui.session.select", ... })`** 请求 TUI 跳转——
  不依赖 TUI 插件加载链，server→事件总线→TUI 订阅（app.tsx `route.navigate`），老服务端拒绝时静默降级。
  这条主路径对 npm 安装与 file 形态同样有效；
- `showToast` 修正为 `{ body: {...} }`；
- src/tui.ts 匹配条件同步改为 `!info?.parentID`，作为冗余跳转路径：npm 形态经
  `exports["./tui"]` 自动加载（安装即用）；file 形态（本地克隆部署）需在 `plugins/` 下
  额外放一个 re-export `dist/tui.js` 的入口文件（README 安装节已补说明）。

F6 的结论同时更新：1.18.5 起 server 端可通过 `tui.session.select` 事件（或 v2 SDK 的
`client.tui.selectSession`）精确跳转指定会话，不再需要 TUI 插件入口——但 v1 SDK 客户端未封装该
endpoint，需走 `tui.publish`。

4. **"旧回合自然结束"决策（§4.5 边界）撤回**：owner 转移只阻止旧会话被再次驱动，正在跑的
   回合会自然跑完——`/ralphflow-reset` 的工具调用本身就跑在旧会话的活跃回合里，回合继续期间
   与新会话并发改同一工作区（实测复现：用户 reset 后旧会话仍在执行）。修正：owner 转移后
   立即 `session.abort` 旧会话。**顺序是硬约束**——abort 触发 `session.error(MessageAbortedError)`
   → `handleSessionGone` 暂停"owner=该会话"的实例；先转移再 abort，旧会话的 abort 匹配不到
   实例，实例不受波及。自动门路径（CHECK 通过后）旧会话无活跃回合，abort 为无害空操作。
   （未修：`ralphflow_cancel`/`continue` 接管后旧会话回合同样会自然跑完，但无新会话并发接管，
   只是浪费 token，语义可接受。）
5. **新会话首条注入增加「会话交接说明」头**：transitionText 的口吻是写给经历过全程的旧会话
   模型的（开门见山"检查结果：通过"），冷启动模型缺"我为什么在这里"的上下文。简报头提供：
   reset 门接手说明、工作流进度（步骤列表 + 当前位置 + check passed 的 ✓ 标记，来自
   `loadStepRecords`）、artifacts 产出目录（之前的产出直接读取、不要重做）、done 标记约定。
   实现于注入层（`buildResetBriefing`，driver.ts），engine 状态机文本构造不动（§4.2 镜像约束）。
6. **嵌套工作流的 reset 判定修复**（§4.1 表格"进入子工作流步骤 S（S 标 reset）✅"原本
   未兑现）：进入子工作流时 `handleCheckPassed` 已把 state 推进到子工作流内部第一步，
   reset 门拿 (父步骤 → 子工作流第一步) 在**子工作流**里查标记，composite 步骤上的
   `reset` 与父工作流的 `auto_reset` 永远读不到；fail 回炉重进同一子工作流时首尾状态
   甚至完全相同（child/sub1 → child/sub1），连"跨步骤"前置条件都不满足。§4.2"判断全放
   注入层、状态机零改动"在嵌套场景信息不足——修正为 `TransitionResult` 挂可选元数据
   `enteredCompositeStepId`（状态机行为不变，Claude 版可忽略，SYNC.md 已登记），reset 门
   优先按它在 composite 步骤所属工作流判定；常规转换（含子工作流完成回父级普通步骤）
   走原 `shouldResetOnTransition` 路径。新增 4 个嵌套 reset 测试（pass 进入 / auto_reset
   进入 / 无标记不触发回归 / fail 回炉重入）。
