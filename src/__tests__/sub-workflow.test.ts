import { describe, it, expect } from "vitest";
import {
  buildSubWorkflowUserTask,
} from "../executor.js";
import { isSubWorkflowStep } from "../types.js";
import type { SubWorkflowStepDef, NormalStepDef, StepDef } from "../types.js";

const makeSubWorkflowStep = (overrides: Partial<SubWorkflowStepDef> = {}): SubWorkflowStepDef => ({
  id: "sub-step",
  desc: "A sub-workflow step",
  workflow: "sub-workflow",
  on_pass: "done",
  on_fail: "sub-step",
  max_fail_count: 3,
  ...overrides,
});

const makeNormalStep = (overrides: Partial<NormalStepDef> = {}): NormalStepDef => ({
  id: "normal-step",
  desc: "A normal step",
  do: "Do something",
  input: "input data",
  output: "output data",
  check: "check criteria",
  on_pass: "done",
  on_fail: "normal-step",
  max_fail_count: 3,
  ...overrides,
});

describe("isSubWorkflowStep", () => {
  it("should return true for sub-workflow step", () => {
    const step = makeSubWorkflowStep();
    expect(isSubWorkflowStep(step)).toBe(true);
  });

  it("should return false for normal step", () => {
    const step = makeNormalStep();
    expect(isSubWorkflowStep(step)).toBe(false);
  });

  it("should return false for object without workflow field", () => {
    const step = { id: "test", desc: "test" };
    expect(isSubWorkflowStep(step as StepDef)).toBe(false);
  });

  it("should return true for step with workflow field", () => {
    const step: StepDef = {
      id: "test",
      desc: "test",
      workflow: "some-workflow",
      on_pass: "done",
      on_fail: "test",
      max_fail_count: 3,
    };
    expect(isSubWorkflowStep(step)).toBe(true);
  });
});

describe("buildSubWorkflowUserTask", () => {
  it("should build task with inputs only", () => {
    const step = makeSubWorkflowStep({
      inputs: {
        spec: ".artifacts/spec.md",
        design: ".artifacts/design.md",
      },
    });

    const result = buildSubWorkflowUserTask(step, "");
    expect(result).toContain("spec: .artifacts/spec.md");
    expect(result).toContain("design: .artifacts/design.md");
    expect(result).not.toContain("原始需求");
  });

  it("should build task with parent task only", () => {
    const step = makeSubWorkflowStep();
    const result = buildSubWorkflowUserTask(step, "实现用户管理模块");
    expect(result).toContain("原始需求：实现用户管理模块");
  });

  it("should build task with both inputs and parent task", () => {
    const step = makeSubWorkflowStep({
      inputs: {
        spec: ".artifacts/spec.md",
      },
    });

    const result = buildSubWorkflowUserTask(step, "实现用户管理模块");
    expect(result).toContain("spec: .artifacts/spec.md");
    expect(result).toContain("原始需求：实现用户管理模块");
  });

  it("should handle empty inputs", () => {
    const step = makeSubWorkflowStep({});
    const result = buildSubWorkflowUserTask(step, "task");
    expect(result).toContain("原始需求：task");
  });

  it("should handle undefined inputs", () => {
    const step = makeSubWorkflowStep({ inputs: undefined });
    const result = buildSubWorkflowUserTask(step, "task");
    expect(result).toBe("原始需求：task");
  });

  it("should handle empty parent task", () => {
    const step = makeSubWorkflowStep({
      inputs: { key: "value" },
    });
    const result = buildSubWorkflowUserTask(step, "");
    expect(result).toBe("key: value");
  });

  it("should separate inputs and parent task with blank line", () => {
    const step = makeSubWorkflowStep({
      inputs: { key: "value" },
    });
    const result = buildSubWorkflowUserTask(step, "task");
    expect(result).toContain("key: value\n\n原始需求：task");
  });
});
