import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine } from "../engine.js";
import { detectDoneTag, stripCodeBlocks, handleSessionIdle, __resetDrivingSessions } from "../driver.js";
import { createTools } from "../tools.js";

// ─── Done-tag detection (mirror of hook-tests) ───────────────────────────────

describe("detectDoneTag", () => {
  it("detects the tag on the last line", () => {
    expect(detectDoneTag("work finished\n<promise>done</promise>")).toBe(true);
  });

  it("detects within the last 100 chars", () => {
    expect(detectDoneTag("all good <promise>done</promise>  \nshort trailer")).toBe(true);
  });

  it("ignores a tag buried early in a long message", () => {
    expect(detectDoneTag("<promise>done</promise>\n" + "x".repeat(500))).toBe(false);
  });

  it("ignores tags inside fenced code blocks", () => {
    expect(detectDoneTag("```\n<promise>done</promise>\n```")).toBe(false);
  });

  it("ignores tags inside inline code", () => {
    expect(detectDoneTag("输出 `<promise>done</promise>` 标记")).toBe(false);
  });

  it("tolerates whitespace inside the tag and mixed case", () => {
    expect(detectDoneTag("done\n<Promise> done </Promise>")).toBe(true);
  });
});

describe("stripCodeBlocks", () => {
  it("removes fenced blocks but keeps indented lines", () => {
    const text = "keep me\n```js\nsecret\n```\n    indented survives";
    const out = stripCodeBlocks(text);
    expect(out).not.toContain("secret");
    expect(out).toContain("indented survives");
  });
});

// ─── handleSessionIdle behaviors ─────────────────────────────────────────────

let tmpDir: string;
let engine: Engine;
let injected: Array<{ sessionId: string; text: string; noReply: boolean }>;
let lastAssistantText: string;
let lastHasToolUse: boolean;

function makeClient() {
  return {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant" },
            parts: [
              ...(lastHasToolUse ? [{ type: "tool" }] : []),
              { type: "text", text: lastAssistantText },
            ],
          },
        ],
      }),
      prompt: async (args: any) => {
        injected.push({
          sessionId: args.path.id,
          text: args.body.parts[0].text,
          noReply: !!args.body.noReply,
        });
        return { data: {} };
      },
    },
  };
}

const WF = `
manual_step: [review]
steps:
  - id: build
    desc: build it
    do: build the thing
    check: verify the thing
    input: user input
    output: "thing.md"
    on_pass: review
    on_fail: build
    max_fail_count: 3
  - id: review
    desc: manual review step
    do: prepare for review
    check: verify review
    input: thing.md
    output: "review.md"
    on_pass: done
    on_fail: review
    max_fail_count: 3
`;

