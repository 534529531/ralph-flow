import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine, type NormalStepDef } from "../engine.js";
import { adversarialCheck } from "../check.js";

let tmpDir: string;
let engine: Engine;

const STEP: NormalStepDef = {
  id: "build",
  desc: "build it",
  do: "do the thing",
  check: "verify the thing",
  input: "user input",
  output: "out.md",
  on_pass: "done",
  on_fail: "build",
  max_fail_count: 3,
};

function startInstance(task = "test task"): string {
  const instId = engine.generateInstanceId("test-wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, task);
  engine.writeState(
    { active: true, workflow_name: "test-wf", current_step: STEP.id, current_phase: "check", fail_count: 0, user_task: task, paused: false, session_id: "sess-1" },
    instId,
  );
  return instId;
}

/** A mock SDK client whose prompt resolves with the given result. */
function makeClient(promptResult: unknown, opts?: { ownerMessages?: any[]; agents?: any[] }) {
  const promptCalls: any[] = [];
  const client = {
    promptCalls,
    session: {
      create: async () => ({ data: { id: "chk-test" } }),
      delete: async () => ({}),
      abort: async () => ({}),
      prompt: async (args: any) => { promptCalls.push(args); return promptResult; },
      messages: async () => ({ data: opts?.ownerMessages ?? [] }),
    },
    app: {
      agents: async () => ({ data: opts?.agents ?? [] }),
    },
  };
  return client;
}

const VERDICT_OK = { data: { parts: [{ type: "text", text: "ok\n<promise-check>true</promise-check>" }] } };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-check-test-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("adversarialCheck request-error surfacing", () => {
  it("surfaces the SDK error body (e.g. unknown model) instead of '空响应'", async () => {
    const instId = startInstance();
    // SDK with throwOnError=false resolves rejected requests as { error } —
    // this is exactly opencode's ModelNotFoundError shape.
    const client = makeClient({
      error: { name: "Unknown", data: { message: "Model not found: anthropic/nope-4. Did you mean: claude-sonnet-4-5?" } },
    });
    const result = await adversarialCheck(client, engine, instId, "sess-1", STEP, "check prompt", "task", { model: "anthropic/nope-4" });
    expect(result.passed).toBe(false);
    expect(result.infra).toBe(true);
    expect(result.reason).toContain("Model not found: anthropic/nope-4");
    expect(result.reason).toContain("anthropic/nope-4");
    expect(result.reason).not.toContain("空响应");
  });

  it("handles error bodies that only carry a top-level message", async () => {
    const instId = startInstance();
    const client = makeClient({ error: { message: "provider returned 401: invalid api key" } });
    const result = await adversarialCheck(client, engine, instId, "sess-1", STEP, "check prompt", "task", undefined);
    expect(result.infra).toBe(true);
    expect(result.reason).toContain("401");
  });

  it("still reports a genuine empty response when there is no error", async () => {
    const instId = startInstance();
    const client = makeClient({ data: { parts: [] } });
    const result = await adversarialCheck(client, engine, instId, "sess-1", STEP, "check prompt", "task", undefined);
    expect(result.infra).toBe(true);
    expect(result.reason).toContain("空响应");
  });

  it("parses a normal verdict response", async () => {
    const instId = startInstance();
    const client = makeClient({ data: { parts: [{ type: "text", text: "all good\n<promise-check>true</promise-check>" }] } });
    const result = await adversarialCheck(client, engine, instId, "sess-1", STEP, "check prompt", "task", undefined);
    expect(result.passed).toBe(true);
    expect(result.infra).toBeUndefined();
  });
});

// ─── Default verifier model follows the owner session ───────────────────────
//
// Server-side priority is input.model ?? agent.model ?? currentModel(session),
// and for a FRESH check session the last one lands on opencode's global
// default — not the model the user is actually driving. We substitute the
// owner session's live model for that broken fallback.

describe("verifier model resolution", () => {
  const ownerHistory = [
    { info: { role: "user", model: { providerID: "openai", modelID: "gpt-5" } } },
    { info: { role: "assistant" } },
    { info: { role: "user", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } } },
  ];

  it("workflow yaml model always wins (no fallbacks consulted)", async () => {
    const instId = startInstance();
    const client = makeClient(VERDICT_OK, {
      ownerMessages: ownerHistory,
      agents: [{ name: "ralph-check", model: { providerID: "google", modelID: "gemini-3-pro" } }],
    });
    await adversarialCheck(client, engine, instId, "sess-1", STEP, "p", "t", { model: "deepseek/deepseek-v4" });
    expect(client.promptCalls[0].body.model).toEqual({ providerID: "deepseek", modelID: "deepseek-v4" });
  });

  it("falls back to the owner session's CURRENT model (latest user message)", async () => {
    const instId = startInstance();
    const client = makeClient(VERDICT_OK, { ownerMessages: ownerHistory });
    await adversarialCheck(client, engine, instId, "sess-1", STEP, "p", "t", undefined);
    expect(client.promptCalls[0].body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
  });

  it("the verifier agent's own configured model beats the owner session (body stays empty)", async () => {
    const instId = startInstance();
    const client = makeClient(VERDICT_OK, {
      ownerMessages: ownerHistory,
      agents: [{ name: "ralph-check", model: { providerID: "google", modelID: "gemini-3-pro" } }],
    });
    await adversarialCheck(client, engine, instId, "sess-1", STEP, "p", "t", undefined);
    // Passing a model here would SHADOW the agent's deliberate config — omit it.
    expect(client.promptCalls[0].body.model).toBeUndefined();
  });

  it("ignores assistant messages and owner sessions without user model info", async () => {
    const instId = startInstance();
    const client = makeClient(VERDICT_OK, { ownerMessages: [{ info: { role: "assistant" } }] });
    await adversarialCheck(client, engine, instId, "sess-1", STEP, "p", "t", undefined);
    expect(client.promptCalls[0].body.model).toBeUndefined();
  });

  it("tolerates a missing app.agents API and null owner session id", async () => {
    const instId = startInstance();
    const client = makeClient(VERDICT_OK);
    delete (client as any).app;
    await adversarialCheck(client, engine, instId, null, STEP, "p", "t", undefined);
    expect(client.promptCalls[0].body.model).toBeUndefined();
  });
});
