# 验收测试 Harness 模式

## 目录
- golden 数据驱动 harness
- CLI 重放（assert_cmd）
- HTTP 重放（axum oneshot）
- 库 API 语料重放
- 游戏模拟快照
- 属性测试（proptest）
- 差分测试（运行原系统）
- 归一化函数

## golden 数据驱动 harness

核心形态：一个测试函数遍历语料目录，每个 case 独立报告失败。

```rust
// tests/golden_common/mod.rs
use std::path::{Path, PathBuf};

pub struct GoldenCase {
    pub dir: PathBuf,
    pub input: String,
    pub expected: String,
}

pub fn load_cases(cap_id: &str) -> Vec<GoldenCase> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden").join(cap_id);
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("meta.json")).unwrap()).unwrap();
    meta["cases"].as_array().unwrap().iter().map(|c| GoldenCase {
        dir: root.clone(),
        input: std::fs::read_to_string(root.join(c["input"].as_str().unwrap())).unwrap(),
        expected: std::fs::read_to_string(root.join(c["expected"].as_str().unwrap())).unwrap(),
    }).collect()
}
```

```rust
// tests/golden_parse.rs — 每个 case 失败时报出 case 路径
#[test]
fn golden_parse() {
    for case in golden_common::load_cases("cap-parse") {
        let actual = my_crate::parse(&case.input).unwrap();
        assert_eq!(
            normalize(&serde_json::to_string_pretty(&actual).unwrap()),
            normalize(&case.expected),
            "case: {}", case.dir.display()
        );
    }
}
```

case 数量多或想逐 case 独立显示时用 rstest 的 `#[files]` 或 libtest-mimic 生成动态测试。

## CLI 重放（assert_cmd）

```rust
use assert_cmd::Command;

#[test]
fn golden_cli_convert() {
    for case in golden_common::load_cases("cap-convert") {
        let assert = Command::cargo_bin("mytool").unwrap()
            .args(case.args())           // meta.json 里记录的 args
            .write_stdin(case.input.clone())
            .assert();
        let out = assert.get_output();
        assert_eq!(out.status.code(), Some(case.exit_code()), "case: {}", case.dir.display());
        assert_eq!(normalize(&String::from_utf8_lossy(&out.stdout)), normalize(&case.expected));
        // stderr 语料存在时同样比对——stderr 格式也是契约
    }
}
```

## HTTP 重放（axum oneshot）

```rust
use tower::ServiceExt;

#[tokio::test]
async fn golden_orders_post() {
    let app = my_service::build_app(test_state()).await;
    for case in golden_common::load_cases("cap-orders-post") {
        let req = case.to_http_request();   // meta.json: method/path/headers/body
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status().as_u16(), case.expected_status());
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(normalize_json(&body), normalize_json(case.expected.as_bytes()));
    }
}
```

外部依赖：wiremock 起 mock server，语料 meta.json 中记录的下游交互配置成 stub。

## 库 API 语料重放

driver 采集的 JSON 语料（input/output/error 三态）：

```rust
#[test]
fn golden_lib_parse() {
    for case in load_json_cases("cap-parse") {
        match (my_crate::parse(&case.input), case.expected) {
            (Ok(v), Expected::Output(o)) => assert_eq!(to_value(v), o),
            (Err(e), Expected::Error(spec)) => assert_eq!(error_kind(&e), spec.kind),
            (got, want) => panic!("形态不匹配: got={got:?} want={want:?}"),
        }
    }
}
```

原系统异常 → Err 变体的映射表放在一处（error_kind 函数），保持全部测试一致。

## 游戏模拟快照

语料 = 初始状态 + 输入序列 + N 帧后的状态快照：

```rust
#[test]
fn golden_sim_combat() {
    for case in load_sim_cases("cap-combat") {
        let mut world = sim::World::from_snapshot(&case.initial);
        let mut rng = sim::SeededRng::new(case.seed);
        for frame_inputs in &case.input_frames {
            world.step(frame_inputs, sim::FIXED_DT, &mut rng);
        }
        assert_eq!(world.observable_snapshot(), case.expected_snapshot,
                   "case: {}", case.dir.display());
    }
}
```

前提（design 已保证）：sim 无真实时钟、RNG 注入、固定 timestep。`observable_snapshot()` 只含契约关心的字段。浮点字段用容差比较实现 PartialEq 包装或逐字段 assert_relative_eq。

## 属性测试（proptest）

```rust
proptest! {
    #[test]
    fn prop_save_load_roundtrip(state in arb_game_state()) {
        let bytes = save::serialize(&state)?;
        let restored = save::deserialize(&bytes)?;
        prop_assert_eq!(state, restored);
    }
}
```

不变量来源是 behavior-spec 的"不变量"字段。生成器（`arb_*`）覆盖契约的输入空间，包括边界（空、超长、Unicode）。

## 差分测试（运行原系统）

原系统可运行时的加验手段。标 `#[ignore]`，audit/verify 阶段用 `cargo test -- --ignored` 显式跑：

```rust
#[test]
#[ignore = "differential: 需要原系统运行时"]
fn diff_parse_random() {
    for input in gen_random_inputs(200) {
        let original = run_original(&["parse"], &input);   // 调 plan.json source.run_cmd
        let ours = run_ours(&["parse"], &input);
        assert_eq!(normalize(&original), normalize(&ours), "input: {input:?}");
    }
}
```

## 归一化函数

behavior-spec 的归一化规则集中实现在一个模块，全部 harness 共用：

```rust
pub fn normalize(s: &str) -> String {
    let s = TIMESTAMP_RE.replace_all(s, "<TS>");          // 时间戳占位
    let s = TMPPATH_RE.replace_all(&s, "<PATH>");         // 沙箱路径占位
    s.trim_end().replace("\r\n", "\n")                    // 行尾统一
}

pub fn normalize_json(bytes: &[u8]) -> serde_json::Value {
    let mut v: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    sort_arrays_marked_unordered(&mut v);                  // 契约标注无序的数组排序
    strip_volatile_fields(&mut v);                         // 契约标注易变的字段剥离
    v
}
```

剥离/占位的字段清单来自 behavior-spec——不要顺手多剥（会掩盖真实差异），也不要少剥（假失败消耗迭代次数）。
