# 领域 Playbook——按 system-map 的 domain 读对应一节

## 目录
- CLI 工具
- 库 / SDK
- Web 服务
- 游戏
- GUI 应用
- 数据管道 / 科学计算
- 系统工具 / 底层

每节给出：默认技术栈（有充分理由才偏离）、架构形态、测试策略要点、领域坑。crate 选择原则统一：优先 std；引 crate 前查维护状态（最近发布时间、下载量、开 issue 情况）；同类只选一个。

## CLI 工具

- **栈**：clap（derive 风格）+ anyhow（bin 层错误）+ thiserror（lib 层错误）；彩色输出 owo-colors；进度条 indicatif（原系统有才加）
- **架构**：薄 `main.rs`（参数解析+错误呈现）+ `lib.rs`（全部逻辑）。逻辑放 lib 是测试策略的前提——单元测试测 lib，assert_cmd 测二进制
- **测试**：golden 语料直接用 assert_cmd 重放（args/stdin → stdout/stderr/exit code）；退出码和 stderr 格式是契约的一部分
- **坑**：原系统的 shell 交互细节（管道行为、TTY 检测、信号处理、locale）容易漏；stdout 与 stderr 的用途划分必须与原系统一致（下游脚本可能在解析）

## 库 / SDK

- **栈**：thiserror；serde（数据类型可序列化时）；feature flags 控制可选依赖
- **架构**：公开 API 是设计核心——对照 behavior-spec 设计 pub 接口，内部结构自由。API 设计遵循 Rust API Guidelines（命名、Builder、类型状态）
- **测试**：golden 语料（driver 脚本采的输入输出对）→ 集成测试；round-trip/不变量 → proptest；文档示例写成 doctest
- **坑**：源语言的异常层次要映射为有意义的 Err 枚举（不是一个大 `Error(String)`）；源 API 的"接受一切"（动态参数、可选字段大对象）要拆成类型安全的入口，接口形态变化记入 design.md 的 API 映射表

## Web 服务

- **栈**：axum + tokio + serde + tower（中间件）；数据库 sqlx（编译期检查 SQL）；需要 ORM 语义再考虑 sea-orm；HTTP 客户端 reqwest；可观测 tracing
- **架构**：handler（薄）→ service（业务）→ repository（存储）；或按契约直接组织为"每能力一模块"。路由表集中声明，与 behavior-spec 的接口清单一一对应
- **测试**：golden 的请求→响应对用 axum 的 `tower::ServiceExt::oneshot` 或起真实端口重放；外部依赖用 wiremock；数据库测试用 testcontainers 或事务回滚
- **坑**：REST 契约兼容是硬要求——status code、错误 body 格式、分页参数名都不能变（客户端在依赖）；认证/session 语义（过期、刷新）容易走样；中间件顺序影响可观察行为（CORS、压缩）

## 游戏

- **栈**（按复杂度选）：
  - 2d 轻量（图元/精灵，无复杂场景图）→ **macroquad**（即时模式，几乎零样板）
  - 需要 ECS/场景/资产管线/3d → **bevy**（全家桶，但迫使逻辑进 ECS 范式——确认这个约束可接受再选）
  - 介于两者 → ggez（2d 框架）
  - 数学统一 glam；确定性随机 rand + 固定 seed；序列化 serde + bincode/RON
- **架构**：**模拟与呈现分离**是最重要的一刀——`sim` 模块（纯逻辑：状态+输入→新状态，无渲染依赖、无真实时钟、注入 RNG）+ `present` 模块（渲染/音频/输入采集）。固定 timestep 更新模拟，渲染插值。这个分离直接决定了游戏逻辑可测试
- **测试**：sim 模块吃 golden 的"输入序列→状态快照"语料；round-trip 测存档；proptest 测守恒不变量（物品总数、血量上下界）；present 层 checklist 人工核对
- **坑**：原游戏逻辑常和渲染耦合（update 里直接 draw）——剥离是设计工作而非翻译工作，在 design.md 里明确切割线；浮点物理跨平台不确定，golden 比对用容差或定点数；帧率依赖的逻辑（按帧计数的 buff）改固定 timestep 后行为会漂移，逐个核对

## GUI 应用

- **栈**（按取舍选）：
  - 逻辑复杂、UI 朴素 → **egui**（即时模式，最快落地）
  - 要系统原生感/成熟组件 → **iced**（Elm 架构）或 slint
  - 原系统是 web 技术栈且前端想保留 → **tauri**（Rust 后端 + 原前端资产）——前端不用重写，重构聚焦后端逻辑
- **架构**：文档模型/编辑操作/撤销栈/文件 IO 全部进 `core` 模块（无 UI 依赖），UI 层只做绑定。撤销栈用命令模式（操作对象化）
- **测试**：core 按"库"策略全覆盖；文件格式互通（旧文件必须能打开）是硬契约；UI checklist
- **坑**：原框架的数据绑定魔法（观察者、双向绑定）在 Rust 里显式化——消息/事件枚举比回调网络更惯用；剪贴板/拖放/IME 等平台行为按 checklist 处理

## 数据管道 / 科学计算

- **栈**：polars（DataFrame）/ ndarray（数值张量）+ rayon（数据并行）；Arrow 生态 arrow-rs；CSV/Parquet 用 polars 自带
- **架构**：按流水线阶段组织模块（ingest → transform → output），每阶段输入输出类型显式
- **测试**：golden 的"输入数据集→输出数据集"比对（浮点列容差）；性质测试（行数守恒、schema 稳定）
- **坑**：数值精度——源系统（尤其 Python/JS）的浮点累积顺序不同会导致尾数差异，契约容差要提前定；NaN/null 语义各家不同（pandas 的 NaN vs polars 的 null），逐列核对

## 系统工具 / 底层

- **栈**：nix/rustix（Unix 系统调用）；libc 仅 FFI 边界；异步 IO 看形态（网络多 → tokio；纯文件/进程 → std 线程足够）
- **架构**：平台相关代码集中到 `platform` 模块 + cfg 门控；其余保持平台无关
- **测试**：golden 重放（注意沙箱路径归一化）；系统调用重的逻辑抽 trait 便于测试替身
- **坑**：这是 unsafe 预算的主要消耗方——mmap/ioctl/信号处理集中封装，每处 SAFETY 注释；权限/root 行为、信号语义按 checklist 或集成环境验证
