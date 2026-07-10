# 预言（Oracle）采集策略——按接口形态分节

## 目录
- 通用原则
- CLI 工具
- Web 服务 / 网络协议
- 库 / SDK
- 文件格式 / 数据管道
- 游戏
- GUI 应用
- 不确定性行为的归一化

## 通用原则

- 语料 = 真实运行原系统的产物。采集脚本本身留在 `golden/<cap-id>/capture.sh`（或 .py），语料过期时可重跑。
- 输入样本优先取自项目自带的 fixtures/examples/docs——它们是作者认可的典型用法。
- 每组语料记录：精确输入（含环境变量、工作目录）、精确输出（stdout/stderr 分开、退出码、产生的文件）。

## CLI 工具

采集：对每组参数/stdin 组合执行原程序，记录 stdout、stderr、exit code、生成的文件。

```bash
mkdir -p cases/1 && cd cases/1
echo '<stdin 内容>' > input.txt
<original-cmd> --flag value < input.txt > stdout.txt 2> stderr.txt; echo $? > exit_code.txt
```

覆盖：无参数（用法提示）、`--help`/`--version`、正常任务、非法参数、不存在的输入文件、空输入、超大输入。
Rust 侧 harness 用 `assert_cmd` 重放同样的调用并逐项比对。

## Web 服务 / 网络协议

采集：启动原服务，用 curl 对每条路由发请求，记录 status/headers/body。

```bash
curl -s -D headers.txt -o body.json -w '%{http_code}' http://localhost:PORT/path -X POST -d @req.json
```

覆盖：每条路由的 2xx、4xx（缺字段/非法值/未授权）、边界（空列表、分页尾页）。
headers 只保留契约相关项（Content-Type、缓存策略），剥离 Date/Server 等噪音。
有外部依赖（下游服务、第三方 API）时录制其交互，Rust 测试用 wiremock 重放。
数据库状态是副作用的一部分：请求前后的关键表快照也算输出。

## 库 / SDK

采集：用**源语言**写 driver 脚本，调用公开 API，把输入输出序列化为 JSON。

```javascript
// golden/cap-parse/capture.mjs
import { parse } from '../../src/index.js';
const cases = [/* 输入样本 */];
console.log(JSON.stringify(cases.map(input => {
  try { return { input, output: parse(input) }; }
  catch (e) { return { input, error: { type: e.constructor.name, message: e.message } }; }
}), null, 2));
```

异常也是输出——记录异常类型和关键信息（Rust 侧映射为 Err 变体）。
返回值含函数/闭包/复杂对象时，序列化其可观察投影（调用结果、关键字段），并在 meta.json 注明投影规则。

## 文件格式 / 数据管道

- **读**：收集真实样本文件（项目 fixtures、原系统生成的输出），语料 = 样本 + 原系统解析后的规范化 dump。
- **写**：原系统生成的文件即 expected；若格式含时间戳/随机 id，记录归一化规则。
- **互通是硬契约**：Rust 写的文件原系统能读、原系统写的 Rust 能读。采集双向样本。
- round-trip（parse→serialize→parse 恒等）是天然 property 策略，优先叠加。

## 游戏

核心手法：**把模拟（simulation）从呈现（presentation）中剥离**。

- **确定性模拟**：固定 seed + 固定 timestep 下，"初始状态 + 输入序列 → N 帧后的游戏状态"是确定的。采集：在原游戏中注入/录制输入序列，dump 关键状态（位置、血量、分数、库存）为 JSON。这是游戏逻辑的 golden 语料，覆盖游戏规则、物理、AI 决策。
  - 原游戏没有 headless 模式时，写一个薄的 driver 直接调用其更新函数（跳过渲染），或在渲染入口打桩。改装原代码用于采集是允许的——改装只为观测，不改变逻辑，并在 meta.json 记录改了什么。
- **存档/配置/资产格式**：按"文件格式"一节处理，互通为硬契约。
- **呈现层（渲染、音频、手感）**：checklist 策略。清单写具体："角色移动方向与方向键一致"、"受击有音效"、"60fps 下无可见卡顿"，并注明验证方法（运行游戏人工核对/录屏）。
- **性能**：若原游戏有帧率目标，把它写进契约（如"1000 实体场景 ≥60fps"），Rust 侧用 criterion/手动计时验证。

## GUI 应用

- 把**应用逻辑**（文档模型、编辑操作、撤销栈、文件 IO）从视图剥离，逻辑部分按"库"策略采集：操作序列 → 模型状态。
- 视图部分 checklist：界面元素齐全、菜单项行为、快捷键映射。
- 文件格式互通同上（用户的旧文件必须能打开）。

## 不确定性行为的归一化

| 来源 | 对策 |
|------|------|
| 时间戳 | 冻结时钟采集（faketime/mock），或比对前剥离 |
| 随机数 | 固定 seed 采集；Rust 侧契约改为"接受 seed 参数"并记入 parity_exceptions 候选 |
| 无序集合 | 比对前排序 |
| 浮点 | 容差断言（相对误差 1e-9 起，按领域调整并记录理由） |
| 并发调度 | 契约只锁定顺序无关的最终状态；顺序敏感的行为单独写不变量 |
| 机器路径/主机名 | 采集时用固定沙箱路径，比对前替换为占位符 |

归一化规则写进 behavior-spec.md 对应能力的契约里，test-gen 按规则实现 harness 的 normalize 函数。
