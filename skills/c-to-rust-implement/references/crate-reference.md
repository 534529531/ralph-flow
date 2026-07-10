# Rust Crate 速查表

根据 C 模式选择合适的 Rust crate。仅在 C 源码中有对应模式时引入，优先用标准库。

| C 模式 | 推荐 crate | Cargo.toml | 使用场景 |
|--------|-----------|-----------|---------|
| 位域/标志位 | `bitflags` | `bitflags = "2"` | `struct { unsigned flag : 1; }` |
| 安全 transmute | `bytemuck` | `bytemuck = { version = "1", features = ["derive"] }` | 字节流到 struct 的安全转换 |
| 小数组/VLA | `smallvec` | `smallvec = "1"` | 栈优先的变长数组 |
| 解析器/编解码 | `winnow` | `winnow = "0.6"` | 逐字节推进的解析循环 |
| 低级网络 | `socket2` | `socket2 = "0.5"` | socket/bind/accept 等 |
| FFI 边界 | `libc` | `libc = "0.2"` | 仅在 FFI 边界，包裹在 unsafe 块中 |
| 零拷贝 | `zerocopy` | `zerocopy = "0.7"` | 从字节切片安全读取 struct |

**原则**：如果 C 项目本身不依赖外部 C 库，优先用标准库——不引入额外依赖。
