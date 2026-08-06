import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  createEngine, type Platform, type Engine,
  resolveVerifierModel, resolveCheckModel,
  DEFAULT_ADVERSARIAL_SYSTEM_PROMPT,
} from "../engine.js";

let tmpDir: string;
let engine: Engine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-engine-voting-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── resolveVerifierModel priority chain (design §7) ─────────────────────────

describe("resolveVerifierModel priority chain", () => {
  it("entry model wins over step model and effective", () => {
    expect(resolveVerifierModel("openai/gpt-4o", "anthropic/claude-sonnet", { model: "google/gemini-3-pro" }))
      .toEqual({ providerID: "openai", modelID: "gpt-4o" });
  });

  it("step check_model beats effective (single-check scenario)", () => {
    expect(resolveVerifierModel(undefined, "anthropic/claude-haiku", { model: "google/gemini-3-pro" }))
      .toEqual({ providerID: "anthropic", modelID: "claude-haiku" });
  });

  it("effective model is the last explicit fallback", () => {
    expect(resolveVerifierModel(undefined, undefined, { model: "google/gemini-3-pro" }))
      .toEqual({ providerID: "google", modelID: "gemini-3-pro" });
  });

  it("object model form works", () => {
    expect(resolveVerifierModel({ providerID: "openai", modelID: "gpt-5" }, undefined, undefined))
      .toEqual({ providerID: "openai", modelID: "gpt-5" });
  });

  it("invalid values fall through to undefined", () => {
    expect(resolveVerifierModel("bare-name", undefined, undefined)).toBeUndefined();
    expect(resolveVerifierModel(undefined, "bare-name", undefined)).toBeUndefined();
    expect(resolveVerifierModel(undefined, undefined, { model: "bare-name" })).toBeUndefined();
  });

  it("resolveCheckModel rejects object missing providerID/modelID", () => {
    expect(resolveCheckModel({ providerID: "", modelID: "x" })).toBeUndefined();
    expect(resolveCheckModel({ providerID: "p", modelID: "" })).toBeUndefined();
  });
});

// ─── Load-time validation of check_voting (design §3.4) ──────────────────────

