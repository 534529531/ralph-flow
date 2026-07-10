# 探测命令参考（c-to-rust-plan）

## 目录

- 1. 项目布局探测
- 2. 测试框架探测
- 3. 构建系统探测
- 4. 公开 API 提取（头文件）
- 5. 内部函数 + 高级特性检测

## 1. 项目布局探测

```bash
find <source_c_dir> -name '*.c' -not -path '*/vendor/*' -not -path '*/third_party/*' -not -path '*/3rd*/*'
find <source_c_dir> -name '*.h' -not -path '*/vendor/*' -not -path '*/third_party/*'
```

由实际结果归纳源码目录、头文件目录、测试目录。布局可能是 `src/`+`include/`、`lib/`、扁平根目录或任意组合。
测试文件特征：在 `test/`、`tests/`、`t/` 目录，或文件名含 `test`/`spec`/`check`。

## 2. 测试框架探测

```bash
grep -rln 'unity.h\|UNITY_BEGIN\|RUN_TEST\|TEST_ASSERT' <test_dir>      # Unity
grep -rln 'cmocka.h\|cmocka_unit_test\|assert_int_equal' <test_dir>    # CMocka
grep -rln '<check.h>\|START_TEST\|ck_assert' <test_dir>                 # Check
grep -rln 'CuTest\|CuAssert' <test_dir>                                 # CuTest
grep -rln 'int main' <test_dir>                                         # 自定义 main + assert()
grep -rln 'void test_\|static void test_' <test_dir>                    # 朴素 test_ 约定
```

## 3. 构建系统探测

```bash
ls <source_c_dir>/{Makefile,makefile,CMakeLists.txt,configure,meson.build,*.mk} 2>/dev/null
grep -rn 'cc\|gcc\|clang\|-I' <source_c_dir>/Makefile* 2>/dev/null | head
```

记录 type、build_cmd、test_cmd、test_binary、include_flags（正确的 `-I<headerdir>`）、cc。无构建系统则给手动编译命令。

## 4. 公开 API 提取（头文件）

ctags 主方案（处理函数指针返回值、多行声明），grep 兜底：

```bash
ctags -x --c-kinds=pf --format=2 <header_dir>/*.h 2>/dev/null   # 函数原型/定义
ctags -x --c-kinds=stue --format=2 <header_dir>/*.h 2>/dev/null  # struct/typedef/union/enum
ctags -x --c-kinds=d --format=2 <header_dir>/*.h 2>/dev/null     # 宏常量
grep -nE '^\s*\w+(\s+\*?\s*\w+)+\([^)]*\)\s*;' <header_dir>/*.h   # grep 兜底
```

每个公开函数提取：名称、返回类型、参数、错误约定（返回码 / errno / 出参）。
额外识别回调签名（函数指针类型）和条件编译块（`#ifdef`/`#if`，记录宏名）。

## 5. 内部函数 + 高级特性检测

```bash
grep -rnE '^\s*static\s+\w+\s+\w+\(' <source_dir>            # static 内部函数
grep -rn '__asm__\|__asm\b\|\basm[ \t]*(' <source_dir> <header_dir>   # 内联汇编 → difficulty=global
# C11/C17 特性（Rust 无直接等价，提前发现避免返工）
grep -rn '_Generic(\|_Atomic\b\|_Alignas\b\|\brestrict\b\|setjmp\|longjmp\|alloca(\|\bvolatile\b\|\bsignal\b' <source_dir> <header_dir>
grep -rnE '[a-zA-Z_]\s+[a-zA-Z_]+\[[a-zA-Z_]+\]\s*;' <source_dir>     # 变长数组 VLA
```

每个特性结果记入模块 `c_advanced_features` 的对应布尔字段：
has_generic / has_atomic / has_alignas / has_restrict / has_setjmp / has_alloca / has_vla / has_volatile / has_signal。
