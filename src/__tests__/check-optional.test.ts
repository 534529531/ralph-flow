import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine } from "../engine.js";

/**
 * 对抗性 check 可选化(与 Claude Code 版 43c0ae8 镜像,见 SYNC.md 镜像部分)。
 * 核心语义:步骤可以完全不写 check/check_voting —— 不再被静默丢弃,而是作为
 * "跳过对抗性验证"的合法步骤,DO 完成后直接走 on_pass。manual_step 默认由人工
 * 审查门替代验证(除非显式写了 check)。
 */

let tmpDir: string;
let engine: Engine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-check-optional-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeWorkflow(yaml: string, name = "opt-wf"): string {
  const dir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yaml`), yaml, "utf-8");
  return name;
}

const BASE = `name: opt-wf
description: test
manual_step: []
steps:
  - id: s1
    desc: d
    do: do it
    input: in
    output: out
    on_pass: done
    on_fail: s1
    max_fail_count: 3`;

describe("check optional: no check → valid no-verify step", () => {
  it("a step with no check/check_voting loads as a valid no_check step (not dropped)", () => {
    writeWorkflow(BASE);
    const problems: string[] = [];
    const wf = engine.loadWorkflow("opt-wf", problems);
    expect(wf).not.toBeNull();
    expect(wf!.steps).toHaveLength(1);
    expect((wf!.steps[0] as any).no_check).toBe(true);
  });

  it("a step with an empty-string check is treated as no check", () => {
    writeWorkflow(`${BASE}
    check: ""`);
    const wf = engine.loadWorkflow("opt-wf", []);
    expect(wf).not.toBeNull();
    expect((wf!.steps[0] as any).no_check).toBe(true);
  });

  it("a step with a real string check is NOT no_check (backward compat)", () => {
    writeWorkflow(`${BASE}
    check: 验证一下`);
    const wf = engine.loadWorkflow("opt-wf", []);
    expect(wf).not.toBeNull();
    expect((wf!.steps[0] as any).no_check).toBeUndefined();
  });
});

describe("check optional: hard errors instead of silent skips", () => {
  it("a non-string check (check: true) is a hard config error", () => {
    writeWorkflow(`${BASE}
    check: true`);
    const problems: string[] = [];
    const wf = engine.loadWorkflow("opt-wf", problems);
    expect(wf).toBeNull();
    expect(problems.some((p) => p.includes("'check' 必须是字符串"))).toBe(true);
  });

  it("check_model without a usable check is a hard config error", () => {
    writeWorkflow(`${BASE}
    check_model: anthropic/claude-haiku`);
    const problems: string[] = [];
    const wf = engine.loadWorkflow("opt-wf", problems);
    expect(wf).toBeNull();
    expect(problems.some((p) => p.includes("check_model"))).toBe(true);
  });

  it("check_model with a real check is valid", () => {
    writeWorkflow(`${BASE}
    check: 验证一下
    check_model: anthropic/claude-haiku`);
    const wf = engine.loadWorkflow("opt-wf", []);
    expect(wf).not.toBeNull();
    expect((wf!.steps[0] as any).check_model).toBe("anthropic/claude-haiku");
  });
});

describe("check optional: lint surfaces skips, manual steps stay quiet", () => {
  it("warns on a non-manual no-check step", () => {
    writeWorkflow(BASE);
    const wf = engine.loadWorkflow("opt-wf", [])!;
    const warnings = engine.lintWorkflow(wf, {});
    expect(warnings.some((w) => w.includes(`步骤 "s1" 未配置对抗性检查`))).toBe(true);
  });

  it("does NOT warn on a manual no-check step (human gate is the check)", () => {
    writeWorkflow(`${BASE.replace("manual_step: []", "manual_step: [s1]")}`);
    const wf = engine.loadWorkflow("opt-wf", [])!;
    const warnings = engine.lintWorkflow(wf, {});
    expect(warnings.some((w) => w.includes("未配置对抗性检查"))).toBe(false);
  });

  it("does NOT warn on a step that has a real check", () => {
    writeWorkflow(`${BASE}
    check: 验证一下`);
    const wf = engine.loadWorkflow("opt-wf", [])!;
    const warnings = engine.lintWorkflow(wf, {});
    expect(warnings.some((w) => w.includes("未配置对抗性检查"))).toBe(false);
  });
});

describe("check optional: DO prompt notes the missing verifier", () => {
  it("no_check steps carry the '不配置对抗性检查' notice in their DO prompt", () => {
    writeWorkflow(BASE);
    const wf = engine.loadWorkflow("opt-wf", [])!;
    const step = wf.steps[0] as any;
    const prompt = engine.buildDoPrompt("inst", step, "任务");
    expect(prompt).toContain("不配置对抗性检查");
  });

  it("check steps do not carry the notice", () => {
    writeWorkflow(`${BASE}
    check: 验证一下`);
    const wf = engine.loadWorkflow("opt-wf", [])!;
    const step = wf.steps[0] as any;
    const prompt = engine.buildDoPrompt("inst", step, "任务");
    expect(prompt).not.toContain("不配置对抗性检查");
  });
});
