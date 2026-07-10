import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine, RALPH_CHECK_AGENT_PERMISSION, RALPH_CHECK_BASH_PERMISSION } from "../engine.js";
import { detectDoneTag, stripCodeBlocks, handleSessionIdle, __resetDrivingSessions } from "../driver.js";
import { createTools } from "../tools.js";

// ─── Read-only verifier permissions (Claude --allowedTools parity) ───────────

describe("ralph-check verifier permissions", () => {
  it("denies edits and denies bash by default (allow-list, not blind allow)", () => {
    expect(RALPH_CHECK_AGENT_PERMISSION.edit).toBe("deny");
    expect(typeof RALPH_CHECK_AGENT_PERMISSION.bash).toBe("object");
    expect(RALPH_CHECK_BASH_PERMISSION["*"]).toBe("deny");
  });

  it("allows read-only inspection + test/build commands", () => {
    for (const cmd of ["cat *", "grep *", "git status *", "npm test *", "pytest *", "cargo test *", "cargo clippy *"]) {
      expect(RALPH_CHECK_BASH_PERMISSION[cmd]).toBe("allow");
    }
  });

  it("does NOT allow-list mutating shell (they fall through to the deny default)", () => {
    for (const cmd of ["rm *", "mv *", "cp *", "cargo fix *", "cargo fmt", "git commit *", "git push *", "git checkout *", "chmod *"]) {
      expect(RALPH_CHECK_BASH_PERMISSION[cmd]).toBeUndefined();
    }
  });
});

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

let checkVerdict = "true"; // controls the mock verifier's result

