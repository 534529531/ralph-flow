# 范式映射——源语言构造 → Rust 惯用法

设计模块结构、以及实现中遇到"这个特性 Rust 怎么表达"时查本表。原则：**映射语义，不映射语法**。源系统用继承不代表 Rust 要 trait 对象——先问"这个继承在表达什么"（多态分发？代码复用？开闭扩展点？），再选对应工具。

## 目录
- 类型系统落差
- 面向对象构造
- 内存与资源管理
- 错误处理
- 并发模型
- 函数式 / 动态特性
- 全局状态与生命周期
- 各源语言速查

## 类型系统落差

| 源构造 | Rust 映射 | 备注 |
|--------|-----------|------|
| 动态类型值（任意 JSON/dict） | 边界处 `serde_json::Value`，内部尽早转强类型 struct | "解析后不再是动态的"——动态性止步于 IO 边界 |
| null / undefined / None | `Option<T>` | 源系统区分 null 与 undefined 时，确认契约是否依赖该区分（多半不该依赖） |
| 鸭子类型（"有 .read() 就行"） | trait | 只为真实存在的多个实现建 trait；单实现直接用具体类型 |
| 字符串（各语言语义不同） | `String`/`&str`（UTF-8） | JS 的 UTF-16 索引、Python 的码点索引与 Rust 字节索引不同——凡契约涉及"第 n 个字符/长度"，逐处核对 |
| 大整数默认（Python int） | i64/u64 或 num-bigint | 看源码实际值域，契约有溢出行为时显式处理 |
| 隐式数值转换 | `as`/`From`/`TryFrom` 显式化 | JS 的 `==` 弱比较、Python 的 int/float 混算——语义等价靠测试兜底 |

## 面向对象构造

| 源构造 | Rust 映射 | 选择标准 |
|--------|-----------|---------|
| 继承（多态分发） | 封闭集合 → `enum` + match；开放集合 → `Box<dyn Trait>` | 变体集合编译期已知选 enum（穷尽检查是白拿的）；插件式扩展点才用 trait 对象 |
| 继承（代码复用） | 组合 + 委托；共享逻辑抽成函数或默认 trait 方法 | 不要为复用建 trait 层次 |
| 抽象类/接口 | trait（可带默认方法） | |
| 方法重载 | 不同名函数，或泛型 + `impl Into<T>` | Rust 无重载，命名区分更清晰 |
| 运算符重载 | `std::ops` trait | 仅当源语义确实是代数运算 |
| 静态方法/类方法 | 关联函数 | |
| getter/setter 网络 | 公开字段或按需方法 | 无逻辑的 setter 直接暴露字段 |
| 访问者模式 | match + enum | 访问者多半是"缺 match 的语言"的补丁 |

## 内存与资源管理

| 源构造 | Rust 映射 | 备注 |
|--------|-----------|------|
| GC 对象图（树状） | 所有权 + `Box` | 大多数"共享"其实是树，先试单所有者 |
| GC 对象图（真共享） | `Rc<RefCell<T>>`（单线程）/ `Arc<Mutex<T>>`（跨线程） | 先质疑：是否可改为 id 引用 |
| 循环引用（双向链接、父子互指） | 索引/id + 中心存储（`Vec`/slotmap/generational-arena） | 游戏实体、图结构的标准解法；比 `Weak` 网络好维护 |
| 析构/finalizer/with 语句/defer | `Drop` + RAII | 源系统 finalizer 时机不确定，Rust Drop 确定——时机差异一般是改进，契约有依赖再核对 |
| 手动 close()/dispose() | `Drop` 为主；需要错误处理的关闭再加显式 `close(self) -> Result` | |

## 错误处理

| 源构造 | Rust 映射 | 备注 |
|--------|-----------|------|
| 异常（业务可恢复） | `Result<T, E>` + thiserror 枚举 | 异常类层次 → Err 变体；捕获点 → `?` 传播链的消费点 |
| 异常（编程错误） | `panic!`/`assert!` | 源系统把两类混在一起时，按契约区分：调用方会捕获处理的是业务错误 |
| errno / 返回码 | `Result` | |
| try/finally | RAII / `scopeguard` | |
| 裸 catch-all 吞异常 | 显式决定：记日志继续（契约如此）或去掉（记入 parity_exceptions） | 吞异常常是原系统 bug，走 ADR 裁决 |

