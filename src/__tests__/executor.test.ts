import { describe, it, expect } from "vitest";
import {
  buildDoPrompt,
  buildCheckPrompt,
  buildContinuePrompt,
  buildSubWorkflowUserTask,
  getStep,
} from "../executor.js";
import type { WorkflowDef, StepDef, NormalStepDef, SubWorkflowStepDef, RalphFlowState } from "../types.js";

const makeStep = (overrides: Partial<NormalStepDef> = {}): NormalStepDef => ({
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

const makeSubWorkflowStep = (overrides: Partial<SubWorkflowStepDef> = {}): SubWorkflowStepDef => ({
  id: "sub-step",
  desc: "A sub-workflow step",
  workflow: "sub-workflow",
  on_pass: "done",
  on_fail: "sub-step",
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

describe("buildDoPrompt with retry count", () => {
  it("should include retry count when provided", () => {
    const step = makeStep();
    const prompt = buildDoPrompt(step, "task", "Previous failure", 2);
    expect(prompt).toContain("第 **2** 次重试");
    expect(prompt).toContain("最大重试次数为 **3** 次");
  });

  it("should not include retry count when 0", () => {
    const step = makeStep();
    const prompt = buildDoPrompt(step, "task", undefined, 0);
    expect(prompt).not.toContain("重试信息");
  });

  it("should not include retry count when undefined", () => {
    const step = makeStep();
    const prompt = buildDoPrompt(step, "task");
    expect(prompt).not.toContain("重试信息");
  });
});

describe("buildCheckPrompt with implementation context", () => {
  it("should include implementation context when provided", () => {
    const step = makeStep();
    const prompt = buildCheckPrompt(step, "user task", "const x = 1;");
    expect(prompt).toContain("## 实现内容");
    expect(prompt).toContain("const x = 1;");
  });

  it("should not include implementation context when not provided", () => {
    const step = makeStep();
    const prompt = buildCheckPrompt(step, "user task");
    expect(prompt).not.toContain("## 实现内容");
  });
});