function makeClient() {
  const record = (args: any) => {
    injected.push({
      sessionId: args.path.id,
      text: args.body.parts[0].text,
      noReply: !!args.body.noReply,
    });
    return { data: {} };
  };
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
      // Independent verifier session.
      create: async () => ({ data: { id: "chk-" + Math.random().toString(36).slice(2) } }),
      delete: async () => ({}),
      abort: async () => ({}),
      // Driver drives via promptAsync; the verifier session uses prompt.
      promptAsync: async (args: any) => record(args),
      prompt: async (args: any) => {
        if (String(args.path.id).startsWith("chk-")) {
          return { data: { parts: [{ type: "text", text: `check reason\n<promise-check>${checkVerdict}</promise-check>` }] } };
        }
        return record(args);
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
  checkVerdict = "true";
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("handleSessionIdle", () => {
  it("the driver drives via promptAsync (non-blocking), not the blocking prompt", async () => {
    // Regression for the stall bug: a driving injection must NOT block on the
    // whole model turn. If the driver used the blocking `prompt`, the session's
    // next idle (carrying e.g. a done tag) would be dropped by the in-flight
    // guard. Assert the drive completes without any prompt() call blocking it.
    startInstance("build");
    lastAssistantText = "still working..."; // no done tag → keep-alive drive
    let blockingPromptCalled = false;
    const client = {
      session: {
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: lastAssistantText }] }] }),
        promptAsync: async (a: any) => { injected.push({ sessionId: a.path.id, text: a.body.parts[0].text, noReply: !!a.body.noReply }); return { data: {} }; },
        prompt: async () => { blockingPromptCalled = true; return { data: {} }; },
      },
    };
    await handleSessionIdle(client, engine, "sess-1");
    expect(injected.length).toBe(1);           // drove the model
    expect(blockingPromptCalled).toBe(false);  // via promptAsync, not prompt
  });

  it("re-entrant idle for the same session is dropped while one is in flight", async () => {
    startInstance("build");
    lastAssistantText = "working...";
    // Gate the driver's only remaining await (getLastAssistantMessage) so the
    // first drive stays in flight while a second idle arrives.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let messagesCalls = 0;
    const slowClient = {
      session: {
        messages: async () => { messagesCalls++; await gate; return { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: lastAssistantText }] }] }; },
        promptAsync: async (a: any) => { injected.push({ sessionId: a.path.id, text: a.body.parts[0].text, noReply: !!a.body.noReply }); return { data: {} }; },
        prompt: async () => ({ data: {} }),
      },
    };
    const first = handleSessionIdle(slowClient, engine, "sess-1");
    await new Promise((r) => setTimeout(r, 20));
    await handleSessionIdle(slowClient, engine, "sess-1"); // should no-op (guarded)
    release();
    await first;
    expect(messagesCalls).toBe(1); // only the first drive got past the guard
  });

  it("done tag on a normal step → auto-runs the check with visible messages, then advances", async () => {
    checkVerdict = "true";
    const instId = startInstance("build");
    lastAssistantText = "did the work\n<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    const texts = injected.map((i) => i.text);
    // visible CHECK-phase notice (with criteria) + visible result, both noReply
    // The CHECK phase message shows the full verifier context: user task, what DO
    // was supposed to produce (task desc, input, expected output), and check criteria.
    expect(texts.some((t) => t.includes("🔍 CHECK 阶段") && t.includes("检查依据")
      && t.includes("用户需求") && t.includes("task")
      && t.includes("Do 阶段任务") && t.includes("build the thing")
      && t.includes("user input") && t.includes("thing.md"))).toBe(true);
    expect(texts.some((t) => t.includes("检查结果：通过 ✓"))).toBe(true);
    // advanced to the next step (review) and injected its DO prompt (drives model)
    expect(engine.readState(instId)!.current_step).toBe("review");
    expect(texts.some((t) => t.includes("下一步") && t.includes("review"))).toBe(true);
  });

  it("normal-step check that fails re-issues the step (no manual tool call)", async () => {
    checkVerdict = "false";
    const instId = startInstance("build");
    lastAssistantText = "did the work\n<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    const texts = injected.map((i) => i.text);
    expect(texts.some((t) => t.includes("检查结果：失败 ✗"))).toBe(true);
    // stayed on build, fail_count incremented, retry DO prompt injected
    expect(engine.readState(instId)!.current_step).toBe("build");
    expect(engine.readState(instId)!.fail_count).toBe(1);
  });

  it("discards the check verdict if the instance was paused mid-check (owner session gone)", async () => {
    // Simulate handleSessionGone firing WHILE the ~1-min check runs: the owner
    // session is aborted/deleted and the instance is paused. A passing verdict
    // must be DISCARDED — applying it would clear the pause and inject the next
    // DO prompt into a now-dead session, orphaning the instance.
    checkVerdict = "true";
    const instId = startInstance("build");
    lastAssistantText = "did the work\n<promise>done</promise>";
    const client: any = makeClient();
    const origPrompt = client.session.prompt;
    client.session.prompt = async (args: any) => {
      if (String(args.path.id).startsWith("chk-")) {
        const s = engine.readState(instId)!;
        engine.writeState({ ...s, paused: true, pause_reason: "session_deleted" }, instId);
      }
      return origPrompt(args);
    };
    await handleSessionIdle(client, engine, "sess-1");
    const st = engine.readState(instId)!;
    expect(st.paused).toBe(true);            // pause preserved
    expect(st.current_step).toBe("build");   // NOT advanced
    expect(st.current_phase).toBe("check");  // left where it was
    // no "advance to next step" drive was injected
    expect(injected.some((i) => i.text.includes("下一步") && i.text.includes("review"))).toBe(false);
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

  it("check phase → silent while a check is actually running", async () => {
    const instId = startInstance("build");
    engine.writeState({ ...engine.readState(instId)!, current_phase: "check" }, instId);
    // Simulate a running adversarial check: write a session marker so the idle
    // handler knows a check is in progress and stays silent.
    engine.writeAdversarialSession("chk-running", instId);
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

  it("manual step: done → gate (silent to re-idle), no auto-check", async () => {
    // A manual step must NOT auto-run the check; it stops for user review.
    const instId = startInstance("review"); // review is in manual_step
    lastAssistantText = "prepared\n<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.some((i) => i.text.includes("📋") && i.text.includes("等待你的审查"))).toBe(true);
    // no check ran → still in do, no verdict message
    expect(engine.readState(instId)!.current_phase).toBe("do");
    expect(injected.some((i) => i.text.includes("检查结果"))).toBe(false);
    // a subsequent idle while the gate is up stays silent
    injected = [];
    lastAssistantText = "let me explain";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(0);
  });
});