function startInstance(step = "build", sessionId = "sess-1"): string {
  const instId = engine.generateInstanceId("wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  engine.writeState({ active: true, workflow_name: "wf", current_step: step, current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: sessionId }, instId);
  if (step === "review") engine.writeManualStepMarker(instId);
  const wf = engine.loadWorkflow("wf")!;
  engine.buildDoPrompt(instId, wf.steps.find((s) => s.id === step) as any, "task"); // seed the prompt cache
  return instId;
}

beforeEach(() => {
  __resetDrivingSessions();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-driver-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
  const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "wf.yaml"), WF);
  injected = [];
  lastAssistantText = "";
  lastHasToolUse = false;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleSessionIdle", () => {
  it("a blocked idle drive never stalls a concurrent tool call (regression: State lock timeout)", async () => {
    startInstance("build");
    lastAssistantText = "still working..."; // no done tag → drive injects a keep-alive/report

    // A prompt that blocks until we release it — simulates a long model turn.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slowClient = {
      session: {
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: lastAssistantText }] }] }),
        prompt: async () => { await gate; return { data: {} }; },
      },
    };

    // Start the idle drive; it blocks inside injectPrompt (the gated prompt).
    const drive = handleSessionIdle(slowClient, engine, "sess-1");
    await new Promise((r) => setTimeout(r, 20)); // let it reach the blocked prompt

    // While the drive is blocked, a status tool call from another session MUST
    // return immediately. There is no shared lock, so this can't stall — before
    // the redesign the driver held the state lock across injectPrompt and this
    // threw "State lock timeout" after 30s.
    const tools = createTools(engine, makeClient());
    const t0 = Date.now();
    await tools.ralphflow_status.execute({}, { sessionID: "sess-2" } as any);
    expect(Date.now() - t0).toBeLessThan(500);

    release();
    await drive;
  });

  it("re-entrant idle for the same session is dropped while one is in flight", async () => {
    startInstance("build");
    lastAssistantText = "working...";
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let prompts = 0;
    const slowClient = {
      session: {
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: lastAssistantText }] }] }),
        prompt: async () => { prompts++; await gate; return { data: {} }; },
      },
    };
    const first = handleSessionIdle(slowClient, engine, "sess-1");
    await new Promise((r) => setTimeout(r, 20));
    await handleSessionIdle(slowClient, engine, "sess-1"); // should no-op (guarded)
    release();
    await first;
    expect(prompts).toBe(1);
  });

  it("done tag on a normal step → instructs calling ralphflow_continue and persists the marker", async () => {
    const instId = startInstance("build");
    lastAssistantText = "did the work\n<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1);
    expect(injected[0].text).toContain("DO 阶段完成");
    expect(injected[0].text).toContain("ralphflow_continue");
    expect(injected[0].noReply).toBe(false); // drives the model
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".done-tag-detected"))).toBe(true);
  });

  it("done tag on a MANUAL step → stops for user review (noReply), arms the gate", async () => {
    const instId = startInstance("review");
    lastAssistantText = "prepared\n<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1);
    expect(injected[0].text).toContain("📋");
    expect(injected[0].text).toContain("等待你的审查");
    expect(injected[0].noReply).toBe(true); // user-facing, must NOT drive the model
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".manual-gate"))).toBe(true);
  });

  it("manual gate active → completely silent so the user can chat", async () => {
    const instId = startInstance("review");
    lastAssistantText = "prepared\n<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    injected = [];
    lastAssistantText = "sure, let me explain that for you"; // user chatting, no done tag
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(0);
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".manual-gate"))).toBe(true);
  });

  it("done tag while phase is check → ignored, no stale marker", async () => {
    const instId = startInstance("build");
    engine.writeState({ ...engine.readState(instId)!, current_phase: "check" }, instId);
    lastAssistantText = "<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(0);
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".done-tag-detected"))).toBe(false);
  });

  it("idle without done tag → first a full phase report, then keep-alives with the cached DO prompt", async () => {
    startInstance("build");
    lastAssistantText = "hmm let me think";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1);
    expect(injected[0].text).toContain("DO 阶段");
    expect(injected[0].text).toContain("build the thing");

    injected = [];
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1);
    expect(injected[0].text).toContain("继续执行步骤");
  });

  it("stops driving after MAX_DO_REINJECT idles without tool use", async () => {
    startInstance("build");
    lastAssistantText = "stuck";
    for (let i = 0; i < 6; i++) {
      injected = [];
      await handleSessionIdle(makeClient(), engine, "sess-1");
    }
    injected = [];
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1);
    expect(injected[0].text).toContain("已停止自动驱动");
    expect(injected[0].noReply).toBe(true);
    // Workflow itself is NOT paused
    expect(engine.readState(engine.listInstances()[0].id)!.paused).toBe(false);
  });

  it("tool activity does not burn the reinject counter", async () => {
    startInstance("build");
    lastAssistantText = "working...";
    lastHasToolUse = true;
    for (let i = 0; i < 10; i++) {
      injected = [];
      await handleSessionIdle(makeClient(), engine, "sess-1");
    }
    // still keep-aliving, not the stop message
    expect(injected[0].text).toContain("继续执行步骤");
  });

  it("paused instance → silent", async () => {
    const instId = startInstance("build");
    engine.writeState({ ...engine.readState(instId)!, paused: true, pause_reason: "max_failures" }, instId);
    lastAssistantText = "anything";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(0);
  });

  it("check phase → silent", async () => {
    const instId = startInstance("build");
    engine.writeState({ ...engine.readState(instId)!, current_phase: "check" }, instId);
    lastAssistantText = "waiting";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(0);
  });

  it("a foreign session's idle never drives another session's instance", async () => {
    const instId = startInstance("build"); // owned by sess-1
    lastAssistantText = "still working...";
    // sess-9 owns nothing here — its idle must not touch sess-1's instance.
    await handleSessionIdle(makeClient(), engine, "sess-9");
    expect(injected.length).toBe(0);
    // Ownership unchanged.
    expect(engine.readOwnerSession(instId)).toBe("sess-1");
  });

  it("post-tool marker suppresses the immediate duplicate keep-alive", async () => {
    const instId = startInstance("build");
    lastAssistantText = "thinking";
    await handleSessionIdle(makeClient(), engine, "sess-1"); // full report consumes first-report slot
    engine.markPromptDelivered("build", instId);
    injected = [];
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(0); // suppressed
    injected = [];
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1); // marker consumed, keep-alive resumes
  });

  it("done-tag marker present without gate → reminds to call ralphflow_continue", async () => {
    startInstance("build");
    lastAssistantText = "did it\n<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    injected = [];
    lastAssistantText = "ok what now"; // model chattered without calling the tool
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1);
    expect(injected[0].text).toContain("请立即调用 `ralphflow_continue`");
  });
});
