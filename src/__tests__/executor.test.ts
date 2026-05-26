import { describe, it, expect } from "vitest";
import {
  buildDoPrompt,
  buildCheckPrompt,
  buildContinuePrompt,
  buildIdlePrompt,
  getStep,
  getManualPhases,
  isManualPhase,
  isWorkflowInfoMessage,
  extractFailureReason,
} from "../executor.js";
import type { WorkflowDef, StepDef, RalphFlowState } from "../types.js";

const makeStep = (overrides: Partial<StepDef> = {}): StepDef => ({
  id: "test-step",
  desc: "A test step",
  do: "Perform the test task",
  input: "The input data",
  output: "The expected output",
  check: "Verify the output is correct",
  on_pass: "done",
  on_fail: "test-step",
  max_fail_count: 3,
  ...overrides,
});

const makeWorkflow = (overrides: Partial<WorkflowDef> = {}): WorkflowDef => ({
  name: "test-workflow",
  manual_phase: [],
  steps: [makeStep()],
  ...overrides,
});

const makeState = (overrides: Partial<RalphFlowState> = {}): RalphFlowState => ({
  active: true,
  workflow_name: "test-workflow",
  current_step: "test-step",
  current_phase: "do",
  fail_count: 0,
  user_task: "Complete testing",
  paused: false,
  ...overrides,
});

describe("getStep", () => {
  it("should find a step by id", () => {
    const wf = makeWorkflow();
    const step = getStep(wf, "test-step");
    expect(step).not.toBeNull();
    expect(step!.id).toBe("test-step");
  });

  it("should return null for non-existent step", () => {
    const wf = makeWorkflow();
    expect(getStep(wf, "nonexistent")).toBeNull();
  });

  it("should handle workflow with multiple steps", () => {
    const wf = makeWorkflow({
      steps: [
        makeStep({ id: "step1" }),
        makeStep({ id: "step2" }),
        makeStep({ id: "step3" }),
      ],
    });
    expect(getStep(wf, "step2")!.id).toBe("step2");
  });
});

describe("getManualPhases", () => {
  it("should return empty set for empty manual_phase", () => {
    const wf = makeWorkflow({ manual_phase: [] });
    expect(getManualPhases(wf).size).toBe(0);
  });

  it("should return set of manual phases", () => {
    const wf = makeWorkflow({ manual_phase: ["check.do", "review.do"] });
    const phases = getManualPhases(wf);
    expect(phases.size).toBe(2);
    expect(phases.has("check.do")).toBe(true);
    expect(phases.has("review.do")).toBe(true);
  });
});

describe("isManualPhase", () => {
  it("should return true if phase is manual", () => {
    const wf = makeWorkflow({ manual_phase: ["step1.check"] });
    expect(isManualPhase(wf, "step1", "check")).toBe(true);
  });

  it("should return false if phase is not manual", () => {
    const wf = makeWorkflow({ manual_phase: ["step1.check"] });
    expect(isManualPhase(wf, "step1", "do")).toBe(false);
  });

  it("should return false for empty manual_phase", () => {
    const wf = makeWorkflow({ manual_phase: [] });
    expect(isManualPhase(wf, "step1", "do")).toBe(false);
  });
});

describe("buildDoPrompt", () => {
  it("should include task description", () => {
    const step = makeStep();
    const prompt = buildDoPrompt(step, "test task");
    expect(prompt).toContain(step.do);
    expect(prompt).toContain(step.desc);
    expect(prompt).toContain("test task");
    expect(prompt).toContain("<promise>done</promise>");
  });

  it("should include user task section", () => {
    const prompt = buildDoPrompt(makeStep(), "build an API");
    expect(prompt).toContain("## 用户需求");
    expect(prompt).toContain("build an API");
  });

  it("should omit user task section when no userTask", () => {
    const prompt = buildDoPrompt(makeStep());
    expect(prompt).not.toContain("## 用户需求");
  });

  it("should include retry context", () => {
    const prompt = buildDoPrompt(makeStep(), "task", "Previous attempt failed because of X");
    expect(prompt).toContain("## 上次检查失败原因");
    expect(prompt).toContain("Previous attempt failed because of X");
  });

  it("should include step fields", () => {
    const prompt = buildDoPrompt(makeStep(), "task");
    expect(prompt).toContain("test-step");
    expect(prompt).toContain("A test step");
  });
});

