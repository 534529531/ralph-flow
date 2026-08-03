import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine, shouldResetOnTransition } from "../engine.js";

let tmpDir: string;
let engine: Engine;
let INST: string; // instId of the instance created by startInstance()

function makeEngine(dir = tmpDir): Engine {
  const platform: Platform = {};
  return createEngine(dir, platform) as Engine;
}

function writeProjectWorkflow(name: string, content: string): void {
  const dir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), content);
}

const SIMPLE_WF = `
description: test workflow
steps:
  - id: one
    desc: first step
    do: do one
    check: check one
    input: user input
    output: "out1.md"
    on_pass: two
    on_fail: one
    max_fail_count: 3
  - id: two
    desc: second step
    do: do two
    check: check two
    input: out1.md
    output: "out2.md"
    on_pass: done
    on_fail: two
    max_fail_count: 2
`;

/** Mirror of what ralphflow_start does for a normal first step. */
function startInstance(wfName = "test-wf", task = "test task", sessionId = "sess-1"): string {
  const wf = engine.loadWorkflow(wfName)!;
  const instId = engine.generateInstanceId(wfName);
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, task);
  engine.writeState({ active: true, workflow_name: wfName, current_step: wf.steps[0].id, current_phase: "do", fail_count: 0, user_task: task, paused: false, session_id: sessionId }, instId);
  INST = instId;
  return instId;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-test-"));
  engine = makeEngine();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Global user workflows ───────────────────────────────────────────────────

