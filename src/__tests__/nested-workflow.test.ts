import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { readState, writeState, pushState, popState, getStackDepth, clearState } from "../state.js";
import { isSubWorkflowStep } from "../types.js";
import { parseWorkflowFile } from "../workflow-loader.js";
import { buildSubWorkflowUserTask } from "../executor.js";
import type { RalphFlowState, WorkflowDef, SubWorkflowStepDef } from "../types.js";

const BASE_TEST_DIR = join(import.meta.dirname, "__test_tmp__");

function writeWorkflow(dir: string, name: string, content: string): void {
  const workflowsDir = join(dir, ".opencode", "ralph-flow", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, `${name}.yaml`), content);
}

function makeState(overrides: Partial<RalphFlowState> = {}): RalphFlowState {
  return {
    active: true,
    workflow_name: "test-workflow",
    current_step: "step1",
    current_phase: "do",
    fail_count: 0,
    user_task: "test task",
    paused: false,
    ...overrides,
  };
}

describe("nested workflow integration", () => {
  let testDir: string;
  let testCounter = 0;

  beforeEach(() => {
    testCounter++;
    testDir = join(BASE_TEST_DIR, `nested-${testCounter}`);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("should parse composite workflow with sub-workflow steps", () => {
    writeWorkflow(testDir, "full-dev", `manual_step:

steps:
    - id: analyze
      desc: 需求分析
      workflow: analyze
      inputs:
        task: "分析需求"
      on_pass: build
      on_fail: analyze
      max_fail_count: 3

    - id: build
      desc: 构建实现
      workflow: build
      on_pass: done
      on_fail: build
      max_fail_count: 3
`);

    const workflowPath = join(testDir, ".opencode", "ralph-flow", "workflows", "full-dev.yaml");
    const workflow = parseWorkflowFile(workflowPath, "full-dev");
    expect(workflow).not.toBeNull();
    expect(workflow!.steps).toHaveLength(2);

    const step1 = workflow!.steps[0];
    expect(isSubWorkflowStep(step1)).toBe(true);
    expect((step1 as SubWorkflowStepDef).workflow).toBe("analyze");
    expect((step1 as SubWorkflowStepDef).inputs).toEqual({ task: "分析需求" });

    const step2 = workflow!.steps[1];
    expect(isSubWorkflowStep(step2)).toBe(true);
    expect((step2 as SubWorkflowStepDef).workflow).toBe("build");
  });

  it("should handle state stack for nested workflows", () => {
    const rootState = makeState({
      workflow_name: "full-dev",
      current_step: "analyze",
      user_task: "实现用户管理模块",
    });

    const subState = makeState({
      workflow_name: "analyze",
      current_step: "understand",
      user_task: "task: 分析需求\n\n原始需求：实现用户管理模块",
    });

    // Simulate entering sub-workflow
    pushState(testDir, rootState);
    writeState(testDir, subState);

    expect(getStackDepth(testDir)).toBe(1);

    // Read current state (sub-workflow)
    const currentState = readState(testDir);
    expect(currentState).not.toBeNull();
    expect(currentState!.workflow_name).toBe("analyze");
    expect(currentState!.user_task).toContain("分析需求");

    // Simulate sub-workflow completion
    const parentState = popState(testDir);
    expect(parentState).not.toBeNull();
    expect(parentState!.workflow_name).toBe("full-dev");
    expect(parentState!.current_step).toBe("analyze");

    // Write parent state back
    writeState(testDir, parentState!);

    expect(getStackDepth(testDir)).toBe(0);

    // Verify current state is now parent
    const restoredState = readState(testDir);
    expect(restoredState!.workflow_name).toBe("full-dev");
  });

  it("should handle multi-level nesting", () => {
    const rootState = makeState({ workflow_name: "root", current_step: "s1" });
    const level1State = makeState({ workflow_name: "level1", current_step: "s2" });
    const level2State = makeState({ workflow_name: "level2", current_step: "s3" });

    // Push root -> level1 -> level2
    pushState(testDir, rootState);
    pushState(testDir, level1State);
    writeState(testDir, level2State);

    expect(getStackDepth(testDir)).toBe(2);

    // Pop level2 -> level1
    const parent1 = popState(testDir);
    expect(parent1!.workflow_name).toBe("level1");
    writeState(testDir, parent1!);

    expect(getStackDepth(testDir)).toBe(1);

    // Pop level1 -> root
    const parent0 = popState(testDir);
    expect(parent0!.workflow_name).toBe("root");
    writeState(testDir, parent0!);

    expect(getStackDepth(testDir)).toBe(0);

    const finalState = readState(testDir);
    expect(finalState!.workflow_name).toBe("root");
  });

  it("should handle sub-workflow failure and parent retry", () => {
    const parentState = makeState({
      workflow_name: "full-dev",
      current_step: "analyze",
      fail_count: 0,
    });

    // Enter sub-workflow
    pushState(testDir, parentState);

    const subState = makeState({
      workflow_name: "analyze",
      current_step: "understand",
      fail_count: 0,
    });
    writeState(testDir, subState);

    // Simulate sub-workflow failure (reached max_fail_count)
    // Pop parent and increment fail count
    const poppedParent = popState(testDir);
    expect(poppedParent).not.toBeNull();

    const failedParentState: RalphFlowState = {
      ...poppedParent!,
      fail_count: poppedParent!.fail_count + 1,
    };
    writeState(testDir, failedParentState);

    // Verify parent state has incremented fail count
    const currentState = readState(testDir);
    expect(currentState!.fail_count).toBe(1);
    expect(currentState!.workflow_name).toBe("full-dev");
  });

  it("should preserve user task through nesting", () => {
    const rootUserTask = "实现一个完整的用户管理系统";

    const rootState = makeState({
      workflow_name: "full-dev",
      user_task: rootUserTask,
    });

    // Build sub-workflow user task using the actual function
    const subStep: SubWorkflowStepDef = {
      id: "analyze",
      desc: "需求分析",
      workflow: "analyze",
      inputs: { task: "分析需求" },
      on_pass: "build",
      on_fail: "analyze",
      max_fail_count: 3,
    };
    const subUserTask = buildSubWorkflowUserTask(subStep, rootUserTask);

    pushState(testDir, rootState);

    const subState = makeState({
      workflow_name: "analyze",
      user_task: subUserTask,
    });
    writeState(testDir, subState);

    // Verify sub-workflow has the combined task
    const currentState = readState(testDir);
    expect(currentState!.user_task).toContain("分析需求");
    expect(currentState!.user_task).toContain(rootUserTask);

    // Pop and verify parent task is preserved
    const parentState = popState(testDir);
    expect(parentState!.user_task).toBe(rootUserTask);
  });
});
