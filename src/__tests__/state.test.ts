import { describe, it, expect } from "vitest";
import { parseState, serializeState, getStateFile } from "../state.js";
import type { RalphFlowState } from "../types.js";

describe("getStateFile", () => {
  it("should return correct state file path", () => {
    const result = getStateFile("/project");
    expect(result).toContain("ralph-flow.local.md");
    expect(result).toContain(".opencode");
    expect(result).toContain("ralph-flow");
  });

  it("should handle windows-style paths", () => {
    const result = getStateFile("C:\\Users\\test");
    expect(result).toContain(".opencode");
    expect(result).toContain("ralph-flow.local.md");
  });
});

describe("parseState", () => {
  it("should parse a complete state with all fields", () => {
    const content = `---
active: true
workflow_name: my-workflow
current_step: step1
current_phase: do
fail_count: 3
user_task: build something
paused: false
---`;

    const state = parseState(content);
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.workflow_name).toBe("my-workflow");
    expect(state!.current_step).toBe("step1");
    expect(state!.current_phase).toBe("do");
    expect(state!.fail_count).toBe(3);
    expect(state!.user_task).toBe("build something");
    expect(state!.paused).toBe(false);
  });

  it("should parse state with check phase", () => {
    const content = `---
active: true
workflow_name: test
current_step: step2
current_phase: check
fail_count: 1
user_task: test task
paused: false
---`;

    const state = parseState(content);
    expect(state!.current_phase).toBe("check");
  });

  it("should treat unknown phase as do", () => {
    const content = `---
active: true
workflow_name: test
current_step: step1
current_phase: unknown
fail_count: 0
user_task: ""
paused: false
---`;

    const state = parseState(content);
    expect(state!.current_phase).toBe("do");
  });

  it("should handle paused state", () => {
    const content = `---
active: true
workflow_name: test
current_step: step1
current_phase: check
fail_count: 5
user_task: task
paused: true
---`;

    const state = parseState(content);
    expect(state!.paused).toBe(true);
  });

  it("should return null for content without frontmatter", () => {
    const content = `No frontmatter here, just some text.`;
    expect(parseState(content)).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(parseState("")).toBeNull();
  });

  it("should handle windows-style line endings", () => {
    const content = "---\r\nactive: true\r\nworkflow_name: wf\r\ncurrent_step: s1\r\ncurrent_phase: do\r\nfail_count: 0\r\nuser_task: t\r\npaused: false\r\n---";
    const state = parseState(content);
    expect(state).not.toBeNull();
    expect(state!.workflow_name).toBe("wf");
  });

  it("should handle value containing colon", () => {
    const content = `---
active: true
workflow_name: test
current_step: step1
current_phase: do
fail_count: 0
user_task: check: something
paused: false
---`;

    const state = parseState(content);
    expect(state!.user_task).toBe("check: something");
  });

  it("should parse inactive state", () => {
    const content = `---
active: false
workflow_name: done-wf
current_step: step1
current_phase: do
fail_count: 0
user_task: ""
paused: false
---`;

    const state = parseState(content);
    expect(state!.active).toBe(false);
  });
});

describe("serializeState", () => {
  it("should serialize a state to markdown frontmatter", () => {
    const state: RalphFlowState = {
      active: true,
      workflow_name: "my-workflow",
      current_step: "step1",
      current_phase: "do",
      fail_count: 2,
      user_task: "build app",
      paused: false,
    };

    const result = serializeState(state);
    expect(result).toContain("active: true");
    expect(result).toContain("workflow_name: my-workflow");
    expect(result).toContain("current_step: step1");
    expect(result).toContain("current_phase: do");
    expect(result).toContain("fail_count: 2");
    expect(result).toContain("user_task: build app");
    expect(result).toContain("paused: false");
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\n---$/);
  });

  it("should serialize completed state with active false", () => {
    const state: RalphFlowState = {
      active: false,
      workflow_name: "done",
      current_step: "final",
      current_phase: "check",
      fail_count: 0,
      user_task: "done task",
      paused: false,
    };

    const result = serializeState(state);
    expect(result).toContain("active: false");
  });

  it("round-trip: parse(serialize(state)) should equal original state", () => {
    const state: RalphFlowState = {
      active: true,
      workflow_name: "round-trip-test",
      current_step: "step-x",
      current_phase: "check",
      fail_count: 4,
      user_task: "round trip",
      paused: true,
    };

    const serialized = serializeState(state);
    const parsed = parseState(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.active).toBe(state.active);
    expect(parsed!.workflow_name).toBe(state.workflow_name);
    expect(parsed!.current_step).toBe(state.current_step);
    expect(parsed!.current_phase).toBe(state.current_phase);
    expect(parsed!.fail_count).toBe(state.fail_count);
    expect(parsed!.user_task).toBe(state.user_task);
    expect(parsed!.paused).toBe(state.paused);
  });
});
