import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { parseWorkflowFile, loadWorkflow, listWorkflows } from "../workflow-loader.js";
import { isSubWorkflowStep } from "../types.js";

const BASE_TEST_DIR = join(import.meta.dirname, "__test_tmp__");

function writeWorkflow(dir: string, name: string, content: string): void {
  const workflowsDir = join(dir, ".opencode", "ralph-flow", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, `${name}.yaml`), content);
}

describe("parseWorkflowFile", () => {
  let testDir: string;
  let testCounter = 0;

  beforeEach(() => {
    testCounter++;
    testDir = join(BASE_TEST_DIR, `parse-${testCounter}`);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("should parse normal workflow", () => {
    const filePath = join(testDir, "test.yaml");
    writeFileSync(filePath, `manual_phase:

steps:
    - id: step1
      desc: Step 1
      do: Do something
      input: input
      output: output
      check: check
      on_pass: done
      on_fail: step1
      max_fail_count: 3
`);

    const result = parseWorkflowFile(filePath, "test");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("test");
    expect(result!.steps).toHaveLength(1);
    expect(result!.steps[0].id).toBe("step1");
    expect(isSubWorkflowStep(result!.steps[0])).toBe(false);
  });

  it("should parse workflow with sub-workflow step", () => {
    const filePath = join(testDir, "test.yaml");
    writeFileSync(filePath, `manual_phase:

steps:
    - id: sub
      desc: Sub workflow
      workflow: child-workflow
      inputs:
        spec: ".artifacts/spec.md"
      on_pass: done
      on_fail: sub
      max_fail_count: 3
`);

    const result = parseWorkflowFile(filePath, "test");
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(1);
    expect(isSubWorkflowStep(result!.steps[0])).toBe(true);
    expect((result!.steps[0] as any).workflow).toBe("child-workflow");
    expect((result!.steps[0] as any).inputs).toEqual({ spec: ".artifacts/spec.md" });
  });

  it("should parse mixed workflow with normal and sub-workflow steps", () => {
    const filePath = join(testDir, "test.yaml");
    writeFileSync(filePath, `manual_phase:

steps:
    - id: normal
      desc: Normal step
      do: Do something
      input: input
      output: output
      check: check
      on_pass: sub
      on_fail: normal
      max_fail_count: 3

    - id: sub
      desc: Sub workflow
      workflow: child-workflow
      on_pass: done
      on_fail: sub
      max_fail_count: 3
`);

    const result = parseWorkflowFile(filePath, "test");
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(2);
    expect(isSubWorkflowStep(result!.steps[0])).toBe(false);
    expect(isSubWorkflowStep(result!.steps[1])).toBe(true);
  });

  it("should return null for non-existent file", () => {
    const result = parseWorkflowFile("/non/existent/file.yaml", "test");
    expect(result).toBeNull();
  });

  it("should return null for invalid yaml", () => {
    const filePath = join(testDir, "invalid.yaml");
    writeFileSync(filePath, ":\n  :\n    - [[[invalid");

    const result = parseWorkflowFile(filePath, "test");
    expect(result).toBeNull();
  });
});

describe("loadWorkflow", () => {
  let testDir: string;
  let testCounter = 0;

  beforeEach(() => {
    testCounter++;
    testDir = join(BASE_TEST_DIR, `load-${testCounter}`);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("should load workflow from project directory", () => {
    writeWorkflow(testDir, "my-workflow", `manual_phase:

steps:
    - id: step1
      desc: Step 1
      do: Do something
      input: input
      output: output
      check: check
      on_pass: done
      on_fail: step1
      max_fail_count: 3
`);

    const result = loadWorkflow(testDir, "my-workflow");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("my-workflow");
  });

  it("should load workflow with sub-workflow steps", () => {
    writeWorkflow(testDir, "composite", `manual_phase:

steps:
    - id: sub
      desc: Sub workflow
      workflow: child
      on_pass: done
      on_fail: sub
      max_fail_count: 3
`);

    const result = loadWorkflow(testDir, "composite");
    expect(result).not.toBeNull();
    expect(isSubWorkflowStep(result!.steps[0])).toBe(true);
  });

  it("should return null for non-existent workflow", () => {
    const result = loadWorkflow(testDir, "non-existent");
    expect(result).toBeNull();
  });
});

describe("listWorkflows", () => {
  let testDir: string;
  let testCounter = 0;

  beforeEach(() => {
    testCounter++;
    testDir = join(BASE_TEST_DIR, `list-${testCounter}`);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("should list workflows from project directory", () => {
    writeWorkflow(testDir, "wf1", `manual_phase:

steps:
    - id: step1
      desc: Step 1
      do: Do something
      input: input
      output: output
      check: check
      on_pass: done
      on_fail: step1
      max_fail_count: 3
`);

    writeWorkflow(testDir, "wf2", `manual_phase:

steps:
    - id: step1
      desc: Another step
      do: Do something else
      input: input
      output: output
      check: check
      on_pass: done
      on_fail: step1
      max_fail_count: 3
`);

    const result = listWorkflows(testDir);
    const names = result.map(w => w.name);
    expect(names).toContain("wf1");
    expect(names).toContain("wf2");
  });

  it("should include plugin workflows", () => {
    const result = listWorkflows(testDir);
    const names = result.map(w => w.name);
    expect(names).toContain("loop");
    expect(names).toContain("spec");
  });
});
