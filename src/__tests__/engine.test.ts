import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine } from "../engine.js";

let tmpDir: string;
let aliveSessions: Set<string>;
let engine: Engine;

function makeEngine(dir = tmpDir): Engine {
  const platform: Platform = {
    isSessionAlive: (id) => !!id && aliveSessions.has(id),
  };
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
function startInstance(wfName = "test-wf", task = "test task"): string {
  engine.beginOp("sess-1");
  const wf = engine.loadWorkflow(wfName)!;
  const instId = engine.generateInstanceId(wfName);
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, task);
  engine.setBoundInstance(instId);
  engine.writeState({ active: true, workflow_name: wfName, current_step: wf.steps[0].id, current_phase: "do", fail_count: 0, user_task: task, paused: false }, instId);
  engine.bindInstance(instId);
  return instId;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-test-"));
  aliveSessions = new Set(["sess-1"]);
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

  it("ships the four built-in workflows", () => {
    const names = engine.listWorkflows().map((w) => w.name);
    for (const n of ["loop", "spec", "c-to-rust", "everything2rust"]) {
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
    expect(list[0].ownerAlive).toBe(true);

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

  it("resolveInstance: explicit prefix, ambiguity, dead-owner auto-attach", () => {
    const id1 = startInstance();
    // same session may not start a second instance in real flow; simulate a
    // second instance owned by another session
    engine.beginOp("sess-2");
    aliveSessions.add("sess-2");
    const id2 = startInstance();
    expect(id1).not.toBe(id2);

    // Explicit unique prefix resolves
    engine.beginOp("sess-3");
    const r1 = engine.resolveInstance(id1.slice(0, id1.length - 2));
    expect(r1.ok && r1.id === id1).toBe(true);

    // Ambiguous prefix rejected
    const common = "te"; // both start with test-wf-
    const r2 = engine.resolveInstance(common);
    expect(r2.ok).toBe(false);

    // No explicit id, two instances with alive owners → list returned
    const r3 = engine.resolveInstance();
    expect(r3.ok).toBe(false);
    expect((r3 as any).text).toContain("工作流实例");

    // Kill one owner; still two instances → explicit required, but single
    // dead-owner instance auto-attaches when the other is gone
    engine.destroyInstance(id2, "cancelled");
    aliveSessions.delete("sess-1");
    engine.beginOp("sess-3");
    const r4 = engine.resolveInstance();
    expect(r4.ok && r4.id === id1 && (r4 as any).attached).toBe(true);
  });

  it("markers arm and clear", () => {
    startInstance();
    engine.writeManualStepMarker();
    expect(engine.markerExists(".manual-step-active")).toBe(true);
    engine.clearManualStepMarker();
    expect(engine.markerExists(".manual-step-active")).toBe(false);
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
    const prompt = engine.buildDoPrompt(wf.steps[0] as any, "my task");
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
    const prompt = engine.buildDoPrompt(wf.steps[0] as any, "t", "it broke", 2);
    expect(prompt).toContain("上次失败原因");
    expect(prompt).toContain("it broke");
    expect(prompt).toContain("第 **2** 次重试");
    expect(prompt).toContain("不要重复之前未通过的做法");
  });

  it("CHECK prompt is self-contained with verdict tag instructions", () => {
    startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    const prompt = engine.buildCheckPrompt(wf.steps[0] as any, "t");
    expect(prompt).toContain("检查依据");
    expect(prompt).toContain("<promise-check>true</promise-check>");
    expect(prompt).toContain("产出目录");
  });

  it("renders {{artifacts_dir}} tokens in step text", () => {
    startInstance();
    expect(engine.renderStepText("see {{artifacts_dir}}/x.md")).toContain(".opencode/ralph-flow/artifacts/");
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
    const state = engine.readState()!;
    const result = engine.handleCheckPassed(state, wf, wf.steps[0], { reason: "looks good" });
    expect(result.text).toContain("检查结果：通过");
    expect(result.text).toContain("**two**");
    const newState = engine.readState()!;
    expect(newState.current_step).toBe("two");
    expect(newState.current_phase).toBe("do");
    expect(newState.fail_count).toBe(0);
  });

  it("check passed on the last step completes and destroys the instance", () => {
    const instId = startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    engine.writeState({ ...engine.readState()!, current_step: "two", current_phase: "check" });
    const result = engine.handleCheckPassed(engine.readState()!, wf, wf.steps[1], { reason: "done" });
    expect(result.completed).toBe(true);
    expect(result.text).toContain("工作流完成");
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
    const reports = fs.readdirSync(engine.getReportsDir());
    expect(reports.some((f) => f.startsWith(instId))).toBe(true);
  });

  it("check failed retries with reason; max failures pause", () => {
    startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    let state = engine.readState()!;
    let result = engine.handleCheckFailed(state, wf, wf.steps[0], { reason: "missing file" });
    expect(result.text).toContain("失败 ✗ (1/3)");
    expect(result.text).toContain("missing file");
    expect(engine.readState()!.fail_count).toBe(1);

    engine.writeState({ ...engine.readState()!, fail_count: 2 });
    result = engine.handleCheckFailed(engine.readState()!, wf, wf.steps[0], { reason: "still broken" });
    expect(result.paused).toBe(true);
    const paused = engine.readState()!;
    expect(paused.paused).toBe(true);
    expect(paused.pause_reason).toBe("max_failures");
  });

  it("pauses with config_error when on_pass target is missing at runtime", () => {
    writeProjectWorkflow("test-wf2", SIMPLE_WF.replace("on_pass: two", "on_pass: two"));
    startInstance();
    const wf = engine.loadWorkflow("test-wf")!;
    const state = engine.readState()!;
    const fakeStep = { ...(wf.steps[0] as any), on_pass: "ghost" };
    const result = engine.handleCheckPassed(state, wf, fakeStep, { reason: "ok" });
    expect(result.paused).toBe(true);
    expect(engine.readState()!.pause_reason).toBe("config_error");
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
    const result = engine.handleCheckPassed(engine.readState()!, wf, wf.steps[0], { reason: "ok" });
    expect(result.text).toContain("进入子工作流");
    expect(result.text).toContain("child work");
    const state = engine.readState()!;
    expect(state.workflow_name).toBe("child");
    expect(state.current_step).toBe("c1");
    expect(state.user_task).toContain("hint: from parent");
    expect(engine.getStackDepth()).toBe(1);
  });

  it("sub-workflow completion pops back and completes the parent chain", () => {
    const instId = startInstance("parent");
    const parentWf = engine.loadWorkflow("parent")!;
    engine.handleCheckPassed(engine.readState()!, parentWf, parentWf.steps[0], { reason: "ok" });
    // Now inside child; child c1 passes → child done → parent p2 on_pass done → workflow completes
    const childWf = engine.loadWorkflow("child")!;
    const result = engine.handleCheckPassed(engine.readState()!, childWf, childWf.steps[0], { reason: "child ok" });
    expect(result.completed).toBe(true);
    expect(result.text).toContain('子工作流 "child" 已完成');
    expect(fs.existsSync(engine.getInstanceDir(instId))).toBe(false);
  });

  it("sub-workflow max failure escalates to parent's on_fail", () => {
    startInstance("parent");
    const parentWf = engine.loadWorkflow("parent")!;
    engine.handleCheckPassed(engine.readState()!, parentWf, parentWf.steps[0], { reason: "ok" });
    const childWf = engine.loadWorkflow("child")!;
    // child fails twice (max_fail_count 2) → escalate to parent p2's on_fail = p2 → re-enter child
    engine.writeState({ ...engine.readState()!, fail_count: 1 });
    const result = engine.handleCheckFailed(engine.readState()!, childWf, childWf.steps[0], { reason: "child broken" });
    const state = engine.readState()!;
    // Parent p2 on_fail is p2 (a sub-workflow step) → re-enters child fresh
    expect(state.workflow_name).toBe("child");
    expect(state.current_step).toBe("c1");
    expect(result.text).toContain("失败");
  });

  it("nesting depth is capped", () => {
    startInstance("parent");
    for (let i = 0; i < 5; i++) {
      engine.pushState(engine.readState()!);
    }
    const wf = engine.loadWorkflow("parent")!;
    const result = engine.resolveSubWorkflowEntry("child", "t", wf.steps[1] as any);
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
    expect(instances[0].owner).toBe("old-session");
    expect(instances[0].ownerAlive).toBe(false); // takeover journey
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
    const s = engine.readState()!;
    engine.pushState(s);
    engine.pushState({ ...s, current_step: "two" });
    expect(engine.getStackDepth()).toBe(2);
    expect(engine.popState()!.current_step).toBe("two");
    expect(engine.popState()!.current_step).toBe("one");
    expect(engine.popState()).toBeNull();
  });

  it("recovers from a corrupted stack file", () => {
    const instId = startInstance();
    fs.writeFileSync(path.join(engine.getInstanceDir(instId), "state-stack.json"), "[ nope");
    expect(engine.popState()).toBeNull();
    engine.pushState(engine.readState()!);
    expect(engine.getStackDepth()).toBe(1);
  });
});
