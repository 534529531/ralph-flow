# 条件编译翻译指南

C 项目中的 `#ifdef` / `#ifndef` / `#if` 翻译为 Rust 的 `#[cfg(...)]` 或 feature flag。

## 简单映射

| C 预处理 | Rust 等价 |
|----------|----------|
| `#ifdef _WIN32` | `#[cfg(target_os = "windows")]` |
| `#ifdef __linux__` | `#[cfg(target_os = "linux")]` |
| `#ifdef __APPLE__` | `#[cfg(target_os = "macos")]` |
| `#ifdef __x86_64__` | `#[cfg(target_arch = "x86_64")]` |
| `#ifdef __aarch64__` | `#[cfg(target_arch = "aarch64")]` |
| `#ifdef DEBUG` | `#[cfg(debug_assertions)]` |
| `#ifdef FEATURE_X` | `#[cfg(feature = "x")]` + Cargo.toml `[features]` |
| `#if !defined(X)` | `#[cfg(not(feature = "x"))]` |
| `#if defined(A) && !defined(B)` | `#[cfg(all(feature = "a", not(feature = "b")))]` |
| `#if defined(A) \|\| defined(B)` | `#[cfg(any(feature = "a", feature = "b"))]` |
| `#else` | 单独的 `#[cfg(not(...))]` 块 |
| `#if VERSION >= 3` | 无法直接映射——用 feature flag 替代 |

## 多条件互斥编译

C 代码 `#if defined(A) ... #elif defined(B) ... #else ...`：

```rust
#[cfg(feature = "a")]
fn platform_impl() { /* A 实现 */ }

#[cfg(all(not(feature = "a"), feature = "b"))]
fn platform_impl() { /* B 实现 */ }

#[cfg(all(not(feature = "a"), not(feature = "b")))]
fn platform_impl() { /* 默认实现 */ }
```

## Feature Flag 声明

在 `Cargo.toml` 中声明：
```toml
[features]
default = []
a = []
b = []
```

**注意**：plan.json 的 api_inventory 会记录条件编译影响哪些函数——实现时确保所有条件路径都有对应的 Rust 分支。
