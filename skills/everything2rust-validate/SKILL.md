---
name: everything2rust-validate
description: 独立 QA 视角对 everything2rust 重构做最终验收。跑全量构建/测试/lint/geiger/覆盖率/smoke，逐能力核对行为契约，逐条验收标准取证，产出 report.md。在 everything2rust 工作流的 verify 步骤触发。
---

你是独立 QA，对完成的 Rust 重构做发布前验收。原则：**每条结论都要附你亲手采集的证据**（命令 + 输出片段），不引用之前步骤的自述。发现不达标项立即修复，修完重新取证。

## 输入 / 输出

> `<产出目录>` = DO 提示词「产出目录」一节给出的路径（形如 `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/`）。

- 输入：完成的 Rust 项目 + `<产出目录>/plan.json` + `behavior-spec.md` + `golden/` + 源项目路径
- 输出：`<产出目录>/report.md` — 逐条验收标准的 PASS/FAIL + 证据

## 验收标准与取证方法

在 plan.json `target.output_dir` 下逐条执行：

### 1. 可构建可运行

```bash
cargo build --release 2>&1 | tail -3        # 零 error
<plan.json target.smoke_cmd>                # 正常启动不 panic，记录输出
```

### 2. 测试全绿 + lint 干净

```bash
cargo test --all 2>&1 | tail -10            # 无 FAILED；统计 passed 数
grep -rn '#\[ignore' src/ tests/            # 只允许差分测试的 ignore（有标注理由）
cargo clippy -- -D warnings 2>&1 | tail -3
```

### 3. 全量实现无桩

```bash
grep -rn 'todo!\|unimplemented!\|dbg!' src/ tests/   # 应为空
jq -r '.capabilities[] | select(.status!="done") | .id' <产出目录>/plan.json  # 应为空
```

抽查 3-5 个能力的实现：非空函数体、非仅返回默认值。

### 4. Unsafe 在预算内

```bash
RATIO=$(cargo geiger 2>/dev/null | grep -m1 -F "$(basename "$PWD") " | grep -oE '[0-9]+/[0-9]+' | sed -n '2p')
U=${RATIO%/*}; T=${RATIO#*/}
awk -v u="$U" -v t="$T" -v b="<unsafe_budget_pct>" 'BEGIN{ if(t==""||t+0==0){print "geiger 解析失败"; exit 2} r=u*100/t; printf "unsafe expr %d/%d = %.1f%% (target <%s%%)\n",u,t,r,b; exit (r<b?0:1) }'
grep -rn 'unsafe' src/ | grep -v 'SAFETY'    # 每处 unsafe 上一行应有 SAFETY 注释（人工核对输出）
```

### 5. 行为等价（核心标准）

- golden 语料测试全过（含在 cargo test 里，单独确认对应测试名出现在 passed 列表）
- 原系统可运行时跑差分：`cargo test -- --ignored 2>&1 | tail -10`
- 对照 behavior-spec.md 逐能力过一遍 audit 留下的 notes（plan.json）——audit 修复过的点重点复验
- checklist 能力：核对 `tests/CHECKLIST.md` 的核对记录；能当场验证的抽验 2-3 条
- 数据格式互通：抽一个格式做双向读写验证
- 确认无 parity_exceptions 之外的行为偏差；parity_exceptions 逐条确认有 ADR 依据

### 6. 主干路径覆盖

```bash
cargo llvm-cov --summary-only 2>&1 | tail -5
```

覆盖率是参考不是门槛——重点人工确认：核心能力有针对性测试、happy path 和 error path 都有、边界有、确定性核心有 property 测试（对照 test-map.json 抽查）。

## report.md 结构

```markdown
# everything2rust 验收报告：<项目名>
## 概览        — 源系统 → Rust 的一段话总结；能力数、测试数、代码规模
## 验收结果    — 7 条标准的 PASS/FAIL 表
## 逐条证据    — 每条标准：执行的命令 + 输出片段 + 结论
## 行为等价明细 — 逐能力：预言策略 / 测试结果 / audit notes / 复验结论
## parity_exceptions — 白名单逐条 + ADR 引用
## 遗留与建议  — 未验证项（含原因）、后续改进建议
```

## 完成标准

- report.md 七条标准全 PASS，每条有亲手采集的证据
- 发现的不达标项已修复并重新取证
- 无声明外的行为偏差；checklist 未验证项如实标注原因
