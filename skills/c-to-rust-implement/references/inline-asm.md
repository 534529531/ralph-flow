# 内联汇编处理策略

C 项目中的内联汇编（`__asm__` / `__asm` / `asm`）需要特殊处理。

## 检测命令

```bash
grep -rn '__asm__\|__asm\b\|asm[ \t]*(' <source_c_dir>/src/ --include='*.c'
grep -rn '__asm__\|__asm\b\|asm[ \t]*(' <source_c_dir>/inc/ --include='*.h'
grep -rn '__asm\b' <source_c_dir>/src/ --include='*.c'  # MSVC 语法
```

## 评估替代方案（按优先级）

1. **Rust 标准库内联函数**：`std::arch::x86_64::*`（如 `_mm_add_ps`）——稳定、安全
2. **`core::arch::asm!()` 宏**：需 nightly Rust + `#![feature(asm)]`
3. **FFI 桥接**：将汇编提取为独立 C 文件，通过 FFI 调用

## asm!() 使用规范

若必须使用 `asm!()`：
- 包裹在最小 `unsafe` 块中，写清 `// SAFETY:` 注释
- 汇编操作数约束完整（in/out/lateout/clobber）
- 在 plan.json 对应模块的 notes 中记录
- 供 validate Gate 2 审计

## SIMD 优化

若汇编用于 SIMD 性能优化：
- 优先尝试 `std::simd`（nightly）或 `std::arch` 内联函数
- 提供纯 Rust fallback：`#[cfg(not(target_feature = "..."))]`

## 标记规则

- plan.json 中对应模块标记 `difficulty: "global"` + `notes: "含内联汇编"`
- plan.json 的 `inline_asm_modules` 数组包含该模块名
- `recommended_crates` 中添加 `"asm-shim"` 标记
