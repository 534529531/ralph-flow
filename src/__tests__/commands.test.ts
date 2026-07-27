import { describe, it, expect } from "vitest";
import {
  RALPH_COMMANDS,
  buildWorkflowCommand,
  registerWorkflowCommands,
  workflowCommandName,
} from "../commands.js";

// ─── workflowCommandName ─────────────────────────────────────────────────────

describe("workflowCommandName", () => {
  it("passes kebab-case names through unchanged", () => {
    expect(workflowCommandName("loop")).toBe("loop");
    expect(workflowCommandName("spec")).toBe("spec");
    expect(workflowCommandName("my-cool-flow")).toBe("my-cool-flow");
  });

  it("lowercases and folds illegal characters to dashes", () => {
    expect(workflowCommandName("MyFlow")).toBe("myflow");
    expect(workflowCommandName("my_flow.v2")).toBe("my-flow-v2");
    expect(workflowCommandName("My Flow")).toBe("my-flow");
  });

  it("strips leading/trailing dashes produced by folding", () => {
    expect(workflowCommandName("-loop-")).toBe("loop");
    expect(workflowCommandName("_loop_")).toBe("loop");
  });

  it("returns null for names that cannot form a command (e.g. all CJK)", () => {
    expect(workflowCommandName("测试流程")).toBeNull();
    expect(workflowCommandName("")).toBeNull();
    expect(workflowCommandName("——")).toBeNull();
  });
});

// ─── buildWorkflowCommand ────────────────────────────────────────────────────

describe("buildWorkflowCommand", () => {
  it("prefixes the description with the (ralph-flow) source tag", () => {
    const def = buildWorkflowCommand("loop", "执行、验证、重试，直到完成");
    expect(def.description).toBe("(ralph-flow) 执行、验证、重试，直到完成");
  });

  it("falls back to a default description when the workflow has none", () => {
    expect(buildWorkflowCommand("loop", "").description).toBe("(ralph-flow) 启动 loop 工作流");
  });

  it("pins the ORIGINAL workflow name in the template (not the normalized command name)", () => {
    const def = buildWorkflowCommand("My_Flow", "desc");
    expect(def.template).toContain('`workflow` 参数固定填 `"My_Flow"`');
    expect(def.template).toContain("启动 Ralph Flow 的 `My_Flow` 工作流");
  });

  it("carries the shared mechanism text so both entry points behave identically", () => {
    const def = buildWorkflowCommand("loop", "desc");
    expect(def.template).toContain("## 工作流机制");
    expect(def.template).toContain("<promise>done</promise>");
    expect(def.template).toContain("## 暂停与恢复");
    expect(def.template).toContain("## 阶段播报");
    expect(def.template).toContain("extra_dirs");
    expect(def.template).toContain("$ARGUMENTS");
  });

  it("shares the mechanism text with /ralphflow-start (no drift between entry points)", () => {
    const dynamic = buildWorkflowCommand("loop", "desc");
    const start = RALPH_COMMANDS["ralphflow-start"];
    for (const section of ["## 工作流机制", "## 暂停与恢复", "## 启动之后", "## 阶段播报"]) {
      expect(dynamic.template).toContain(section);
      expect(start.template).toContain(section);
    }
    // The dynamic template is a strict subset after the start-specific preamble:
    // everything from the extra_dirs note onward must be identical.
    const tail = (t: string) => t.slice(t.indexOf("**extra_dirs**"));
    expect(tail(dynamic.template)).toBe(tail(start.template));
  });
});

// ─── registerWorkflowCommands ────────────────────────────────────────────────

describe("registerWorkflowCommands", () => {
  it("registers one command per launchable workflow", () => {
    const commands: Record<string, any> = {};
    registerWorkflowCommands(commands, [
      { name: "loop", desc: "循环" },
      { name: "spec", desc: "规格" },
    ]);
    expect(Object.keys(commands).sort()).toEqual(["loop", "spec"]);
    expect(commands["loop"].description).toBe("(ralph-flow) 循环");
    expect(commands["loop"].template).toContain('"loop"');
  });

  it("skips invalid workflows (they cannot start; doctor surfaces them)", () => {
    const commands: Record<string, any> = {};
    registerWorkflowCommands(commands, [
      { name: "broken", desc: "⚠️ 定义无效", invalid: true },
      { name: "loop", desc: "循环" },
    ]);
    expect(Object.keys(commands)).toEqual(["loop"]);
  });

  it("never overwrites an existing command (user's own /loop wins)", () => {
    const userCmd = { template: "user's own loop", description: "mine" };
    const commands: Record<string, any> = { loop: userCmd };
    registerWorkflowCommands(commands, [{ name: "loop", desc: "循环" }]);
    expect(commands["loop"]).toBe(userCmd); // same object, untouched
  });

  it("never overwrites the static management commands", () => {
    const commands: Record<string, any> = { ...RALPH_COMMANDS };
    registerWorkflowCommands(commands, [{ name: "ralphflow-start", desc: "恶意同名" }]);
    expect(commands["ralphflow-start"]).toBe(RALPH_COMMANDS["ralphflow-start"]);
  });

  it("registers only the first of several workflows that normalize to the same command", () => {
    const commands: Record<string, any> = {};
    registerWorkflowCommands(commands, [
      { name: "My_Flow", desc: "第一个" },
      { name: "my-flow", desc: "第二个" },
    ]);
    expect(Object.keys(commands)).toEqual(["my-flow"]);
    // The FIRST workflow in resolution order wins, with its original name pinned.
    expect(commands["my-flow"].description).toBe("(ralph-flow) 第一个");
    expect(commands["my-flow"].template).toContain('"My_Flow"');
  });

  it("skips workflow names that cannot form a command (e.g. all CJK)", () => {
    const commands: Record<string, any> = {};
    registerWorkflowCommands(commands, [{ name: "测试流程", desc: "中文名" }]);
    expect(Object.keys(commands)).toEqual([]);
  });

  it("normalizes the command name but pins the original workflow name in the template", () => {
    const commands: Record<string, any> = {};
    registerWorkflowCommands(commands, [{ name: "My Flow.v2", desc: "版本流" }]);
    expect(Object.keys(commands)).toEqual(["my-flow-v2"]);
    expect(commands["my-flow-v2"].template).toContain('`workflow` 参数固定填 `"My Flow.v2"`');
  });
});
