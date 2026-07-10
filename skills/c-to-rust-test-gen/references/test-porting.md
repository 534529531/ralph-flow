# C 测试移植参考（c-to-rust-test-gen）

## 目录

- 1. 各框架的用例声明与断言宏
- 2. 断言语义归一表（精度不降级）
- 3. 非确定性函数的归一化策略

## 1. 各框架的用例声明与断言宏

读 plan.json `test_framework`，把每个 C 测试用例映射成 Rust `#[test]`：

| 框架 | 用例声明 | 断言示例 |
|------|---------|---------|
| plain | `void test_x(void)` + `assert()` | `assert(...)` |
| Unity | `void test_x(void)` + `RUN_TEST` | `TEST_ASSERT_EQUAL(a,b)` |
| CMocka | `static void x(void **state)` | `assert_int_equal(a,b)` |
| Check | `START_TEST(x)` | `ck_assert_int_eq(a,b)` |
| CuTest | `void Testx(CuTest *tc)` | `CuAssertIntEquals(tc,a,b)` |

无论来自哪种框架，断言语义都按下表精确归一。

## 2. 断言语义归一表（精度不降级）

| C 断言语义 | Rust 断言 |
|-----------|----------|
| `ret == 0` / 等值成功 | `assert_eq!(result, Ok(expected))` |
| `ret == -1` / 失败 | `assert!(result.is_err())` |
| `ret == SPECIFIC_ERR` | `assert_eq!(result, Err(AppError::SpecificErr))` |
| `a == b` / `a != b` | `assert_eq!` / `assert_ne!` |
| `memcmp(a,b,n)==0` | `assert_eq!(&a[..n], &b[..n])` |
| `ptr != NULL` / `== NULL` | `assert!(x.is_some())` / `is_none()` |
| `strcmp(a,b)==0` | `assert_eq!(a, b)` |
| `fabs(a-b) < eps` | `assert!((a-b).abs() < eps)` |
| `a>=lo && a<=hi` | `assert!(a>=lo && a<=hi)`（范围精确保留） |
| `cond && "msg"` | `assert!(cond, "msg")` |
| 循环里多个 assert | **每个独立保留**，禁止用 `assert!(all(...))` 合并 |

文件命名 `tests/oracle_<module>.rs`。
错误路径：对每个 error_variant，确认至少一个测试触发它。

## 3. 非确定性函数的归一化策略

对**非确定性输出**做精确断言会假阳。识别并处理（在 plan.json 对应模块 `notes` 记下策略）：

| 非确定来源 | 现象 | 归一化做法 |
|-----------|------|-----------|
| 指针/地址打印 | `%p`、把地址写进输出 | 比对前把地址字段抹成 `0x0` 后再比 |
| 时间/PID/随机数 | 时间戳、`rand()`、PID | 注入固定种子 / 固定时钟；不可注入则排除该字段，记 notes |
| 哈希/集合遍历序 | map/set 迭代顺序不定 | 比对前对输出**排序**，或断言"集合相等"而非"序列相等" |
| 未初始化 padding | struct 写盘带垃圾字节 | 比对前 memset/掩码 padding 区；或只比有效字段 |
| 浮点末位 | 不同优化下末位差异 | 用 `(a-b).abs() < eps` 容差比对，不逐字节 |
| 平台相关（字节序/字长） | `size_t`/字节序差异 | 固定到一种表示后再比；条件编译路径分别处理 |

原则：**能消除非确定性就消除（固定种子/时钟）；不能就缩小比对面（只比确定字段）**——但要在 notes 里
写清"放弃了对哪部分输出的等价断言、为什么"，让 verify 阶段能看到这个让步，不被当成 100% 等价。