describe("buildCheckPrompt", () => {
  it("should include check criteria", () => {
    const step = makeStep();
    const prompt = buildCheckPrompt(step, "user task");
    expect(prompt).toContain("## 任务检查");
    expect(prompt).toContain(step.check);
    expect(prompt).toContain("<promise-check>true</promise-check>");
    expect(prompt).toContain("<promise-check>false</promise-check>");
  });

  it("should include user task", () => {
    const prompt = buildCheckPrompt(makeStep(), "build feature");
    expect(prompt).toContain("## 用户需求");
    expect(prompt).toContain("build feature");
  });

  it("should omit user task section when none", () => {
    const prompt = buildCheckPrompt(makeStep());
    expect(prompt).not.toContain("## 用户需求");
  });

  it("should include step info", () => {
    const prompt = buildCheckPrompt(makeStep());
    expect(prompt).toContain("test-step");
    expect(prompt).toContain("Verify the output is correct");
  });
});

describe("buildContinuePrompt", () => {
  it("should build do prompt when in do phase", () => {
    const state = makeState({ current_phase: "do" });
    const step = makeStep();
    const prompt = buildContinuePrompt(state, step);
    expect(prompt).toContain("<promise>done</promise>");
  });

  it("should build check prompt when in check phase", () => {
    const state = makeState({ current_phase: "check" });
    const step = makeStep();
    const prompt = buildContinuePrompt(state, step);
    expect(prompt).toContain("<promise-check>true</promise-check>");
  });
});

describe("buildIdlePrompt", () => {
  it("should include step info", () => {
    const prompt = buildIdlePrompt(makeStep(), "task");
    expect(prompt).toContain("请继续完成当前任务");
    expect(prompt).toContain("test-step");
    expect(prompt).toContain("A test step");
  });

  it("should include user task when provided", () => {
    const prompt = buildIdlePrompt(makeStep(), "my task");
    expect(prompt).toContain("my task");
  });

  it("should not include user task heading when not provided", () => {
    const prompt = buildIdlePrompt(makeStep());
    expect(prompt).not.toContain("用户需求");
  });
});

describe("isWorkflowInfoMessage", () => {
  it("should detect workflow status message", () => {
    expect(isWorkflowInfoMessage("## Workflow Status\n- **Workflow**: test")).toBe(true);
  });

  it("should detect available workflows message", () => {
    expect(isWorkflowInfoMessage("## Available Workflows\n- test")).toBe(true);
  });

  it("should detect Chinese messages", () => {
    expect(isWorkflowInfoMessage("请选择工作流，当前可用的有：")).toBe(true);
    expect(isWorkflowInfoMessage("请描述你要执行的任务")).toBe(true);
  });

  it("should detect English messages", () => {
    expect(isWorkflowInfoMessage("No active workflow to continue.")).toBe(true);
    expect(isWorkflowInfoMessage("No workflows found.")).toBe(true);
    expect(isWorkflowInfoMessage("There is an active workflow \"test\"")).toBe(true);
    expect(isWorkflowInfoMessage("Workflow resumed at step")).toBe(true);
    expect(isWorkflowInfoMessage("Workflow cancelled")).toBe(true);
  });

  it("should return false for normal messages", () => {
    expect(isWorkflowInfoMessage("Let me build that for you.")).toBe(false);
    expect(isWorkflowInfoMessage("## Task completed")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(isWorkflowInfoMessage("")).toBe(false);
  });
});

describe("extractFailureReason", () => {
  it("should remove check tags from text", () => {
    const text = "Review failed. <promise-check>false</promise-check> Issues found.";
    const result = extractFailureReason(text);
    expect(result).toBe("Review failed.  Issues found.");
  });

  it("should remove true check tags as well", () => {
    const text = "<promise-check>true</promise-check> All good.";
    const result = extractFailureReason(text);
    expect(result).toBe("All good.");
  });

  it("should handle case-insensitive tags", () => {
    const text = "<PROMISE-CHECK>FALSE</PROMISE-CHECK> Failed!";
    const result = extractFailureReason(text);
    expect(result).toBe("Failed!");
  });

  it("should trim whitespace", () => {
    const text = "  <promise-check>false</promise-check>  ";
    expect(extractFailureReason(text)).toBe("");
  });
});
