import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { pushState, popState, getStackDepth, clearStack, clearState } from "../state.js";
import type { RalphFlowState } from "../types.js";

const BASE_TEST_DIR = join(import.meta.dirname, "__test_tmp__");

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

describe("state stack (push/pop)", () => {
  let testDir: string;
  let testCounter = 0;

  beforeEach(() => {
    testCounter++;
    testDir = join(BASE_TEST_DIR, `test-${testCounter}`);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("should start with empty stack", () => {
    expect(getStackDepth(testDir)).toBe(0);
  });

  it("should push and pop a single state", () => {
    const state = makeState();
    pushState(testDir, state);
    expect(getStackDepth(testDir)).toBe(1);

    const popped = popState(testDir);
    expect(popped).not.toBeNull();
    expect(popped!.workflow_name).toBe("test-workflow");
    expect(popped!.current_step).toBe("step1");
    expect(getStackDepth(testDir)).toBe(0);
  });

  it("should push multiple states and pop in LIFO order", () => {
    const state1 = makeState({ workflow_name: "wf1", current_step: "s1" });
    const state2 = makeState({ workflow_name: "wf2", current_step: "s2" });
    const state3 = makeState({ workflow_name: "wf3", current_step: "s3" });

    pushState(testDir, state1);
    pushState(testDir, state2);
    pushState(testDir, state3);
    expect(getStackDepth(testDir)).toBe(3);

    const popped3 = popState(testDir);
    expect(popped3).not.toBeNull();
    expect(popped3!.workflow_name).toBe("wf3");

    const popped2 = popState(testDir);
    expect(popped2).not.toBeNull();
    expect(popped2!.workflow_name).toBe("wf2");

    const popped1 = popState(testDir);
    expect(popped1).not.toBeNull();
    expect(popped1!.workflow_name).toBe("wf1");

    expect(getStackDepth(testDir)).toBe(0);
  });

  it("should return null when popping empty stack", () => {
    const popped = popState(testDir);
    expect(popped).toBeNull();
  });

  it("should strip parent field before pushing", () => {
    const parentState = makeState({ workflow_name: "parent" });
    const state = makeState({ workflow_name: "child", parent: parentState });

    pushState(testDir, state);

    const popped = popState(testDir);
    expect(popped!.workflow_name).toBe("child");
    expect(popped!.parent).toBeUndefined();
  });

  it("should clear stack", () => {
    pushState(testDir, makeState({ workflow_name: "wf1" }));
    pushState(testDir, makeState({ workflow_name: "wf2" }));
    expect(getStackDepth(testDir)).toBe(2);

    clearStack(testDir);
    expect(getStackDepth(testDir)).toBe(0);
  });

  it("should clear stack when clearState is called", () => {
    pushState(testDir, makeState({ workflow_name: "wf1" }));
    expect(getStackDepth(testDir)).toBe(1);

    clearState(testDir);
    expect(getStackDepth(testDir)).toBe(0);
  });

  it("should handle nested workflow state correctly", () => {
    const rootState = makeState({
      workflow_name: "full-dev",
      current_step: "spec",
      user_task: "实现用户管理",
    });
    const subState = makeState({
      workflow_name: "spec",
      current_step: "propose",
      user_task: "task: 分析需求\n\n原始需求：实现用户管理",
    });

    pushState(testDir, rootState);
    pushState(testDir, subState);
    expect(getStackDepth(testDir)).toBe(2);

    const poppedSub = popState(testDir);
    expect(poppedSub!.workflow_name).toBe("spec");
    expect(poppedSub!.user_task).toContain("分析需求");

    const poppedRoot = popState(testDir);
    expect(poppedRoot!.workflow_name).toBe("full-dev");
    expect(poppedRoot!.user_task).toBe("实现用户管理");
  });
});
