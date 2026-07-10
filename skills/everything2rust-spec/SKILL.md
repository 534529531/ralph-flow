---
name: everything2rust-spec
description: 为源系统的每个能力定义行为契约（输入/输出/副作用/不变量/错误路径），选定预言策略，运行原系统采集 golden 语料。产出 behavior-spec.md 和 golden/ 语料库。在 everything2rust 工作流的 spec 步骤触发。
---

你是规格工程师。上一步（survey）搞清了系统有哪些能力；这一步定义**每个能力必须保留的可观察行为**，并把判据物化成可执行的语料。行为契约是整个重构的宪法：design 以它为约束、test-gen 把它变成测试、audit 和 verify 拿它当判决标准。

关键立场：契约描述**外部可观察什么**，绝不描述**内部怎么实现**。"调用 parseConfig() 再调用 validate()"不是契约；"给定含未知字段的配置文件，警告到 stderr 并继续，退出码 0"才是。这条界线就是 Rust 侧获得架构自由的来源——everything2rust 不做函数一比一复刻，靠的就是把等价性锚定在行为而非结构上。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：`<产出目录>/capabilities.md` + `system-map.md` + `oracle-evidence.md` + 源项目
- 输出：
  - `<产出目录>/behavior-spec.md` — 逐能力的行为契约
  - `<产出目录>/golden/` — 从原系统实际采集的输入→输出语料

## 预言策略（每个能力选一个主策略）

判据从哪来，按可靠性排序：

| 策略 | 适用 | 判据形态 |
|------|------|---------|
| **ported-tests** | 原系统有覆盖该能力的测试 | 移植原测试的断言语义 |
| **golden** | 能力行为确定、可离线重放 | 采集的输入→输出对，Rust 测试直接比对 |
| **differential** | 原系统可运行且行为复杂难穷举 | 测试时同时跑两个系统比对（原系统作为运行时预言） |
| **property** | 存在不变量（round-trip、幂等、守恒） | proptest 性质断言 |
| **checklist** | 自动判定不可行（渲染效果、手感、音频） | 人工核对清单，逐条写明验证方法 |

选择规则：能用上面的绝不用下面的；一个能力可以叠加次策略（golden 主 + property 辅很常见）；checklist 是最后手段，每次使用都要写明**为何无法自动判定**。全项目 checklist 占比过高（>1/3）说明能力拆分有问题——把"渲染画面"类能力拆出可自动判定的确定性核心（布局计算、状态更新），checklist 只留纯感官部分。

各领域的采集技巧（CLI/HTTP/库/文件格式/游戏/GUI/不确定性行为的处理）见 **[references/oracle-strategies.md](references/oracle-strategies.md)**——动手采集前先读对应领域的小节。

## 执行流程

### 1. 逐能力写行为契约

behavior-spec.md 中每个能力一节：

```markdown
## cap-save-load — 存档与读档
- **预言策略**：golden（主）+ property（round-trip 辅）
- **输入空间**：任意合法游戏状态；损坏的存档文件；旧版本存档
- **输出/副作用**：写 saves/<slot>.dat；载入后状态逐字段恢复
- **错误路径**：文件损坏 → 弹提示不崩溃、不覆盖原文件；磁盘满 → 报错保留旧档
- **不变量**：save→load round-trip 恒等；load 不修改磁盘
- **边界**：空存档槽、并发保存、超长玩家名
- **golden 语料**：golden/save-load/（5 个状态样本 + 对应 .dat 文件）
```

错误路径和边界不是可选项——它们是重构中最容易丢失的行为，也是 audit 步骤的重点核对对象。对照源码逐条确认，不要想当然。

### 2. 采集 golden 语料

对 golden/differential 策略的能力，**实际运行原系统**采集输入→输出对，存入 `golden/<cap-id>/`。每个语料目录带 `meta.json`：

```json
{
  "capability": "cap-save-load",
  "captured_by": "cd /abs/source && npm run cli -- save --slot 1 < fixtures/state1.json",
  "captured_at": "2026-07-02",
  "source_version": "<git sha 或版本号>",
  "cases": [{ "input": "cases/1/input.json", "expected": "cases/1/expected.dat", "notes": "" }]
}
```

`captured_by` 必须是真实执行过的命令——语料要可复现、可被 CHECK 抽查。禁止手写"我认为的输出"充当语料；判据造假会让后面所有步骤在错误的靶子上收敛。

语料覆盖度：每个能力至少覆盖 happy path、一条错误路径、一个边界值。行为空间大的能力多采几组（解析器类建议 10+）。

### 3. 处理不确定性

时间戳、随机数、并发调度、浮点误差会让 golden 比对失效。对策记入契约的"归一化规则"：注入固定 seed／冻结时钟重新采集；输出先归一化（剥离时间戳、排序无序集合）再比对；浮点用容差断言。归一化规则本身是契约的一部分——test-gen 会照着实现 harness。

### 4. 交叉核对

写完后过一遍：每个能力都有契约？每个 golden 能力都有语料目录？错误路径都对照过源码？原系统的已知 bug 按"bug 也是行为"处理——默认如实记录并保留等价行为，确要修复的不在这里决定，标注出来留给 design 的 parity_exceptions 裁决。

## 完成标准

- behavior-spec.md 覆盖 capabilities.md 全部能力，无 TBD
- 每个能力有预言策略、错误路径、边界、不变量
- golden/differential 能力在 golden/ 有带 meta.json 的语料，captured_by 可复现
- checklist 能力占比 < 1/3，每个都写明不可自动判定的原因
- 不确定性行为有归一化规则
