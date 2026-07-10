# Proptest Patterns for C-to-Rust Translation

## Contents
- Data Transform Functions（roundtrip / determinism / empty）
- Stateful APIs（state-machine proptest）

Property-based test templates for the TDD baseline. Place in `tests/prop_<module>.rs`.

## Data Transform Functions (Codec/Checksum/Serialize)

For functions satisfying "arbitrary input → verifiable property":

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn prop_roundtrip_consistent(data in prop::collection::vec(any::<u8>(), 0..512)) {
        let mut encoded = vec![0u8; data.len() * 2 + 16];
        let n = codec::encode(&data, &mut encoded).unwrap();
        let mut decoded = vec![0u8; data.len()];
        let m = codec::decode(&encoded[..n], &mut decoded).unwrap();
        assert_eq!(&decoded[..m], &data);
    }

    #[test]
    fn prop_checksum_deterministic(data in prop::collection::vec(any::<u8>(), 0..1024)) {
        assert_eq!(codec::checksum(&data), codec::checksum(&data));
    }

    #[test]
    fn prop_empty_input_no_crash() {
        let mut out = vec![0u8; 16];
        assert!(codec::encode(&[], &mut out).is_ok());
    }
}
```

## Stateful APIs (Objects with init/transform/deinit lifecycle)

For modules with `difficulty=stateful`, use state-machine proptest:

```rust
use proptest::prelude::*;
use proptest::strategy::{Strategy, ValueTree};

#[derive(Debug, Clone)]
enum Op {
    Connect,
    Write(Vec<u8>),
    Read(usize),
    Flush,
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        Just(Op::Connect),
        prop::collection::vec(any::<u8>(), 0..256).prop_map(Op::Write),
        (1usize..1024).prop_map(Op::Read),
        Just(Op::Flush),
    ]
}

proptest! {
    #[test]
    fn prop_arbitrary_op_sequence_no_crash_no_leak(ops in prop::collection::vec(op_strategy(), 0..50)) {
        let mut ctx = storage::Ctx::new();
        for op in &ops {
            match op {
                Op::Connect => { let _ = ctx.connect(); }
                Op::Write(data) => { let _ = ctx.write(data); }
                Op::Read(n) => { let _ = ctx.read(*n); }
                Op::Flush => { let _ = ctx.flush(); }
            }
        }
        // ctx drops at end of scope — no panic = pass
    }
}
```

State-machine proptest during red phase: only verify no panic/no leak, not specific return values (stubs are `todo!()`). After implementation: add assertions on correct behavior.
