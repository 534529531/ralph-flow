---
name: everything2rust-survey
description: 勘察任意语言的源项目：探测语言/领域/构建/测试/运行方式，安装源运行时让原系统真实跑起来，提取能力清单。产出 system-map.md、capabilities.md、oracle-evidence.md。在 everything2rust 工作流的 survey 步骤触发。
---

你是接手陌生代码库的工程师。源项目可能是任何语言、任何领域——CLI 工具、库、Web 服务、游戏、GUI 应用、数据管道。目标：搞清楚它**是什么**、**能做什么**、**怎么跑起来**。后续所有步骤都建立在这份勘察之上：行为契约以能力清单为纲，验收以"原系统的真实行为"为预言（oracle）。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：源项目路径（从用户任务描述中提取）
- 输出（均写入 `<产出目录>/`）：
  - `system-map.md` — 系统全貌：语言、领域、构建/测试/运行、外部接口、依赖
  - `capabilities.md` — 能力清单：重构的等价单位
  - `oracle-evidence.md` — 原系统可运行的实证（真实命令输出）

## 核心原则

- **先探测再假设** — 语言、目录布局、构建系统、测试框架都从项目实际情况探测，不套模板
- **让它跑起来是硬任务** — 原系统是行为等价的唯一权威预言；这一步要实际安装运行时、实际构建、实际运行、实际跑测试，把输出留证
- **能力是等价单位，不是函数** — 能力 = 一个外部可观察的行为闭环（"解析配置文件并报错到 stderr"、"存档/读档"、"处理 POST /orders"），Rust 侧允许用完全不同的内部结构实现它
- **接口是能力的权威来源** — CLI 参数、HTTP 路由、公开 API、文件格式、UI 交互，每个外部接口背后都是能力

## 执行流程

### 1. 探测语言与领域

统计源文件扩展名分布、读 manifest（package.json / pyproject.toml / go.mod / pom.xml / *.csproj / Gemfile / CMakeLists.txt / …）、读 README。判定：

- **languages**：主语言 + 次要语言（构建脚本、嵌入的 DSL 不算主语言）
- **domain** ∈ {cli, library, web-service, game, gui, data-pipeline, systems}：看入口形态（main 循环？HTTP 监听？导出 API？渲染循环？）。混合领域取主形态并在 system-map 说明

### 2. 探测构建/测试/运行方式

从 manifest 的 scripts/targets、CI 配置（.github/workflows 等）、README 中提取：`build_cmd`、`test_cmd`、`run_cmd`。CI 配置往往是最可靠的来源——它是被机器验证过的。

### 3. 让原系统真实跑起来（产出 oracle-evidence.md）

按探测结果安装源语言运行时（node/python/go/jdk/dotnet/…，缺则装），然后**实际执行**：

1. 构建 → 记录输出尾部
2. 运行（用探测到的 run_cmd；服务类启动后 curl 健康检查；游戏/GUI 类尝试 headless/`--version`/`--help`，起不了窗口就记录到什么程度）
3. 跑测试套件 → 记录通过/失败统计

把每步的**真实命令和真实输出片段**写入 oracle-evidence.md。这不是形式主义——spec 步骤要靠运行原系统采集 golden 语料，这里验证的就是"采集通道是通的"。

原系统确实跑不起来时（缺私有依赖、平台不兼容、代码本身损坏）：如实记录卡点和已尝试的方案，并明确替代预言来源（已有测试套件？文档？样例数据？），让 spec 步骤知道从哪取判据。不要伪造输出。

### 4. 提取外部接口清单

按领域用对应手段枚举：

| 领域 | 接口形态 | 探测手段 |
|------|---------|---------|
| cli | 子命令/flag/stdin/退出码 | 跑 `--help`、读 argparse/clap/commander 定义 |
| library | 公开 API | 读导出声明（export/pub/public）、类型定义、文档 |
| web-service | 路由/方法/请求响应体 | 读路由注册代码、OpenAPI 文件 |
| game | 输入操作/游戏规则/存档格式/资产 | 读输入处理、游戏状态更新逻辑、序列化代码 |
| gui | 界面操作/菜单/快捷键/文件格式 | 读事件处理器、菜单定义 |
| data-pipeline | 输入输出格式/CLI 参数/配置 | 读 IO 层、schema 定义 |

外加通用项：读写的文件格式、环境变量、配置文件、网络协议、数据库 schema、信号处理。

### 5. 归纳能力清单（capabilities.md）

把接口清单归纳为能力列表。每条能力：

```markdown
## cap-save-load — 存档与读档
- **行为**：游戏状态可序列化到存档文件，重新载入后完全恢复（关卡进度、物品、位置）
- **接口**：菜单"保存/载入"；存档文件 `saves/*.dat`（自定义二进制格式）
- **源码**：src/save.ts, src/serialization.ts
- **依赖能力**：cap-game-state
```

粒度标尺：一条能力应当能用 1-5 个验收测试判定"做到了没有"。逐函数罗列太细（那是 c-to-rust 的做法），"实现整个游戏"太粗。典型项目 10-40 条。内部纯技术设施（日志、连接池）不单列能力——它们是实现细节，被外部行为间接覆盖。

### 6. 写出 system-map.md

```markdown
# System Map: <项目名>
## 概览          — 一段话：这是什么、给谁用、核心价值
## 语言与规模    — languages、代码行数分布、探测依据
## 领域判定      — domain 及理由
## 构建/测试/运行 — build_cmd / test_cmd / run_cmd（均已实际验证，见 oracle-evidence.md）
## 外部接口清单  — 第 4 步的完整结果
## 依赖清单      — 直接依赖及其角色（框架/引擎/工具库），标注哪些是架构级依赖（Rust 侧必须选型替代）
## 架构速写      — 主要模块和数据流（一段话 + 简单列表，供 design 参考，不必详尽）
## 风险与特殊性  — 动态特性重度使用、平台绑定、并发模型、性能敏感点、原系统已知 bug
```

## 完成标准

- system-map.md 各节完整，构建/测试/运行命令经过实际验证
- oracle-evidence.md 含真实命令输出；跑不起来时有卡点记录和替代预言来源
- capabilities.md 覆盖外部接口清单每一项，每条能力有行为描述 + 源码位置 + 接口
- 能力粒度符合标尺（每条可用 1-5 个验收测试判定）
- 三个文件写入 `<产出目录>/`
