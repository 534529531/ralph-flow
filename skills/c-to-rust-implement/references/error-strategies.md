# Error Type Composition Strategies

Two strategies for composing error types across Rust modules during C-to-Rust translation.

## Strategy A — Layered Error (Recommended for shallow dependency chains)

Each module defines its own `Error` enum. Upper layers compose lower layers via `#[from]`.

**选择条件（满足全部即可选 A）**：
- 依赖深度 ≤ 3（Error 嵌套从 A→B→C 不超过 3 层）
- 模块间无同名错误类别（如两个模块都有 `Io(std::io::Error)`）
- main.rs 不需要统一处理所有错误

```rust
// src/codec.rs
#[derive(Error, Debug, PartialEq)]
pub enum Error {
    #[error("codec: invalid input")]
    InvalidInput,
    #[error("codec: output buffer overflow")]
    Overflow,
}

// src/storage.rs — depends on codec
use crate::codec;

#[derive(Error, Debug, PartialEq)]
pub enum Error {
    #[error("storage: IO error: {0}")]
    Io(String),
    #[error(transparent)]
    Codec(#[from] codec::Error),  // transparent forward
    #[error("storage: data corruption")]
    Corruption,
}
```

`lib.rs` re-exports:
```rust
pub use error::Error;
pub mod codec;
pub mod storage;
```

Cross-module `?` operator auto-converts via `#[from]`, no manual `map_err` needed.

## Strategy B — Flat Error (Recommended for deep dependency chains)

When dependency chains are deep or multiple modules share error categories, layered Error nesting becomes verbose. Use a single top-level unified Error:

```rust
// src/error.rs
#[derive(Error, Debug)]
pub enum AppError {
    #[error("codec: {0}")]
    Codec(#[from] codec::Error),
    #[error("storage: {0}")]
    Storage(#[from] storage::Error),
    #[error("network: {0}")]
    Network(#[from] network::Error),
    #[error("internal: {0}")]
    Internal(String),
}
```

### When to Choose Strategy B (any one condition is sufficient)

- **Dependency depth > 3**（Error 从 A→B→C→D 嵌套超过 3 层时，调用方需写 4+ 层 `map_err`）
- **Multiple modules share the same error category**（如两个模块都产生 IO/Parse 类错误，用 Flat Error 避免重复定义）
- **Main.rs / top-level needs to handle all errors uniformly**（统一错误处理，不分模块来源）
- **Module count > 10**（辅助指标，仅当同时满足前面任一条件时才作为决定因素）

### Decision Table

| 依赖深度 | 同名错误类别 | 模块数 | 推荐策略 |
|---------|------------|-------|---------|
| ≤ 3 | 0 | ≤ 10 | Strategy A |
| ≤ 3 | ≥ 1 | any | Strategy B |
| > 3 | any | any | Strategy B |
| any | any | > 10 | 倾向 Strategy B |
