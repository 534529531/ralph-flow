# C→Rust 惯用模式转换表

C 语义到 Rust 惯用模式的专家级对照。实现 C 到 Rust 翻译时的权威参考。

## 内存管理

| C 模式 | Rust 翻译 | 说明 |
|--------|----------|------|
| `T* p = malloc(n * sizeof(T))` | `let p: Vec<T> = vec![T::default(); n]` 或 `Vec::with_capacity(n)` | Vec 管理堆内存 |
| `free(p)` | 让 `Drop` 自动处理——返回有主类型，不存裸指针 | 析构自动调用 |
| `memcpy(dst, src, n)` | `dst[..n].copy_from_slice(&src[..n])` | 前提：dst/src 是切片 |
| `memset(p, 0, n)` | `p[..n].fill(0)` | 或直接用 `vec![0u8; n]` |
| `realloc(p, new_sz)` | 新建 Vec，复制旧内容，丢弃旧 | 在安全 Rust 中无直接等价物 |
| `memcmp(a, b, n)` | `a[..n] == b[..n]` | 切片比较，短路求值 |

## 错误处理

| C 模式 | Rust 翻译 | 说明 |
|--------|----------|------|
| `return -1` / `return ERR_CODE` | `Err(Error::ErrCode)` | 枚举变体对应错误码 |
| `if (ret < 0) goto cleanup` | `let result = fallible_op()?;` | `?` 操作符自动传播错误 |
| `errno = EINVAL` | `Err(Error::InvalidInput { details })` | 带上下文 |
| 出参传错误 `int* err` | 返回 `Result<T, Error>`，无出参 | 多返回值用元组 |
| `goto cleanup` 集中清理 | RAII：`Drop` 处理清理 | 作用域退出自动执行 |

## 数据结构

| C 模式 | Rust 翻译 | 说明 |
|--------|----------|------|
| 柔性数组 `struct { int len; T data[]; }` | `struct { data: Vec<T> }` | len 由 `data.len()` 派生 |
| 标签联合 `struct { int type; union { A a; B b; }; }` | `enum { VariantA(A), VariantB(B) }` | 穷尽匹配，无隐式 fallthrough |
| 链表 `struct node { T data; node* next; }` | `std::collections::LinkedList<T>` 或 `Vec<T>` | 大多数情况 Vec 更高效 |
| 不透明句柄 `typedef struct ctx ctx_t;` | `pub struct Ctx { /* 私有字段 */ }` + `impl Ctx` | 封装 |
| 位域 `struct { unsigned flag : 1; }` | `bitflags` crate 或手动位运算 + 命名常量 | Rust 无原生位域 |

## 控制流

| C 模式 | Rust 翻译 | 说明 |
|--------|----------|------|
| `for (int i = 0; i < n; i++)` | `for item in &slice` 或 `for (i, item) in slice.iter().enumerate()` | 迭代器 |
| `while (*p != '\0') p++` | `s.find('\0')` 或 `s.bytes().position(\|b\| b == 0)` | 不用手动推进指针 |
| `switch(val) { case X: ... }` | `match val { X => ..., Y => ... }` | 穷尽匹配，无 fallthrough |
| 函数指针表 / vtable | `trait` + `Box<dyn Trait>` 或 `enum` 分发 | trait 更安全 |
| `goto` 错误处理 | RAII + `?` 操作符 | Rust 无 goto |

## 并发与状态

| C 模式 | Rust 翻译 | 说明 |
|--------|----------|------|
| `static mut STATE: T` | `static STATE: OnceLock<Mutex<T>>` | 线程安全全局状态 |
| `pthread_mutex_lock/unlock` | `std::sync::Mutex<T>` 的 `.lock().unwrap()` | 自动释放 |
| 线程局部 `__thread T x` | `std::cell::RefCell` + `thread_local!` 宏 | 线程局部可变 |
| 一次性初始化 `if (!init) { init(); init=1; }` | `OnceLock::get_or_init(\|\| { ... })` | 线程安全 |

## 转换示例

```rust
// C 源码:
// int codec_encode(const uint8_t* in, size_t in_len, uint8_t* out, size_t* out_len) {
//     if (!in || !out || !out_len) return CODEC_ERR_INVALID;
//     if (*out_len < in_len + 4) return CODEC_ERR_OVERFLOW;
//     // ... 编码逻辑 ...
//     *out_len = encoded_len;
//     return 0;
// }

// Rust 实现：
pub fn encode(input: &[u8], output: &mut [u8]) -> Result<usize, Error> {
    // if (!in) → 切片引用不可能为 null（由类型系统保证）
    if output.len() < input.len() + 4 {
        return Err(Error::Overflow);
    }
    // ... 编码逻辑（原样翻译算法，但用 Rust 语法）...
    Ok(encoded_len)
}
```

## 常见陷阱

- C 的 int 返回 0=成功 / -1=失败 → Rust 的 `Result<(), Error>`
- C 的 size_t 出参 → Rust 的 `Result<usize, Error>` 直接返回长度
- C 的 NULL 检查 → Rust 引用不可能为 null，去掉所有 `if (!ptr)` 检查
- C 的数组 + 长度参数对 → Rust 切片 `&[T]`，长度由 `.len()` 获取
- C 的 void* 泛型 → Rust 泛型 `<T>` 或 trait bound
- C 的 #ifdef 条件编译 → Rust 的 `#[cfg(...)]` 或 feature flag
- C 的宏函数 → Rust 的 `macro_rules!` 或普通泛型函数