describe("global workflows", () => {
  let globalHome: string;
  let savedXdg: string | undefined;

  function writeGlobalWorkflow(name: string, content: string): void {
    const dir = path.join(globalHome, "opencode", "ralph-flow", "workflows");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.yaml`), content);
  }

  beforeEach(() => {
    globalHome = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-xdg-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = globalHome; // getGlobalConfigHome reads this at call time
    engine = makeEngine(); // fresh engine so nothing is bound
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    fs.rmSync(globalHome, { recursive: true, force: true });
  });

  it("getGlobalWorkflowsDir points into the opencode config home", () => {
    expect(engine.getGlobalWorkflowsDir()).toBe(path.join(globalHome, "opencode", "ralph-flow", "workflows"));
  });

  it("loads a workflow from the global dir", () => {
    writeGlobalWorkflow("my-global", SIMPLE_WF);
    const wf = engine.loadWorkflow("my-global");
    expect(wf).not.toBeNull();
    expect(wf!.steps.length).toBe(2);
  });

  it("lists global workflows alongside built-ins", () => {
    writeGlobalWorkflow("my-global", SIMPLE_WF);
    const names = engine.listWorkflows().map((w) => w.name);
    expect(names).toContain("my-global");
    expect(names).toContain("loop"); // built-in still present
  });

  it("resolution order: project shadows global shadows plugin", () => {
    // global shadows a built-in (loop)
    writeGlobalWorkflow("loop", SIMPLE_WF);
    expect(engine.loadWorkflow("loop")!.description).toBe("test workflow");

    // project shadows global
    writeProjectWorkflow("loop", SIMPLE_WF.replace("test workflow", "project wins"));
    expect(engine.loadWorkflow("loop")!.description).toBe("project wins");
  });

  it("an invalid global file falls through to the built-in", () => {
    const builtIn = engine.loadWorkflow("loop")!.description;
    writeGlobalWorkflow("loop", "steps: []");
    expect(engine.loadWorkflow("loop")!.description).toBe(builtIn);
  });

  it("doctor reports the global source and its shadowing", () => {
    writeGlobalWorkflow("loop", SIMPLE_WF); // global shadows built-in
    const report = engine.buildDoctorReport();
    expect(report).toContain("全局用户");
    expect(report).toContain("~/.config/opencode/ralph-flow/workflows/loop.yaml");
    expect(report).toContain("遮蔽了同名插件内置");
  });

  it("ensureProjectWorkflows creates both the project and the global dir", () => {
    engine.ensureProjectWorkflows();
    expect(fs.existsSync(engine.getProjectWorkflowsDir())).toBe(true);
    expect(fs.existsSync(engine.getGlobalWorkflowsDir()!)).toBe(true);
  });
});

// ─── Workflow loading / validation ───────────────────────────────────────────

describe("workflow loading", () => {
  it("loads a valid workflow with descriptions", () => {
    writeProjectWorkflow("test-wf", SIMPLE_WF);
    const wf = engine.loadWorkflow("test-wf");
    expect(wf).not.toBeNull();
    expect(wf!.steps.length).toBe(2);
    expect(wf!.description).toBe("test workflow");
  });

  it("rejects traversal and dotted workflow names", () => {
    expect(engine.loadWorkflow("../evil")).toBeNull();
    expect(engine.loadWorkflow(".hidden")).toBeNull();
    expect(engine.loadWorkflow("a/b")).toBeNull();
  });

  it("silently skips steps missing required fields but keeps the rest", () => {
    writeProjectWorkflow("partial", `
steps:
  - id: good
    desc: ok
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: good
    max_fail_count: 1
  - id: bad
    desc: missing everything else
    on_pass: done
    on_fail: bad
    max_fail_count: 1
`);
    const problems: string[] = [];
    const wf = engine.parseWorkflowFile(
      path.join(tmpDir, ".opencode", "ralph-flow", "workflows", "partial.yaml"), "partial", problems);
    expect(wf).not.toBeNull();
    expect(wf!.steps.length).toBe(1);
    expect(problems.some((p) => p.includes("bad"))).toBe(true);
  });

  it("collects WHY a workflow is invalid", () => {
    writeProjectWorkflow("broken", `
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: nonexistent
    on_fail: a
    max_fail_count: 1
`);
    const problems: string[] = [];
    expect(engine.loadWorkflow("broken", problems)).toBeNull();
    expect(problems.some((p) => p.includes("nonexistent"))).toBe(true);
  });

  it("hard-errors on duplicate step ids", () => {
    writeProjectWorkflow("dup", `
steps:
  - id: a
    desc: first
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
  - id: a
    desc: duplicate id
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    const problems: string[] = [];
    expect(engine.loadWorkflow("dup", problems)).toBeNull();
    expect(problems.some((p) => p.includes("重复") && p.includes("a"))).toBe(true);
  });

  it("hard-errors on manual_step referencing an unknown step", () => {
    writeProjectWorkflow("manual-typo", `
manual_step: [typo-step]
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    const problems: string[] = [];
    expect(engine.loadWorkflow("manual-typo", problems)).toBeNull();
    expect(problems.some((p) => p.includes("manual_step"))).toBe(true);
  });

  it("hard-errors on manual_step referencing a composite (sub-workflow) step", () => {
    writeProjectWorkflow("manual-composite", `
manual_step: [nest]
steps:
  - id: nest
    desc: nested
    workflow: child
    input: i
    output: o
    on_pass: done
    on_fail: nest
    max_fail_count: 1
`);
    const problems: string[] = [];
    expect(engine.loadWorkflow("manual-composite", problems)).toBeNull();
    expect(problems.some((p) => p.includes("子工作流") && p.includes("nest"))).toBe(true);
  });

  it("still accepts manual_step on a normal step alongside a composite step", () => {
    writeProjectWorkflow("manual-mixed", `
manual_step: [a]
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: nest
    on_fail: a
    max_fail_count: 1
  - id: nest
    desc: nested
    workflow: child
    input: i
    output: o
    on_pass: done
    on_fail: nest
    max_fail_count: 1
`);
    const problems: string[] = [];
    const wf = engine.loadWorkflow("manual-mixed", problems);
    expect(wf).not.toBeNull();
    expect(wf!.manual_step).toEqual(["a"]);
    expect(problems.length).toBe(0);
  });

  it("parses manual_step in both list and comma-string form", () => {
    writeProjectWorkflow("m1", `
manual_step: a
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    expect(engine.loadWorkflow("m1")!.manual_step).toEqual(["a"]);
  });

  it("parses adversarial_check with string model, object model, and caps timeout", () => {
    writeProjectWorkflow("adv", `
adversarial_check:
  model: anthropic/claude-sonnet-4-5
  timeout_ms: 99999999
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    const wf = engine.loadWorkflow("adv")!;
    expect(wf.adversarial_check!.model).toBe("anthropic/claude-sonnet-4-5");
    expect(wf.adversarial_check!.timeout_ms).toBe(3600000);
  });

  it("project workflow shadows plugin built-in; invalid project falls through", () => {
    // loop is a plugin built-in
    const builtIn = engine.loadWorkflow("loop");
    expect(builtIn).not.toBeNull();
    writeProjectWorkflow("loop", SIMPLE_WF);
    expect(engine.loadWorkflow("loop")!.description).toBe("test workflow");
    // invalid project file → falls back to built-in
    writeProjectWorkflow("loop", "steps: []");
    expect(engine.loadWorkflow("loop")!.description).toBe(builtIn!.description);
  });

  it("listWorkflows flags invalid definitions instead of hiding them", () => {
    writeProjectWorkflow("bad-only", "steps:\n  - id: x\n");
    const list = engine.listWorkflows();
    const bad = list.find((w) => w.name === "bad-only");
    expect(bad).toBeDefined();
    expect(bad!.desc).toContain("定义无效");
  });

  it("ships the built-in workflows", () => {
    const names = engine.listWorkflows().map((w) => w.name);
    for (const n of ["loop", "spec"]) {
      expect(names).toContain(n);
    }
  });
});

// ─── Lint / doctor ────────────────────────────────────────────────────────────

describe("lint and doctor", () => {
  it("flags unreachable steps and missing done", () => {
    writeProjectWorkflow("unreach", `
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: a
    on_fail: a
    max_fail_count: 1
  - id: island
    desc: never reached
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: island
    max_fail_count: 1
`);
    const raw = { steps: [] };
    const warnings = engine.lintWorkflow(engine.loadWorkflow("unreach")!, raw);
    expect(warnings.some((w) => w.includes("island") && w.includes("不可达"))).toBe(true);
    expect(warnings.some((w) => w.includes("无法正常完成"))).toBe(true);
  });

  it("flags unresolvable template tokens but not {{artifacts_dir}}", () => {
    writeProjectWorkflow("tokens", `
steps:
  - id: a
    desc: d
    do: "use {{artifacts_dir}} and {{ bad_token }}"
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    const warnings = engine.lintWorkflow(engine.loadWorkflow("tokens")!, {});
    expect(warnings.some((w) => w.includes("bad_token"))).toBe(true);
    expect(warnings.some((w) => w.includes("{{artifacts_dir}}") && w.includes("含模板变量 {{artifacts_dir}}"))).toBe(false);
  });

  it("flags broken sub-workflow references and cycles", () => {
    writeProjectWorkflow("subref", `
steps:
  - id: a
    desc: d
    workflow: does-not-exist
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    const warnings = engine.lintWorkflow(engine.loadWorkflow("subref")!, {});
    expect(warnings.some((w) => w.includes("does-not-exist"))).toBe(true);

    writeProjectWorkflow("cyc-a", `
steps:
  - id: s
    desc: d
    workflow: cyc-b
    input: i
    output: o
    on_pass: done
    on_fail: s
    max_fail_count: 1
`);
    writeProjectWorkflow("cyc-b", `
steps:
  - id: s
    desc: d
    workflow: cyc-a
    input: i
    output: o
    on_pass: done
    on_fail: s
    max_fail_count: 1
`);
    const cycEngine = makeEngine();
    const warnings2 = cycEngine.lintWorkflow(cycEngine.loadWorkflow("cyc-a")!, {});
    expect(warnings2.some((w) => w.includes("成环"))).toBe(true);
  });

  it("doctor reports shadowing, strays, and corrupt instances", () => {
    writeProjectWorkflow("loop", SIMPLE_WF); // shadows built-in
    fs.writeFileSync(path.join(tmpDir, ".opencode", "ralph-flow", "workflows", "notes.yaml"), "just: notes");
    const instDir = path.join(tmpDir, ".opencode", "ralph-flow", "instances", "corrupt-1");
    fs.mkdirSync(instDir, { recursive: true });
    fs.writeFileSync(path.join(instDir, "state.json"), "{ not json");
    const report = engine.buildDoctorReport();
    expect(report).toContain("遮蔽了同名插件内置");
    expect(report).toContain("notes.yaml");
    expect(report).toContain("corrupt-1");
  });

  it("doctor shouts when an invalid project file falls back to a built-in", () => {
    writeProjectWorkflow("loop", "steps: []");
    const report = engine.buildDoctorReport();
    expect(report).toContain("启动的不是你这份");
  });

  it("drops an object model missing providerID and the linter warns", () => {
    writeProjectWorkflow("adv-badobj", `
adversarial_check:
  model:
    modelID: claude-sonnet-4-5
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    const wf = engine.loadWorkflow("adv-badobj")!;
    // Half-specified object: unusable → dropped at parse time (agent default).
    expect(wf.adversarial_check!.model).toBeUndefined();
    const warnings = engine.lintWorkflow(wf, { adversarial_check: { model: { modelID: "claude-sonnet-4-5" } } });
    expect(warnings.some((w) => w.includes("providerID"))).toBe(true);
  });

  it("keeps a fully-specified object model, trimming both ids", () => {
    writeProjectWorkflow("adv-goodobj", `
adversarial_check:
  model:
    providerID: " anthropic "
    modelID: claude-sonnet-4-5
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    const wf = engine.loadWorkflow("adv-goodobj")!;
    expect(wf.adversarial_check!.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
  });
});

// ─── Reset Gate (shouldResetOnTransition, YAML validation, lint) ─────────────

describe("reset gate", () => {
  it("same step without reset → false (retry, keep the scene)", () => {
    writeProjectWorkflow("rwf", SIMPLE_WF);
    const wf = engine.loadWorkflow("rwf")!;
    expect(shouldResetOnTransition(wf, "one", "one")).toBe(false);
  });

  it("same step with target step reset → true (retry also resets)", () => {
    writeProjectWorkflow("rwf", SIMPLE_WF.replace("desc: first step", "desc: first step\n    reset: true"));
    const wf = engine.loadWorkflow("rwf")!;
    expect(shouldResetOnTransition(wf, "one", "one")).toBe(true);
  });

  it("cross-step without reset or auto_reset → false", () => {
    writeProjectWorkflow("rwf", SIMPLE_WF);
    const wf = engine.loadWorkflow("rwf")!;
    expect(shouldResetOnTransition(wf, "one", "two")).toBe(false);
  });

  it("cross-step with target step reset → true", () => {
    writeProjectWorkflow("rwf", SIMPLE_WF.replace("desc: second step", "desc: second step\n    reset: true"));
    const wf = engine.loadWorkflow("rwf")!;
    expect(shouldResetOnTransition(wf, "one", "two")).toBe(true);
  });

  it("auto_reset: true → every transition triggers, including same-step retry", () => {
    writeProjectWorkflow("rwf", `auto_reset: true\n${SIMPLE_WF}`);
    const wf = engine.loadWorkflow("rwf")!;
    expect(shouldResetOnTransition(wf, "one", "two")).toBe(true);
    expect(shouldResetOnTransition(wf, "one", "one")).toBe(true);
  });

  it("auto_reset false → behaves like not set", () => {
    writeProjectWorkflow("rwf", `auto_reset: false\n${SIMPLE_WF}`);
    const wf = engine.loadWorkflow("rwf")!;
    expect(shouldResetOnTransition(wf, "one", "two")).toBe(false);
  });

  it("composite step with reset: true", () => {
    writeProjectWorkflow("rwf", `
auto_reset: false
steps:
  - id: a
    desc: first
    do: x
    check: y
    input: i
    output: o
    on_pass: nest
    on_fail: a
    max_fail_count: 1
  - id: nest
    desc: nested
    workflow: child
    reset: true
    input: i
    output: o
    on_pass: done
    on_fail: nest
    max_fail_count: 1
`);
    const wf = engine.loadWorkflow("rwf")!;
    expect(shouldResetOnTransition(wf, "a", "nest")).toBe(true);
    expect(shouldResetOnTransition(wf, "nest", "nest")).toBe(true);
  });

  it("parseWorkflowFile rejects non-boolean reset on step", () => {
    writeProjectWorkflow("bad-reset", `
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
    reset: "yes"
  - id: b
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: b
    max_fail_count: 1
`);
    const problems: string[] = [];
    const wf = engine.parseWorkflowFile(
      path.join(tmpDir, ".opencode", "ralph-flow", "workflows", "bad-reset.yaml"), "bad-reset", problems);
    expect(wf).not.toBeNull();
    expect(wf!.steps.length).toBe(1);
    expect(problems.some((p) => p.includes("reset") && p.includes("boolean"))).toBe(true);
  });

  it("parseWorkflowFile rejects non-boolean auto_reset", () => {
    writeProjectWorkflow("bad-auto", `auto_reset: 1\n${SIMPLE_WF}`);
    const problems: string[] = [];
    const wf = engine.loadWorkflow("bad-auto", problems);
    expect(wf).not.toBeNull();
    expect(wf!.auto_reset).toBe(false);
    expect(problems.some((p) => p.includes("auto_reset") && p.includes("boolean"))).toBe(true);
  });

  it("parseWorkflowFile accepts boolean auto_reset and passthrough", () => {
    writeProjectWorkflow("good-auto", `auto_reset: true\n${SIMPLE_WF}`);
    const wf = engine.loadWorkflow("good-auto")!;
    expect(wf.auto_reset).toBe(true);
  });

  it("lintWorkflow warns about reset on first step", () => {
    writeProjectWorkflow("rwf", SIMPLE_WF.replace("desc: first step", "desc: first step\n    reset: true"));
    const wf = engine.loadWorkflow("rwf")!;
    const warnings = engine.lintWorkflow(wf, {});
    expect(warnings.some((w) => w.includes("首步") && w.includes("one") && w.includes("reset"))).toBe(true);
  });

  it("lintWorkflow skips reset cost warnings for builtin workflows", () => {
    writeProjectWorkflow("rwf", SIMPLE_WF.replace("desc: first step", "desc: first step\n    reset: true"));
    const wf = engine.loadWorkflow("rwf")!;
    const warnings = engine.lintWorkflow(wf, {}, true);
    expect(warnings.some((w) => w.includes("首步") && w.includes("reset"))).toBe(false);
  });

  it("lintWorkflow warns about auto_reset on linear-only flow", () => {
    writeProjectWorkflow("lin", `
auto_reset: true
steps:
  - id: a
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: a
    max_fail_count: 1
`);
    const wf = engine.loadWorkflow("lin")!;
    const warnings = engine.lintWorkflow(wf, {});
    expect(warnings.some((w) => w.includes("auto_reset") && w.includes("纯线性"))).toBe(true);
  });
});

// ─── adversarial_check inheritance (Java-style field-level) ─────────────────

describe("adversarial_check field-level inheritance", () => {
  const PARENT_CFG_WF = `
adversarial_check:
  model: anthropic/claude-haiku-4-5
  timeout_ms: 1200000
steps:
  - id: p
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: p
    max_fail_count: 1
`;
  const CHILD_NO_CFG = `
steps:
  - id: c
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: c
    max_fail_count: 1
`;
  const pushParent = (instId: string, wfName = "parent") =>
    engine.pushState({ active: true, workflow_name: wfName, current_step: "p", current_phase: "do", fail_count: 0, user_task: "t", paused: false }, instId);

  beforeEach(() => {
    writeProjectWorkflow("parent", PARENT_CFG_WF);
    writeProjectWorkflow("child", CHILD_NO_CFG);
  });

  it("returns undefined when nobody configures anything", () => {
    const instId = startInstance("child");
    expect(engine.getEffectiveAdversarialCheck(instId, engine.loadWorkflow("child")!)).toBeUndefined();
  });

  it("top-level workflow (empty stack) uses its own config as-is", () => {
    const instId = startInstance("parent");
    const eff = engine.getEffectiveAdversarialCheck(instId, engine.loadWorkflow("parent")!)!;
    expect(eff.model).toBe("anthropic/claude-haiku-4-5");
    expect(eff.timeout_ms).toBe(1200000);
  });

  it("child without config inherits every parent field", () => {
    const instId = startInstance("child");
    pushParent(instId);
    const eff = engine.getEffectiveAdversarialCheck(instId, engine.loadWorkflow("child")!)!;
    expect(eff.model).toBe("anthropic/claude-haiku-4-5");
    expect(eff.timeout_ms).toBe(1200000);
  });

  it("child's valid model wins; fields it doesn't set still inherit", () => {
    writeProjectWorkflow("child-model", `
adversarial_check:
  model: openai/gpt-5
steps:
  - id: c
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: c
    max_fail_count: 1
`);
    const instId = startInstance("child-model");
    pushParent(instId);
    const eff = engine.getEffectiveAdversarialCheck(instId, engine.loadWorkflow("child-model")!)!;
    expect(eff.model).toBe("openai/gpt-5");        // child's own
    expect(eff.timeout_ms).toBe(1200000);          // inherited from parent
  });

  it("child's UNRESOLVABLE model does not shadow the parent's valid one", () => {
    writeProjectWorkflow("child-bare", `
adversarial_check:
  model: sonnet
steps:
  - id: c
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: c
    max_fail_count: 1
`);
    const instId = startInstance("child-bare");
    pushParent(instId);
    const eff = engine.getEffectiveAdversarialCheck(instId, engine.loadWorkflow("child-bare")!)!;
    // "有自定义且有效才用子类"：裸名无法解析 → 回退父工作流的有效 model
    expect(eff.model).toBe("anthropic/claude-haiku-4-5");
    expect(eff.timeout_ms).toBe(1200000);
  });

  it("nearest ancestor wins when the chain is deeper", () => {
    writeProjectWorkflow("grandparent", `
adversarial_check:
  model: google/gemini-3-pro
  agent: some-other-agent
steps:
  - id: g
    desc: d
    do: x
    check: y
    input: i
    output: o
    on_pass: done
    on_fail: g
    max_fail_count: 1
`);
    const instId = startInstance("child");
    pushParent(instId, "grandparent"); // outermost first
    pushParent(instId);                // then the nearer parent
    const eff = engine.getEffectiveAdversarialCheck(instId, engine.loadWorkflow("child")!)!;
    expect(eff.model).toBe("anthropic/claude-haiku-4-5"); // parent beats grandparent
    expect(eff.agent).toBe("some-other-agent");           // only grandparent defines it
  });
});

// ─── Instance infrastructure ─────────────────────────────────────────────────

describe("instances", () => {
  beforeEach(() => writeProjectWorkflow("test-wf", SIMPLE_WF));

  it("generates valid ids", () => {
    const id = engine.generateInstanceId("Test Workflow!");
    expect(engine.isValidInstanceId(id)).toBe(true);
    expect(id.startsWith("test-workflow-")).toBe(true);
  });

  it("creates, lists and destroys an instance with report archive", () => {
    const instId = startInstance();
    const list = engine.listInstances();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(instId);
    expect(list[0].owner).toBe("sess-1");

    const reportPath = engine.destroyInstance(instId, "cancelled");
    expect(reportPath).not.toBeNull();
    expect(fs.existsSync(reportPath!)).toBe(true);
    expect(fs.readFileSync(reportPath!, "utf-8")).toContain("已取消");
    expect(engine.listInstances().length).toBe(0);
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
  });

  it("artifacts dir name slugs the task and survives destruction only when non-empty", () => {
    const instId = startInstance("test-wf", "把 emoji 🚀 截断测试");
    const artifacts = engine.getArtifactsDir(instId);
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, "out.md"), "deliverable");
    engine.destroyInstance(instId, "completed");
    expect(fs.existsSync(artifacts)).toBe(true); // non-empty survives

    const instId2 = startInstance("test-wf", "empty artifacts");
    const artifacts2 = engine.getArtifactsDir(instId2);
    fs.mkdirSync(artifacts2, { recursive: true });
    engine.destroyInstance(instId2, "completed");
    expect(fs.existsSync(artifacts2)).toBe(false); // empty removed
  });

  it("artifacts dir name never cuts an emoji in half", () => {
    const instId = startInstance("test-wf", "🚀".repeat(40));
    const name = path.basename(engine.getArtifactsDir(instId));
    expect(name.includes("�")).toBe(false);
  });

  it("resolveInstance: session-owned, explicit prefix, ambiguity, single-instance attach", () => {
    const id1 = startInstance("test-wf", "t", "sess-1");
    const id2 = startInstance("test-wf", "t", "sess-2");
    expect(id1).not.toBe(id2);

    // A session sees the instance it owns without an explicit id (not attached).
    const own1 = engine.resolveInstance(undefined, "sess-1");
    expect(own1.ok && own1.id === id1 && own1.attached === false).toBe(true);

    // Explicit unique prefix resolves; from a third session it's an attach.
    const r1 = engine.resolveInstance(id1.slice(0, id1.length - 2), "sess-3");
    expect(r1.ok && r1.id === id1 && (r1 as any).attached === true).toBe(true);

    // Ambiguous prefix rejected.
    const r2 = engine.resolveInstance("te", "sess-3");
    expect(r2.ok).toBe(false);

    // A session that owns none, with two instances → list returned.
    const r3 = engine.resolveInstance(undefined, "sess-3");
    expect(r3.ok).toBe(false);
    expect((r3 as any).text).toContain("工作流实例");

    // Down to one instance → auto-attach for any session.
    engine.destroyInstance(id2, "cancelled");
    const r4 = engine.resolveInstance(undefined, "sess-3");
    expect(r4.ok && r4.id === id1 && (r4 as any).attached === true).toBe(true);
  });

  it("markers arm and clear", () => {
    startInstance();
    engine.writeManualStepMarker(INST);
    expect(engine.markerExists(".manual-step-active", INST)).toBe(true);
    engine.clearManualStepMarker(INST);
    expect(engine.markerExists(".manual-step-active", INST)).toBe(false);
  });

  it("never resurrects a destroyed instance via marker writes", () => {
    const instId = startInstance();
    engine.destroyInstance(instId, "cancelled");
    engine.writeDoPromptCache("stale", instId);
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
  });

  it("backs up corrupted state files instead of crashing", () => {
    const instId = startInstance();
    fs.writeFileSync(path.join(engine.getInstanceDir(instId), "state.json"), "{ nope");
    expect(engine.readState(instId)).toBeNull();
    const files = fs.readdirSync(engine.getInstanceDir(instId));
    expect(files.some((f) => f.includes("corrupted"))).toBe(true);
  });
});

// ─── Prompts ─────────────────────────────────────────────────────────────────

describe("prompts", () => {
  beforeEach(() => writeProjectWorkflow("test-wf", SIMPLE_WF));

  it("DO prompt carries task sections, artifacts dir, and caches itself", () => {
    const instId = startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    const prompt = engine.buildDoPrompt(INST, wf.steps[0] as any, "my task");
    expect(prompt).toContain("## 用户需求");
    expect(prompt).toContain("my task");
    expect(prompt).toContain("产出目录");
    expect(prompt).toContain(".opencode/ralph-flow/artifacts/");
    expect(prompt).toContain("<promise>done</promise>");
    const cached = fs.readFileSync(path.join(engine.getInstanceDir(instId), ".do-prompt-cache"), "utf-8");
    expect(cached).toBe(prompt);
  });

  it("retry prompt includes failure reason and retry count", () => {
    startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    const prompt = engine.buildDoPrompt(INST, wf.steps[0] as any, "t", "it broke", 2);
    expect(prompt).toContain("上次失败原因");
    expect(prompt).toContain("it broke");
    expect(prompt).toContain("第 **2** 次重试");
    expect(prompt).toContain("不要重复之前未通过的做法");
  });

  it("CHECK prompt is self-contained with verdict tag instructions", () => {
    startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    const prompt = engine.buildCheckPrompt(INST, wf.steps[0] as any, "t");
    expect(prompt).toContain("检查依据");
    expect(prompt).toContain("<promise-check>true</promise-check>");
    expect(prompt).toContain("产出目录");
  });

  it("renders {{artifacts_dir}} tokens in step text", () => {
    startInstance();
    expect(engine.renderStepText(INST, "see {{artifacts_dir}}/x.md")).toContain(".opencode/ralph-flow/artifacts/");
  });
});

// ─── Check-result parsing ────────────────────────────────────────────────────

describe("check result parsing", () => {
  it("accepts the tag only on the last line", () => {
    expect(engine.parseCheckResult("reasons\n<promise-check>true</promise-check>")).toBe(true);
    expect(engine.parseCheckResult("reasons\n<promise-check>false</promise-check>")).toBe(false);
    expect(engine.parseCheckResult("<promise-check>true</promise-check>\ntrailing text")).toBe(false);
    expect(engine.parseCheckResult("no tag at all")).toBe(false);
  });

  it("extracts the reason and truncates long ones", () => {
    expect(engine.getAdversarialCheckReason("because\n<promise-check>false</promise-check>")).toBe("because");
    const long = "x".repeat(6000) + "\n<promise-check>false</promise-check>";
    expect(engine.getAdversarialCheckReason(long).length).toBeLessThanOrEqual(5003);
  });
});

// ─── Transitions ─────────────────────────────────────────────────────────────

describe("transitions", () => {
  beforeEach(() => writeProjectWorkflow("test-wf", SIMPLE_WF));

  it("check passed advances to next step with its DO prompt", () => {
    startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    const state = engine.readState(INST)!;
    const result = engine.handleCheckPassed(INST, state, wf, wf.steps[0], { reason: "looks good" });
    expect(result.text).toContain("检查结果：通过");
    expect(result.text).toContain("**two**");
    const newState = engine.readState(INST)!;
    expect(newState.current_step).toBe("two");
    expect(newState.current_phase).toBe("do");
    expect(newState.fail_count).toBe(0);
  });

  it("check passed on the last step completes and destroys the instance", () => {
    const instId = startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    engine.writeState({ ...engine.readState(INST)!, current_step: "two", current_phase: "check" }, INST);
    const result = engine.handleCheckPassed(INST, engine.readState(INST)!, wf, wf.steps[1], { reason: "done" });
    expect(result.completed).toBe(true);
    expect(result.text).toContain("工作流完成");
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
    const reports = fs.readdirSync(engine.getReportsDir());
    expect(reports.some((f) => f.startsWith(instId))).toBe(true);
  });

  it("completion archives the execution log next to the final report", () => {
    const instId = startInstance();
    engine.logEvent(INST, "info", "adversarial_check_start", { stepId: "two", model_source: "workflow" });
    const wf = engine.loadWorkflow("test-wf")!;
    engine.writeState({ ...engine.readState(INST)!, current_step: "two", current_phase: "check" }, INST);
    engine.handleCheckPassed(INST, engine.readState(INST)!, wf, wf.steps[1], { reason: "done" });
    const archivedLog = path.join(engine.getReportsDir(), `${instId}-execution.log`);
    expect(fs.existsSync(archivedLog)).toBe(true);
    expect(fs.readFileSync(archivedLog, "utf-8")).toContain("adversarial_check_start");
    expect(fs.readFileSync(archivedLog, "utf-8")).toContain("workflow");
  });

  it("check failed retries with reason; max failures pause", () => {
    startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    let state = engine.readState(INST)!;
    let result = engine.handleCheckFailed(INST, state, wf, wf.steps[0], { reason: "missing file" });
    expect(result.text).toContain("失败 ✗ (1/3)");
    expect(result.text).toContain("missing file");
    expect(engine.readState(INST)!.fail_count).toBe(1);

    engine.writeState({ ...engine.readState(INST)!, fail_count: 2 }, INST);
    result = engine.handleCheckFailed(INST, engine.readState(INST)!, wf, wf.steps[0], { reason: "still broken" });
    expect(result.paused).toBe(true);
    const paused = engine.readState(INST)!;
    expect(paused.paused).toBe(true);
    expect(paused.pause_reason).toBe("max_failures");
  });

  it("pauses with config_error when on_pass target is missing at runtime", () => {
    writeProjectWorkflow("test-wf2", SIMPLE_WF.replace("on_pass: two", "on_pass: two"));
    startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    const state = engine.readState(INST)!;
    const fakeStep = { ...(wf.steps[0] as any), on_pass: "ghost" };
    const result = engine.handleCheckPassed(INST, state, wf, fakeStep, { reason: "ok" });
    expect(result.paused).toBe(true);
    expect(engine.readState(INST)!.pause_reason).toBe("config_error");
  });
});

// ─── Sub-workflows ───────────────────────────────────────────────────────────

describe("sub-workflows", () => {
  beforeEach(() => {
    writeProjectWorkflow("child", `
steps:
  - id: c1
    desc: child step
    do: child work
    check: child check
    input: i
    output: o
    on_pass: done
    on_fail: c1
    max_fail_count: 2
`);
    writeProjectWorkflow("parent", `
steps:
  - id: p1
    desc: parent first
    do: parent work
    check: parent check
    input: i
    output: o
    on_pass: p2
    on_fail: p1
    max_fail_count: 2
  - id: p2
    desc: delegate
    workflow: child
    inputs:
      hint: from parent
    input: i
    output: o
    on_pass: done
    on_fail: p2
    max_fail_count: 2
`);
  });

  it("entering a sub-workflow pushes parent and rewrites state", () => {
    startInstance("parent");
    const wf = engine.loadWorkflow("parent")!;
    const result = engine.handleCheckPassed(INST, engine.readState(INST)!, wf, wf.steps[0], { reason: "ok" });
    expect(result.text).toContain("进入子工作流");
    expect(result.text).toContain("child work");
    const state = engine.readState(INST)!;
    expect(state.workflow_name).toBe("child");
    expect(state.current_step).toBe("c1");
    expect(state.user_task).toContain("hint: from parent");
    expect(engine.getStackDepth(INST)).toBe(1);
  });

  it("sub-workflow completion pops back and completes the parent chain", () => {
    const instId = startInstance("parent");
    const parentWf = engine.loadWorkflow("parent")!;
    engine.handleCheckPassed(INST, engine.readState(INST)!, parentWf, parentWf.steps[0], { reason: "ok" });
    // Now inside child; child c1 passes → child done → parent p2 on_pass done → workflow completes
    const childWf = engine.loadWorkflow("child")!;
    const result = engine.handleCheckPassed(INST, engine.readState(INST)!, childWf, childWf.steps[0], { reason: "child ok" });
    expect(result.completed).toBe(true);
    expect(result.text).toContain('子工作流 "child" 已完成');
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
  });

  it("sub-workflow max failure escalates to parent's on_fail", () => {
    startInstance("parent");
    const parentWf = engine.loadWorkflow("parent")!;
    engine.handleCheckPassed(INST, engine.readState(INST)!, parentWf, parentWf.steps[0], { reason: "ok" });
    const childWf = engine.loadWorkflow("child")!;
    // child fails twice (max_fail_count 2) → escalate to parent p2's on_fail = p2 → re-enter child
    engine.writeState({ ...engine.readState(INST)!, fail_count: 1 }, INST);
    const result = engine.handleCheckFailed(INST, engine.readState(INST)!, childWf, childWf.steps[0], { reason: "child broken" });
    const state = engine.readState(INST)!;
    // Parent p2 on_fail is p2 (a sub-workflow step) → re-enters child fresh
    expect(state.workflow_name).toBe("child");
    expect(state.current_step).toBe("c1");
    expect(result.text).toContain("失败");
  });

  it("nesting depth is capped", () => {
    startInstance("parent");
    for (let i = 0; i < 5; i++) {
      engine.pushState(engine.readState(INST)!, INST);
    }
    const wf = engine.loadWorkflow("parent")!;
    const result = engine.resolveSubWorkflowEntry(INST, "child", "t", wf.steps[1] as any);
    expect(result.error).toBe(true);
    expect(result.text).toContain("嵌套深度");
  });
});

// ─── Legacy migration ────────────────────────────────────────────────────────

describe("legacy migration", () => {
  it("migrates an active pre-2.0 state file into the instances layout", () => {
    const dir = path.join(tmpDir, ".opencode", "ralph-flow");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ralph-flow.local.md"), `---
active: true
workflow_name: loop
current_step: loop
current_phase: do
fail_count: 1
user_task: migrate\\nme
paused: false
session_id: old-session
last_failure_reason: it failed
---
`);
    engine.migrateLegacyInstance();
    expect(fs.existsSync(path.join(dir, "ralph-flow.local.md"))).toBe(false);
    const instances = engine.listInstances();
    expect(instances.length).toBe(1);
    expect(instances[0].state.workflow_name).toBe("loop");
    expect(instances[0].state.fail_count).toBe(1);
    expect(instances[0].state.user_task).toBe("migrate\nme");
    expect(instances[0].owner).toBe("old-session"); // preserved; a new session takes over via continue
  });

  it("parks an inactive legacy state file without creating an instance", () => {
    const dir = path.join(tmpDir, ".opencode", "ralph-flow");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ralph-flow.local.md"), `---
active: false
workflow_name: loop
current_step: loop
current_phase: do
fail_count: 0
user_task: t
paused: false
---
`);
    engine.migrateLegacyInstance();
    expect(engine.listInstances().length).toBe(0);
    expect(fs.existsSync(path.join(dir, "ralph-flow.local.md.pre-migration-backup"))).toBe(true);
  });
});

// ─── State stack robustness ──────────────────────────────────────────────────

describe("state stack", () => {
  beforeEach(() => writeProjectWorkflow("test-wf", SIMPLE_WF));

  it("push/pop round-trips and empty pop returns null", () => {
    startInstance();
    const s = engine.readState(INST)!;
    engine.pushState(s, INST);
    engine.pushState({ ...s, current_step: "two" }, INST);
    expect(engine.getStackDepth(INST)).toBe(2);
    expect(engine.popState(INST)!.current_step).toBe("two");
    expect(engine.popState(INST)!.current_step).toBe("one");
    expect(engine.popState(INST)).toBeNull();
  });

  it("recovers from a corrupted stack file", () => {
    const instId = startInstance();
    fs.writeFileSync(path.join(engine.getInstanceDir(instId), "state-stack.json"), "[ nope");
    expect(engine.popState(INST)).toBeNull();
    engine.pushState(engine.readState(INST)!, INST);
    expect(engine.getStackDepth(INST)).toBe(1);
  });
});

// ─── passedStepIds（用于 /ralphflow-rewind 的"可回退目标"集合）─────────────

describe("passedStepIds", () => {
  const WF = `
description: passed collectors
steps:
  - id: a
    desc: a
    do: do a
    check: check a
    input: i
    output: "a.md"
    on_pass: b
    on_fail: a
    max_fail_count: 3
  - id: b
    desc: b
    do: do b
    check: check b
    input: a.md
    output: "b.md"
    on_pass: c
    on_fail: b
    max_fail_count: 3
  - id: c
    desc: c
    do: do c
    check: check c
    input: b.md
    output: "c.md"
    on_pass: done
    on_fail: c
    max_fail_count: 3
`;

  beforeEach(() => {
    writeProjectWorkflow("test-wf", SIMPLE_WF);
    writeProjectWorkflow("collectors", WF);
  });

  it("returns steps that have a check-passed record within this workflow", () => {
    const instId = engine.generateInstanceId("collectors");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.addStepRecord(instId, "a", "check", "passed", 0, "ok");
    engine.addStepRecord(instId, "b", "check", "passed", 0, "ok");
    // do 阶段的记录不算（只看 check passed）
    engine.addStepRecord(instId, "c", "do", "passed", 0, "ok");
    expect(engine.passedStepIds(instId, "collectors").sort()).toEqual(["a", "b"]);
  });

  it("filters out check-failed records (only passed counts)", () => {
    const instId = engine.generateInstanceId("collectors");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.addStepRecord(instId, "a", "check", "passed", 0, "ok");
    engine.addStepRecord(instId, "b", "check", "failed", 1, "nope");
    expect(engine.passedStepIds(instId, "collectors")).toEqual(["a"]);
  });

  it("deduplicates (a step that passed twice is listed once)", () => {
    const instId = engine.generateInstanceId("collectors");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.addStepRecord(instId, "a", "check", "passed", 0, "ok");
    engine.addStepRecord(instId, "a", "check", "passed", 1, "ok again");
    expect(engine.passedStepIds(instId, "collectors")).toEqual(["a"]);
  });

  it("only counts steps that belong to the target workflow (cross-workflow isolation)", () => {
    // 同一实例的 step records 可能混多工作流的记录（极少，但语义要稳）：
    // 查 collectors 时，one（test-wf 的步骤）不应被算进来——passedStepIds
    // 按目标 workflow.steps.id 集合过滤。
    const instId = engine.generateInstanceId("collectors");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.addStepRecord(instId, "a", "check", "passed", 0, "ok");
    engine.addStepRecord(instId, "one", "check", "passed", 0, "ok");
    expect(engine.passedStepIds(instId, "collectors")).toEqual(["a"]);
    // 反过来查 test-wf（SIMPLE_WF 的 workflow 名）：one 在它的 steps 里 → 被算上
    expect(engine.passedStepIds(instId, "test-wf")).toEqual(["one"]);
  });

  it("isolates same-named steps across stack frames via workflowName (nested workflows)", () => {
    // 父子工作流有同名步骤 id（如都叫 a）：子工作流里 a 的 check-passed 记录
    // 带 workflowName=child，查父工作流 collectors 时不应把父的 a 算作已通过。
    const instId = engine.generateInstanceId("collectors");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    // 子工作流栈帧产生的记录（同名步骤 a、b，但属于 child-wf）
    engine.addStepRecord(instId, "a", "check", "passed", 0, "ok", "child-wf");
    engine.addStepRecord(instId, "b", "check", "passed", 0, "ok", "child-wf");
    expect(engine.passedStepIds(instId, "collectors")).toEqual([]);
    // 父工作流自己的记录（workflowName=collectors）正常计入
    engine.addStepRecord(instId, "a", "check", "passed", 0, "ok", "collectors");
    expect(engine.passedStepIds(instId, "collectors")).toEqual(["a"]);
    // 查 child-wf 不存在 → []
    expect(engine.passedStepIds(instId, "child-wf")).toEqual([]);
  });

  it("legacy records without workflowName fall back to stepId-only matching", () => {
    // 2.7.1 之前的旧记录没有 workflowName：回退到仅按 stepId 过滤（历史不丢）。
    const instId = engine.generateInstanceId("collectors");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.addStepRecord(instId, "a", "check", "passed", 0, "ok"); // 无 workflowName
    expect(engine.passedStepIds(instId, "collectors")).toEqual(["a"]);
  });

  it("returns [] when the workflow is not found", () => {
    const instId = engine.generateInstanceId("nope");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.addStepRecord(instId, "a", "check", "passed", 0, "ok");
    expect(engine.passedStepIds(instId, "nonexistent-workflow")).toEqual([]);
  });

  it("returns [] when no check records exist for the instance", () => {
    const instId = engine.generateInstanceId("collectors");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    expect(engine.passedStepIds(instId, "collectors")).toEqual([]);
  });
});