function writeWorkflow(yaml: string, name = "voting-wf"): string {
  const dir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.yaml`);
  fs.writeFileSync(file, yaml, "utf-8");
  return name;
}

const BASE_STEP = `id: s1
    desc: d
    do: do it
    input: in
    output: out
    on_pass: done
    on_fail: s1
    max_fail_count: 3`;

function wfWith(stepExtra: string): string {
  return `name: voting-wf
description: test
steps:
  - ${BASE_STEP}
${stepExtra}
`;
}

describe("parseWorkflowFile check_voting validation", () => {
  const FIVE = `      - check: "视角A"
        model: openai/gpt-4o
      - check: "视角B"
      - check: "视角C"
      - check: "视角D"
      - check: "视角E"`;

  it("accepts a valid check_voting step with 1-5 voters (no check needed)", () => {
    writeWorkflow(wfWith(`    check_voting:\n${FIVE}`));
    const problems: string[] = [];
    const wf = engine.loadWorkflow("voting-wf", problems);
    expect(wf).not.toBeNull();
    expect(problems).toHaveLength(0);
    const s1 = wf!.steps[0] as any;
    expect(s1.check_voting.length).toBe(5);
    expect(s1.check).toBeUndefined();
  });

  it("a single voter is valid too (user decides the count)", () => {
    writeWorkflow(wfWith(`    check_voting:
      - check: "视角A"`));
    const problems: string[] = [];
    const wf = engine.loadWorkflow("voting-wf", problems);
    expect(wf).not.toBeNull();
    expect((wf!.steps[0] as any).check_voting.length).toBe(1);
  });

  it("mutual exclusion is a HARD error and beats type errors", () => {
    // check exists (wrong type) AND check_voting → must be hard error, not skip
    writeWorkflow(wfWith(`    check: 123
    check_voting:\n${FIVE}`));
    const problems: string[] = [];
    const wf = engine.loadWorkflow("voting-wf", problems);
    expect(wf).toBeNull();
    expect(problems.some((p) => p.includes("互斥"))).toBe(true);
  });

  it("empty array is a hard error (1-5 required)", () => {
    writeWorkflow(wfWith(`    check_voting: []`));
    const problems: string[] = [];
    expect(engine.loadWorkflow("voting-wf", problems)).toBeNull();
    expect(problems.some((p) => p.includes("1-5"))).toBe(true);
  });

  it("more than 5 voters is a hard error", () => {
    const entries = Array.from({ length: 6 }, (_, i) => `      - check: "视角${i}"`).join("\n");
    writeWorkflow(wfWith(`    check_voting:\n${entries}`));
    const problems: string[] = [];
    expect(engine.loadWorkflow("voting-wf", problems)).toBeNull();
    expect(problems.some((p) => p.includes("上限"))).toBe(true);
  });

  it("entry check must be non-empty", () => {
    writeWorkflow(wfWith(`    check_voting:
      - check: ""
      - check: "视角B"
      - check: "视角C"
      - check: "视角D"
      - check: "视角E"`));
    const problems: string[] = [];
    expect(engine.loadWorkflow("voting-wf", problems)).toBeNull();
    expect(problems.some((p) => p.includes("check"))).toBe(true);
  });

  it("entry model format is validated", () => {
    writeWorkflow(wfWith(`    check_voting:
      - check: "视角A"
        model: bare-name
      - check: "视角B"
      - check: "视角C"
      - check: "视角D"
      - check: "视角E"`));
    const problems: string[] = [];
    expect(engine.loadWorkflow("voting-wf", problems)).toBeNull();
    expect(problems.some((p) => p.includes("model"))).toBe(true);
  });

  it("check_voting + check_model is rejected", () => {
    writeWorkflow(wfWith(`    check_model: anthropic/claude-haiku
    check_voting:\n${FIVE}`));
    const problems: string[] = [];
    expect(engine.loadWorkflow("voting-wf", problems)).toBeNull();
    expect(problems.some((p) => p.includes("check_model"))).toBe(true);
  });

  it("plain check still works unchanged (backward compat)", () => {
    writeWorkflow(wfWith(`    check: 验证一下`));
    const problems: string[] = [];
    const wf = engine.loadWorkflow("voting-wf", problems);
    expect(wf).not.toBeNull();
    expect((wf!.steps[0] as any).check).toBe("验证一下");
  });

  it("step with neither check nor check_voting is skipped (legacy semantics)", () => {
    writeWorkflow(wfWith(``));
    const problems: string[] = [];
    const wf = engine.loadWorkflow("voting-wf", problems);
    // no valid steps → null
    expect(wf).toBeNull();
  });
});

// ─── .adversarial-session array format (design §6.1) ─────────────────────────

describe("adversarial session array persistence", () => {
  it("writes and reads an array; legacy single value is read-compatible", () => {
    const instId = engine.generateInstanceId("test");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeState(
      { active: true, workflow_name: "t", current_step: "s", current_phase: "check", fail_count: 0, user_task: "", paused: false, session_id: "x" },
      instId,
    );
    engine.writeAdversarialSession("sess-a", instId);
    engine.writeAdversarialSession("sess-b", instId);
    expect(engine.readAdversarialSessions(instId)).toEqual(["sess-a", "sess-b"]);
    expect(engine.readAdversarialSession(instId)).toBe("sess-a");
    // dedupe
    engine.writeAdversarialSession("sess-a", instId);
    expect(engine.readAdversarialSessions(instId)).toEqual(["sess-a", "sess-b"]);
    // remove one
    engine.removeAdversarialSession("sess-a", instId);
    expect(engine.readAdversarialSessions(instId)).toEqual(["sess-b"]);
    // clear all
    engine.clearAdversarialSession(instId);
    expect(engine.readAdversarialSessions(instId)).toEqual([]);
    expect(engine.readAdversarialSession(instId)).toBeNull();
  });

  it("reads a legacy single-value file as a one-element array", () => {
    const instId = engine.generateInstanceId("test");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeState(
      { active: true, workflow_name: "t", current_step: "s", current_phase: "check", fail_count: 0, user_task: "", paused: false, session_id: "x" },
      instId,
    );
    fs.writeFileSync(path.join(engine.getInstanceDir(instId), ".adversarial-session"), "legacy-sess", "utf-8");
    expect(engine.readAdversarialSessions(instId)).toEqual(["legacy-sess"]);
    expect(engine.readAdversarialSession(instId)).toBe("legacy-sess");
  });
});

// ─── Refined verifier output contract (design §8) ────────────────────────────

describe("refined verifier output contract", () => {
  it("the default system prompt enforces the concise structured format", () => {
    expect(DEFAULT_ADVERSARIAL_SYSTEM_PROMPT).toContain("每条一行,最多 10 行");
    expect(DEFAULT_ADVERSARIAL_SYSTEM_PROMPT).toContain("[文件:行号] 问题一句话");
    expect(DEFAULT_ADVERSARIAL_SYSTEM_PROMPT).toContain("<promise-check>");
  });
});