## 并发模型

| 源构造 | Rust 映射 | 备注 |
|--------|-----------|------|
| async/await（JS/Python/C#） | tokio + async/await | 单线程事件循环语义 ≠ tokio 多线程调度——共享状态从"天然安全"变为需要 `Arc<Mutex>`，数据竞争之外的**顺序假设**（回调按注册序触发等）逐个核对 |
| goroutine + channel | `std::thread`/tokio task + `mpsc`/crossbeam | 语义相近，最平滑的映射 |
| 线程 + 锁 | `std::thread` + `Mutex`/`RwLock` | Rust 强制锁保护数据，原系统"忘了加锁"的地方会被暴露——按契约行为裁决 |
| GIL 下的"线程安全" | 显式同步 | Python 线程的原子性假设在 Rust 不成立 |
| 回调风格异步 | async/await 重写，或 channel + 事件循环 | 控制反转正过来 |
| 定时器/事件循环 | tokio::time / 游戏固定 timestep | |

## 函数式 / 动态特性

| 源构造 | Rust 映射 | 备注 |
|--------|-----------|------|
| 一等函数/闭包 | `Fn`/`FnMut`/`FnOnce` + 泛型或 `Box<dyn Fn>` | |
| 装饰器/高阶包装 | 显式包装函数、builder，或（仅横切关注点）宏 | 别急着写宏，多数装饰器就是函数组合 |
| 猴子补丁/运行时替换 | trait + 测试替身注入 | 补丁点即接缝，设计期显式化 |
| 反射/自省 | serde（数据形状）/ enum + match（行为分发） | "遍历字段"几乎都是序列化需求 |
| 元编程/代码生成 | 宏（声明式优先）/ build.rs | 成本高，先确认契约真的需要这个灵活性 |
| eval / 动态加载 | 解释器嵌入（rhai/rlua）或砍掉 | 契约层面裁决，多半进 parity_exceptions |
| 生成器/yield | `Iterator` 实现 / async Stream | |
| 列表推导/管道 | 迭代器链 | 天然映射 |

## 全局状态与生命周期

| 源构造 | Rust 映射 | 备注 |
|--------|-----------|------|
| 全局单例 | 显式依赖注入（构造时传入）为主；确需全局用 `OnceLock` | 单例多为省参数——Rust 里传 `&Context` 更可测 |
| 模块级可变状态 | 所属 struct 的字段 | |
| 环境隐式依赖（cwd、env、时钟） | 显式参数/trait（`Clock`），边界处读取 | 这是 golden 测试可复现的前提 |
| 初始化顺序依赖 | 类型系统表达（构造函数返回已初始化的值；typestate） | "必须先 init"类 bug 在 Rust 编译期消失 |

## 各源语言速查

- **JavaScript/TypeScript**：原型链→上面 OO 节；`this` 动态绑定→方法接收者显式化；npm 微依赖→多数用 std 替代；事件循环顺序假设→并发节
- **Python**：kwargs/默认参数→builder 或 Option 参数 struct；魔术方法→对应 trait（`__eq__`→PartialEq、`__iter__`→Iterator）；鸭子类型→trait
- **Go**：接口→trait（几乎 1:1）；error 返回→Result；`defer`→Drop；channel→mpsc/crossbeam
- **Java/C#**：继承层次→OO 节；注解/DI 容器→显式构造注入；stream/LINQ→迭代器
- **C/C++**：优先复用 c-to-rust 工作流的模式库（skills/c-to-rust-implement/references/）；本工作流适用于"要重新设计架构"的场景，逐函数移植场景用 c-to-rust
- **Ruby/PHP**：动态特性最重，method_missing/魔术方法→设计期显式枚举全部实际用法（grep 调用点），为真实用法建模，不为机制建模
