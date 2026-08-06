import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine, RALPH_CHECK_AGENT_PERMISSION, shouldResetOnTransition, MANUAL_STEP_MARKER } from "../engine.js";
import { detectDoneTag, stripCodeBlocks, handleSessionIdle, __resetDrivingSessions } from "../driver.js";
import { createTools } from "../tools.js";

// ─── Verifier permissions: edit hard-deny + bash open + prompt discipline ─────

describe("ralph-check verifier permissions", () => {
  it("hard-denies edit (the one real mutation gate)", () => {
    expect(RALPH_CHECK_AGENT_PERMISSION.edit).toBe("deny");
  });

  it("leaves bash fully open — no allow-list, matches opencode's own plan/explore agents", () => {
    expect(RALPH_CHECK_AGENT_PERMISSION.bash).toBe("allow");
  });

  it("keeps webfetch + extra_dirs open so the verifier can read out-of-tree material", () => {
    expect(RALPH_CHECK_AGENT_PERMISSION.webfetch).toBe("allow");
    expect(RALPH_CHECK_AGENT_PERMISSION.external_directory).toBe("allow");
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
let createdSessions: any[];
let tuiPublished: any[];
let abortedSessions: Array<{ id: string; ownersAtAbort: string[] }>;
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

describe("start onboarding", () => {
  it("the start message teaches turn-taking (auto vs. 轮到你了)", async () => {
    const tools = createTools(engine, makeClient());
    const res = await tools.ralphflow_start.execute(
      { workflow: "wf", task: "build a thing" }, { sessionID: "sess-onboard" } as any);
    const text = typeof res === "string" ? res : (res as any).output;
    expect(text).toContain("怎么配合它"); // orientation blurb present
    expect(text).toContain("轮到你了");   // names the user-turn signal
  });
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
      && t.includes("无需你操作") // turn-taking guidance: wait, don't interact
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
    expect(injected[0].text).toContain("轮到你审查");
    expect(injected[0].text).toContain("/ralphflow-continue");
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

  it("manual step, DO phase, model asks a question (no done tag) → no auto-nudge", async () => {
    // Regression: during a manual step's DO phase the human is in the loop. If the
    // model pauses to ask the user a clarifying question BEFORE emitting the done
    // tag, the driver must stay silent — a keep-alive nudge here would bulldoze the
    // exchange the manual step exists for.
    const instId = startInstance("review"); // review ∈ manual_step, marker armed
    lastAssistantText = "在准备审查材料前，你想要 markdown 还是 PDF 格式？"; // a question, no done tag
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(0); // stayed silent, did not nudge
    // no gate yet (no done tag) and still in DO — nothing was mutated
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".manual-gate"))).toBe(false);
    expect(engine.readState(instId)!.current_phase).toBe("do");
  });

  it("a NORMAL step in the same spot DOES still get nudged (fix is manual-only)", async () => {
    // Guard against over-suppression: the silence is scoped to manual steps. A
    // normal step that stops without a done tag must still be kept alive.
    startInstance("build"); // build ∉ manual_step
    lastAssistantText = "先想一下该怎么做"; // no done tag, no tool use
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1);
    expect(injected[0].text).toContain("DO 阶段");
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

  it("stops driving after MAX_DO_REINJECT idles without tool use (warns once, then silent)", async () => {
    startInstance("build");
    lastAssistantText = "stuck";
    let sawWarning = false;
    for (let i = 0; i < 6; i++) {
      injected = [];
      await handleSessionIdle(makeClient(), engine, "sess-1");
      if (injected.length === 1 && injected[0].text.includes("已暂停自动驱动")) {
        sawWarning = true;
        expect(injected[0].noReply).toBe(true);
      }
    }
    expect(sawWarning).toBe(true); // the exhausted alarm fired when the count crossed the limit
    // Every idle afterwards is silent — no re-spamming the same warning
    for (let i = 0; i < 3; i++) {
      injected = [];
      await handleSessionIdle(makeClient(), engine, "sess-1");
      expect(injected.length).toBe(0);
    }
    // Workflow itself is NOT paused
    expect(engine.readState(engine.listInstances()[0].id)!.paused).toBe(false);
  });

  it("reinject-exhausted → user /ralphflow-continue confirms done → next idle runs the check and advances", async () => {
    // Regression: the exhausted alarm tells the user "run /ralphflow-continue to
    // enter verification", but continue used to fall through to the "nothing to
    // do" branch — the workflow could never advance. Now it must arm the done
    // marker so the next idle's Case 2 auto-runs the independent check.
    checkVerdict = "true";
    const instId = startInstance("build");
    lastAssistantText = "stuck";
    for (let i = 0; i < 6; i++) await handleSessionIdle(makeClient(), engine, "sess-1");
    injected = [];

    const tools = createTools(engine, makeClient());
    const res = await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("已确认完成");
    // done marker armed, exhausted counter cleared, state untouched (still do)
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".done-tag-detected"))).toBe(true);
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".do-reinject-count"))).toBe(false);
    expect(engine.readState(instId)!.current_phase).toBe("do");

    // Next idle → Case 2 re-runs the check → passes → advances to the next step
    await handleSessionIdle(makeClient(), engine, "sess-1");
    const texts = injected.map((i) => i.text);
    expect(texts.some((t) => t.includes("🔍 CHECK 阶段"))).toBe(true);
    expect(texts.some((t) => t.includes("检查结果：通过 ✓"))).toBe(true);
    expect(engine.readState(instId)!.current_step).toBe("review");
  });

  it("continue in a mid-DO step WITHOUT exhausted counter still says nothing to do (no false confirm)", async () => {
    // The confirm-done path must only arm when the reinject counter is actually
    // exhausted — a random continue call mid-DO must not fake a done tag.
    const instId = startInstance("build");
    const tools = createTools(engine, makeClient());
    const res = await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("无需操作");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".done-tag-detected"))).toBe(false);
    expect(engine.readState(instId)!.current_phase).toBe("do");
  });

  it("stale reinject counter from a previous step does not arm confirm-done", async () => {
    // Counter is keyed step:phase; after the step changed (or after a clear that
    // left a stale file) the old count must not trigger the confirm path.
    const instId = startInstance("build");
    fs.writeFileSync(path.join(engine.getInstanceDir(instId), ".do-reinject-count"), "old-step:do 99");
    const tools = createTools(engine, makeClient());
    const res = await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("无需操作");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), ".done-tag-detected"))).toBe(false);
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

  it("post-tool marker debounces the keep-alive within the grace window", async () => {
    // .post-tool-active is set when a tool just delivered the DO prompt. Within the
    // grace window the driver stays silent so a session.idle that fires before the
    // model's tool calls register does not interrupt it mid-work; the next idle
    // (marker consumed) resumes the keep-alive.
    const instId = startInstance("build");
    lastAssistantText = "working";
    await handleSessionIdle(makeClient(), engine, "sess-1"); // full report consumes first-report slot
    engine.markPromptDelivered("build", instId);
    injected = [];
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(0); // suppressed within the grace window
    injected = [];
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.length).toBe(1); // marker consumed, keep-alive resumes
  });

  it("swallowed idle schedules a catch-up drive after the grace window", async () => {
    // Regression: a model that finishes within the grace window emits its done
    // tag but stops, so the swallowed idle may be the session's ONLY one. Without
    // the scheduled catch-up, the workflow deadlocks until the user notices.
    // Here the catch-up fires after the window, finds the marker already consumed,
    // and sends the keep-alive the grace window had suppressed.
    vi.useFakeTimers();
    try {
      const instId = startInstance("build");
      lastAssistantText = "working";
      await handleSessionIdle(makeClient(), engine, "sess-1"); // full report
      engine.markPromptDelivered("build", instId);
      injected = [];
      await handleSessionIdle(makeClient(), engine, "sess-1"); // swallowed → schedules retry
      expect(injected.length).toBe(0);
      await vi.advanceTimersByTimeAsync(10001); // past the window → catch-up drive
      expect(injected.length).toBe(1); // marker consumed, keep-alive fired
    } finally {
      vi.useRealTimers();
    }
  });

  it("manual step: done → gate (silent to re-idle), no auto-check", async () => {
    // A manual step must NOT auto-run the check; it stops for user review.
    const instId = startInstance("review"); // review is in manual_step
    lastAssistantText = "prepared\n<promise>done</promise>";
    await handleSessionIdle(makeClient(), engine, "sess-1");
    expect(injected.some((i) => i.text.includes("轮到你审查") && i.text.includes("/ralphflow-continue"))).toBe(true);
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

// ─── Reset Gate (context reset on cross-step transitions) ────────────────────

// Shared by both reset-gate describe blocks. Creates a client whose session.create
// returns a fresh top-level session for 🔄-titled resets, a chk-* session otherwise.
function makeClientWithSessionCreate() {
  const newSessionId = "new-" + Math.random().toString(36).slice(2, 8);
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
      create: async (args: any) => {
        createdSessions.push(args);
        const title = args.body?.title || "";
        if (title.startsWith("🔄")) {
          return { data: { id: newSessionId } };
        }
        return { data: { id: "chk-" + Math.random().toString(36).slice(2) } };
      },
      delete: async () => ({}),
      abort: async (args: any) => {
        // Snapshot ownership at abort time so tests can prove the abort ran
        // AFTER claimOwnership (an abort before it would make session.error
        // → handleSessionGone pause the very instance being reset).
        abortedSessions.push({
          id: args.path.id,
          ownersAtAbort: engine.listInstances().map((i) => `${i.id}:${i.owner}`),
        });
        return {};
      },
      promptAsync: async (args: any) => record(args),
      prompt: async (args: any) => {
        if (String(args.path.id).startsWith("chk-")) {
          return { data: { parts: [{ type: "text", text: `check reason\n<promise-check>${checkVerdict}</promise-check>` }] } };
        }
        return record(args);
      },
    },
    tui: {
      publish: async (args: any) => {
        tuiPublished.push(args);
        return { data: true };
      },
      showToast: async () => ({ data: true }),
    },
  };
}

describe("reset gate", () => {
  const WF_RESET = `
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
    desc: review step
    do: review work
    check: verify review
    input: thing.md
    output: "result.md"
    reset: true
    on_pass: deploy
    on_fail: review
    max_fail_count: 2
  - id: deploy
    desc: deploy step
    do: deploy
    check: verify deploy
    input: result.md
    output: "deployed.md"
    on_pass: done
    on_fail: deploy
    max_fail_count: 1
`;

  function startInstanceInStep(step = "build", sessionId = "sess-1"): string {
    const instId = engine.generateInstanceId("wf");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.writeState({ active: true, workflow_name: "wf", current_step: step, current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: sessionId }, instId);
    const wf = engine.loadWorkflow("wf")!;
    engine.buildDoPrompt(instId, wf.steps.find((s) => s.id === step) as any, "task");
    return instId;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-driver-"));
    const platform: Platform = {};
    engine = createEngine(tmpDir, platform) as Engine;
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), WF_RESET);
    injected = [];
    createdSessions = [];
    tuiPublished = [];
    abortedSessions = [];
    lastAssistantText = "";
    lastHasToolUse = false;
    checkVerdict = "true";
  });

  afterEach(() => {
    __resetDrivingSessions();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("check pass → target step with reset: true creates new session and sends farewell to old", async () => {
    checkVerdict = "true";
    const instId = startInstanceInStep("build");
    lastAssistantText = "did the work\n<promise>done</promise>";
    const client = makeClientWithSessionCreate();
    await handleSessionIdle(client, engine, "sess-1");

    // Old session should get farewell message
    const oldMsgs = injected.filter((i) => i.sessionId === "sess-1");
    expect(oldMsgs.some((m) => m.text.includes("上下文已重置") && m.noReply)).toBe(true);

    // New session should get the transition text with next step
    const newMsgs = injected.filter((i) => i.sessionId !== "sess-1" && i.sessionId !== "chk-"
      && !String(i.sessionId).startsWith("chk-"));
    expect(newMsgs.length).toBeGreaterThan(0);
    expect(newMsgs.some((m) => m.text.includes("检查结果：通过") && m.text.includes("review"))).toBe(true);

    // Instance is now owned by the new session
    const st = engine.readState(instId)!;
    expect(st.session_id).not.toBe("sess-1");

    // The reset session is created pinned to THIS project directory
    // (multi-project TUI would otherwise land it under the wrong project)
    const resetCreate = createdSessions.find((a) => String(a.body?.title || "").startsWith("🔄"));
    expect(resetCreate?.query?.directory).toBe(tmpDir);

    // CRITICAL: the reset session must be a TOP-LEVEL session. With a parentID
    // it becomes a child session, and the TUI's /session list (dialog-session-list)
    // and home index both filter child sessions out — the workflow then runs in
    // a session the user can never find ("reset said it happened but nothing did").
    expect(resetCreate?.body?.parentID).toBeUndefined();

    // The TUI is asked to follow the workflow into the new session.
    const nav = tuiPublished.find((p) => p.body?.type === "tui.session.select");
    expect(nav?.body?.properties?.sessionID).toBe(st.session_id);
    expect(nav?.query?.directory).toBe(tmpDir);

    // The old session's in-flight turn is aborted — otherwise it keeps running
    // to completion while the new session redoes the same step (two sessions
    // editing one workspace concurrently).
    const abortRec = abortedSessions.find((a) => a.id === "sess-1");
    expect(abortRec).toBeTruthy();
    // …and the abort must run AFTER ownership moved, or session.error
    // (MessageAbortedError) → handleSessionGone would pause this instance.
    expect(abortRec?.ownersAtAbort.every((o) => !o.endsWith(":sess-1"))).toBe(true);
    // Instance stays active and unpaused after the whole reset.
    expect(engine.readState(instId)!.paused ?? false).toBe(false);
    expect(engine.readState(instId)!.active).toBe(true);

    // The new session's first message opens with a handoff briefing: why it
    // exists, where the workflow stands, where the artifacts live — so a cold
    // model isn't greeted by a bare "检查结果：通过" with zero context.
    const handoff = newMsgs.find((m) => m.text.includes("会话交接说明"));
    expect(handoff).toBeTruthy();
    expect(handoff?.text).toContain("`wf`");                 // workflow name
    expect(handoff?.text).toContain("第 2/3 步");            // progress: now on step 2 of 3
    expect(handoff?.text).toContain("build ✓");              // completed step marked from step records
    expect(handoff?.text).toContain("review 👈");            // current step highlighted
    expect(handoff?.text).toContain("ralph-flow/artifacts"); // artifacts dir pointer
    expect(handoff?.text).toContain("<promise>done</promise>"); // interaction contract
    expect(handoff?.text).toContain("检查结果：通过");        // original transition text preserved below
  });

  it("check fail → on_fail to self (same step, step marked reset) → reset fires", async () => {
    checkVerdict = "false";
    const instId = startInstanceInStep("review");
    lastAssistantText = "did the work\n<promise>done</promise>";
    await handleSessionIdle(makeClientWithSessionCreate(), engine, "sess-1");

    // Same-step retry on a reset-marked step ALSO gets a fresh context: a heavy
    // DO bloats the old one past the point where keeping the scene helps.
    expect(injected.some((m) => m.text.includes("上下文已重置"))).toBe(true);
    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("review");           // still the same step
    expect(st.session_id).not.toBe("sess-1");          // …but in a fresh session
    const newMsgs = injected.filter((m) => m.sessionId === st.session_id);
    expect(newMsgs.some((m) => m.text.includes("失败 ✗") && m.text.includes("review"))).toBe(true);
  });

  it("check fail → on_fail to self (same step, NOT marked reset) → no new session", async () => {
    checkVerdict = "false";
    const instId = startInstanceInStep("build");
    lastAssistantText = "did the work\n<promise>done</promise>";
    await handleSessionIdle(makeClientWithSessionCreate(), engine, "sess-1");

    // Unmarked step keeps the scene on retry — no farewell, no new session
    expect(injected.some((m) => m.text.includes("上下文已重置"))).toBe(false);
    expect(engine.readState(instId)!.session_id).toBe("sess-1");
    expect(injected.some((m) => m.text.includes("失败 ✗") && m.text.includes("build"))).toBe(true);
  });

  it("auto_reset workflow: same-step retry also fires reset", async () => {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), "auto_reset: true\n" + WF_RESET);
    checkVerdict = "false";
    const instId = startInstanceInStep("build");
    lastAssistantText = "did the work\n<promise>done</promise>";
    await handleSessionIdle(makeClientWithSessionCreate(), engine, "sess-1");

    // auto_reset is "reset on every step", so the same-step retry resets too
    expect(injected.some((m) => m.text.includes("上下文已重置"))).toBe(true);
    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("build");
    expect(st.session_id).not.toBe("sess-1");
  });

  it("check pass → normal step (no reset) → no new session (injected normally)", async () => {
    checkVerdict = "true";
    startInstanceInStep("review");
    lastAssistantText = "did the work\n<promise>done</promise>";
    await handleSessionIdle(makeClientWithSessionCreate(), engine, "sess-1");

    // No farewell — normal injection into old session
    expect(injected.some((m) => m.text.includes("上下文已重置"))).toBe(false);
    // Should find deploy step in transition (review on_pass = deploy)
    expect(injected.some((m) => m.text.includes("deploy"))).toBe(true);
  });

  it("manual gate stacks with reset: review in old session, reset fires after approval + check pass", async () => {
    // Three-party timing: the human reviews in the OLD session, the verifier runs
    // in its OWN session, and the context reset must fire only after the approved
    // step's check passes (on the transition build → review, which is marked reset).
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), "manual_step: [build]\n" + WF_RESET);

    checkVerdict = "true";
    const instId = startInstanceInStep("build");
    engine.writeManualStepMarker(instId);
    lastAssistantText = "did the work\n<promise>done</promise>";
    const client = makeClientWithSessionCreate();

    // 1. Done on a manual step → review gate arms; no reset, no check yet.
    await handleSessionIdle(client, engine, "sess-1");
    expect(injected.some((m) => m.sessionId === "sess-1" && m.text.includes("轮到你审查"))).toBe(true);
    expect(injected.some((m) => m.text.includes("上下文已重置"))).toBe(false);
    expect(engine.readState(instId)!.session_id).toBe("sess-1");

    // 2. User approves → gate cleared (done-tag marker deliberately kept).
    const tools = createTools(engine, client);
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);

    // 3. Next idle → check runs (pass) → transition to review (reset) → new session.
    await handleSessionIdle(client, engine, "sess-1");
    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("review");
    expect(st.session_id).not.toBe("sess-1");
    expect(injected.some((m) => m.sessionId === "sess-1" && m.text.includes("上下文已重置") && m.noReply)).toBe(true);
    const newMsgs = injected.filter((m) => m.sessionId === st.session_id);
    expect(newMsgs.some((m) => m.text.includes("检查结果：通过") && m.text.includes("review"))).toBe(true);
  });

  it("ralphflow_reset swaps the context container but keeps fail_count (no amnesty)", async () => {
    const instId = startInstanceInStep("build");
    engine.writeState({ ...engine.readState(instId)!, fail_count: 2, last_failure_reason: "broke twice" }, instId);
    const client = makeClientWithSessionCreate();
    const tools = createTools(engine, client);

    await tools.ralphflow_reset.execute({}, { sessionID: "sess-1" } as any);

    const st = engine.readState(instId)!;
    expect(st.fail_count).toBe(2);                      // budget NOT reset — max_fail_count brake stays real
    expect(st.last_failure_reason).toBe("broke twice"); // failure context carried into the new session
    expect(st.session_id).not.toBe("sess-1");           // ownership moved
    // The DO prompt cache is refreshed so idle nudges in the new session match the first injection
    expect(engine.readDoPromptCache(instId)).toContain("broke twice");
    const newMsgs = injected.filter((m) => m.sessionId === st.session_id);
    expect(newMsgs.some((m) => m.text.includes("上下文已手动重置"))).toBe(true);
    // Manual reset also creates a TOP-LEVEL session (child sessions are hidden
    // from /session) and asks the TUI to navigate there
    expect(createdSessions.find((a) => String(a.body?.title || "").startsWith("🔄"))?.body?.parentID).toBeUndefined();
    expect(tuiPublished.some((p) => p.body?.type === "tui.session.select" && p.body?.properties?.sessionID === st.session_id)).toBe(true);
    // Manual reset runs INSIDE the old session's active turn (the model called
    // the tool mid-turn) — that turn must be aborted so it can't keep editing
    // the workspace in parallel with the new session. Abort after ownership move.
    const abortRec = abortedSessions.find((a) => a.id === "sess-1");
    expect(abortRec).toBeTruthy();
    expect(abortRec?.ownersAtAbort.every((o) => !o.endsWith(":sess-1"))).toBe(true);
    // Handoff briefing also wraps the manual reset text
    const handoff = newMsgs.find((m) => m.text.includes("会话交接说明"));
    expect(handoff?.text).toContain("上下文已手动重置");
    expect(handoff?.text).toContain("build 👈"); // still on build, redoing it
  });

  it("ralphflow_reset refuses when the caller is not the owner", async () => {
    const instId = startInstanceInStep("build", "sess-owner");
    const client = makeClientWithSessionCreate();
    const tools = createTools(engine, client);
    const res = await tools.ralphflow_reset.execute({}, { sessionID: "sess-1" } as any);
    // sess-1 owns nothing; single instance → resolves with attach semantics → refused
    expect(String(res)).toContain("属主");
    expect(engine.readState(instId)!.session_id).toBe("sess-owner"); // untouched
  });

  it("ralphflow_reset refuses on a paused instance and points to /ralphflow-continue", async () => {
    const instId = startInstanceInStep("build");
    engine.writeState({
      ...engine.readState(instId)!,
      paused: true, pause_reason: "max_failures", fail_count: 3,
    }, instId);
    const client = makeClientWithSessionCreate();
    const tools = createTools(engine, client);
    const res = await tools.ralphflow_reset.execute({}, { sessionID: "sess-1" } as any);

    const text = String(res);
    expect(text).toContain("暂停");
    expect(text).toContain("/ralphflow-continue");
    // 状态原样：没换会话、没创建新会话、暂停未清
    const st = engine.readState(instId)!;
    expect(st.paused).toBe(true);
    expect(st.session_id).toBe("sess-1");
    expect(createdSessions.length).toBe(0);
  });
});

// ─── Reset Gate on sub-workflow entry (nested workflows) ─────────────────────
// handleCheckPassed pushes the parent frame and advances the state to the
// child's first step BEFORE the driver's reset gate runs, so the gate must look
// at the composite step on top of the state stack — not at the raw
// (sourceStep → childFirstStep) pair, which lives in different workflows.

describe("reset gate on sub-workflow entry", () => {
  const PARENT_WF = `
steps:
  - id: a
    desc: first
    do: do a
    check: check a
    input: i
    output: o
    on_pass: nest
    on_fail: a
    max_fail_count: 2
  - id: nest
    desc: nested block
    workflow: child
    input: i
    output: o
    on_pass: done
    on_fail: nest
    max_fail_count: 1
`;
  const CHILD_WF = `
steps:
  - id: sub1
    desc: child step
    do: do sub1
    check: check sub1
    input: i
    output: o
    on_pass: done
    on_fail: sub1
    max_fail_count: 1
`;

  function writeNestedWorkflows(parentYaml: string) {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), parentYaml);
    fs.writeFileSync(path.join(wfDir, "child.yaml"), CHILD_WF);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-driver-"));
    const platform: Platform = {};
    engine = createEngine(tmpDir, platform) as Engine;
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    injected = [];
    createdSessions = [];
    tuiPublished = [];
    abortedSessions = [];
    lastAssistantText = "";
    lastHasToolUse = false;
    checkVerdict = "true";
  });

  afterEach(() => {
    __resetDrivingSessions();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function startAtA(): string {
    const instId = engine.generateInstanceId("wf");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.writeState({ active: true, workflow_name: "wf", current_step: "a", current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: "sess-1" }, instId);
    const wf = engine.loadWorkflow("wf")!;
    engine.buildDoPrompt(instId, wf.steps.find((s) => s.id === "a") as any, "task");
    return instId;
  }

  it("composite step marked reset: true → reset fires on sub-workflow entry", async () => {
    writeNestedWorkflows(PARENT_WF.replace("workflow: child", "workflow: child\n    reset: true"));
    checkVerdict = "true";
    const instId = startAtA();
    lastAssistantText = "did a\n<promise>done</promise>";
    const client = makeClientWithSessionCreate();
    await handleSessionIdle(client, engine, "sess-1");

    // We DID enter the sub-workflow…
    const st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("child");
    expect(st.current_step).toBe("sub1");
    // …and the composite step's reset mark fired the gate
    expect(st.session_id).not.toBe("sess-1");
    expect(injected.some((m) => m.sessionId === "sess-1" && m.text.includes("上下文已重置") && m.noReply)).toBe(true);
    const newMsgs = injected.filter((m) => m.sessionId === st.session_id);
    expect(newMsgs.some((m) => m.text.includes("进入子工作流") && m.text.includes("会话交接说明"))).toBe(true);
    expect(createdSessions.find((a) => String(a.body?.title || "").startsWith("🔄"))?.body?.parentID).toBeUndefined();
    // briefing shows the CHILD workflow's progress (we're inside it now)
    expect(newMsgs.find((m) => m.text.includes("会话交接说明"))?.text).toContain("sub1 👈");
  });

  it("composite step unmarked but parent workflow auto_reset: true → reset fires on entry", async () => {
    writeNestedWorkflows(`auto_reset: true\n${PARENT_WF}`);
    checkVerdict = "true";
    const instId = startAtA();
    lastAssistantText = "did a\n<promise>done</promise>";
    const client = makeClientWithSessionCreate();
    await handleSessionIdle(client, engine, "sess-1");

    const st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("child");
    expect(st.session_id).not.toBe("sess-1");
    expect(injected.some((m) => m.sessionId === "sess-1" && m.text.includes("上下文已重置") && m.noReply)).toBe(true);
  });

  it("composite step unmarked, no auto_reset → normal injection, NO new session (regression)", async () => {
    writeNestedWorkflows(PARENT_WF);
    checkVerdict = "true";
    const instId = startAtA();
    lastAssistantText = "did a\n<promise>done</promise>";
    const client = makeClientWithSessionCreate();
    await handleSessionIdle(client, engine, "sess-1");

    const st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("child");
    expect(st.current_step).toBe("sub1");
    expect(st.session_id).toBe("sess-1"); // ownership untouched
    expect(injected.some((m) => m.text.includes("上下文已重置"))).toBe(false);
    expect(injected.some((m) => m.sessionId === "sess-1" && m.text.includes("进入子工作流"))).toBe(true);
  });

  it("check fail → on_fail re-enters a composite step marked reset → reset fires", async () => {
    // Parent: nest fails (child exhausted its budget) → parent on_fail: nest
    // re-enters the composite step, which is marked reset → fresh session.
    // (Parent budget must exceed 1 failure or the parent step pauses instead.)
    writeNestedWorkflows(
      PARENT_WF.replace("workflow: child", "workflow: child\n    reset: true").replace("on_fail: nest\n    max_fail_count: 1", "on_fail: nest\n    max_fail_count: 2"),
    );
    checkVerdict = "false"; // child's check fails; child max_fail_count: 1 → parent on_fail path
    const instId = startAtA();
    // Simulate: already inside the child workflow (parent frame on the stack)
    const childWf = engine.loadWorkflow("child")!;
    engine.pushState({ active: true, workflow_name: "wf", current_step: "nest", current_phase: "do", fail_count: 0, user_task: "task", paused: false }, instId);
    engine.writeState({ active: true, workflow_name: "child", current_step: "sub1", current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: "sess-1" }, instId);
    engine.buildDoPrompt(instId, childWf.steps[0] as any, "task");
    lastAssistantText = "tried sub1\n<promise>done</promise>";
    const client = makeClientWithSessionCreate();
    await handleSessionIdle(client, engine, "sess-1");

    // Back in the child workflow for the retry (parent on_fail: nest re-entered)
    const st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("child");
    expect(st.current_step).toBe("sub1");
    // …and the composite step's reset mark fired the gate on the re-entry
    expect(st.session_id).not.toBe("sess-1");
    expect(injected.some((m) => m.sessionId === "sess-1" && m.text.includes("上下文已重置") && m.noReply)).toBe(true);
  });
});

// ─── /ralphflow-rewind (回退到已通过 CHECK 的上游步骤) ──────────────────────

describe("rewind", () => {
  // 4-step 线性工作流：a → b(标 manual 且 reset) → c → d → done。
  // b 同时是 manual_step 与 reset gate 的目标：测两个分支都覆盖到。
  const WF_REWIND = `
description: rewind flow
manual_step: [b]
steps:
  - id: a
    desc: first
    do: do a
    check: check a
    input: i
    output: "a.md"
    on_pass: b
    on_fail: a
    max_fail_count: 3
  - id: b
    desc: mid (manual + reset)
    do: do b
    check: check b
    input: a.md
    output: "b.md"
    reset: true
    on_pass: c
    on_fail: b
    max_fail_count: 3
  - id: c
    desc: third
    do: do c
    check: check c
    input: b.md
    output: "c.md"
    on_pass: d
    on_fail: c
    max_fail_count: 3
  - id: d
    desc: last
    do: do d
    check: check d
    input: c.md
    output: "d.md"
    on_pass: done
    on_fail: d
    max_fail_count: 3
`;

  function makeRewindClient() {
    const newSessionId = "new-" + Math.random().toString(36).slice(2, 8);
    const record = (args: any) => {
      injected.push({ sessionId: args.path.id, text: args.body.parts[0].text, noReply: !!args.body.noReply });
      return { data: {} };
    };
    return {
      session: {
        messages: async () => ({
          data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: lastAssistantText }] }],
        }),
        create: async (args: any) => {
          createdSessions.push(args);
          const title = String(args.body?.title || "");
          return title.startsWith("🔄") || title.startsWith("🔙")
            ? { data: { id: newSessionId } }
            : { data: { id: "chk-" + Math.random().toString(36).slice(2) } };
        },
        delete: async () => ({}),
        abort: async (args: any) => {
          abortedSessions.push({
            id: args.path.id,
            ownersAtAbort: engine.listInstances().map((i) => `${i.id}:${i.owner}`),
          });
          return {};
        },
        promptAsync: async (args: any) => record(args),
        prompt: async (args: any) => record(args),
      },
      tui: {
        publish: async (args: any) => { tuiPublished.push(args); return { data: true }; },
        showToast: async () => ({ data: true }),
      },
    };
  }

  /**
   * 启动一个实例并把状态机停在 step；同时模拟 withPassed 中列出的步骤
   * "已经通过独立 CHECK"——直接 addStepRecord 植入历史记录。rewind 的可回退
   * 目标集合 = passedStepIds 完全由这些记录决定。
   */
  function startAt(step = "c", sessionId = "sess-1", withPassed: string[] = ["a", "b"]): string {
    const instId = engine.generateInstanceId("wf");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.writeState({
      active: true, workflow_name: "wf", current_step: step, current_phase: "do",
      fail_count: 0, user_task: "task", paused: false, session_id: sessionId,
    }, instId);
    const wf = engine.loadWorkflow("wf")!;
    engine.buildDoPrompt(instId, wf.steps.find((s) => s.id === step) as any, "task");
    for (const sid of withPassed) {
      engine.addStepRecord(instId, sid, "check", "passed", 0, "通过");
    }
    return instId;
  }

  beforeEach(() => {
    __resetDrivingSessions();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-rewind-"));
    const platform: Platform = {};
    engine = createEngine(tmpDir, platform) as Engine;
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), WF_REWIND);
    injected = [];
    createdSessions = [];
    tuiPublished = [];
    abortedSessions = [];
    lastAssistantText = "";
    lastHasToolUse = false;
    checkVerdict = "true";
  });

  it("rewinds to a passed step in a fresh session, advancing state machine + carrying reason", async () => {
    const instId = startAt("c", "sess-1", ["a", "b"]);
    const client = makeRewindClient();
    const tools = createTools(engine, client);

    const res = await tools.ralphflow_rewind.execute(
      { step: "a", reason: "a 的 API 假设错了，得回头重做" } as any,
      { sessionID: "sess-1" } as any,
    );

    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("a");
    expect(st.current_phase).toBe("do");
    expect(st.fail_count).toBe(0);          // rewind 显式赦免
    expect(st.paused).toBe(false);
    expect(st.session_id).not.toBe("sess-1"); // owner 转移到新会话

    // 新会话是 top-level（不是隐藏子会话）+ rewind 命名带 🔙（与 reset 的 🔄 区分）
    const resetReq = createdSessions.find((a) => String(a.body?.title || "").startsWith("🔙"));
    expect(resetReq).toBeTruthy();
    expect(resetReq?.body?.parentID).toBeUndefined();

    // 新会话首条注入 = briefing + transitionText（含 reason 段 + DO prompt）
    const newMsgs = injected.filter((m) => m.sessionId === st.session_id);
    expect(newMsgs.some((m) => m.text.includes("会话交接说明"))).toBe(true);
    expect(newMsgs.some((m) => m.text.includes("回退说明"))).toBe(true);
    // 回退头：从 c 回退到 a——from-step 必须来自回退前的状态（回归：曾写成"从 a 回退到 a"）
    expect(newMsgs.some((m) => m.text.includes("已从步骤 `c` 回退到 `a`"))).toBe(true);
    expect(newMsgs.some((m) => m.text.includes("a 的 API 假设错了"))).toBe(true);
    expect(newMsgs.some((m) => m.text.includes("当前任务"))).toBe(true);

    // 旧会话保留告别消息（rewind 措辞，不说"上下文已重置"）+ 被 abort
    expect(injected.some((m) => m.sessionId === "sess-1" && m.text.includes("已回退到步骤") && m.noReply)).toBe(true);
    expect(abortedSessions.some((a) => a.id === "sess-1")).toBe(true);
    // TUI 收到跳转事件
    expect(tuiPublished.some((p) => p.body?.type === "tui.session.select" && p.body?.properties?.sessionID === st.session_id)).toBe(true);

    // reason 入 .do-prompt-cache：idle keep-alive 重注入也带 reason（含正确的 from-step 头）
    expect(engine.readDoPromptCache(instId)).toContain("回退说明");
    expect(engine.readDoPromptCache(instId)).toContain("已从步骤 `c` 回退到 `a`");
    expect(engine.readDoPromptCache(instId)).toContain("a 的 API 假设错了");
    // 日志记了
    expect(String(res)).toContain("新会话");
  });

  it("keep_session: true stays in current session, returns full text with reason", async () => {
    const instId = startAt("c", "sess-1", ["a", "b"]);
    const client = makeRewindClient();
    const tools = createTools(engine, client);

    const res = await tools.ralphflow_rewind.execute(
      { step: "a", reason: "方向错了", keep_session: true } as any,
      { sessionID: "sess-1" } as any,
    );

    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("a");
    expect(st.session_id).toBe("sess-1");           // 没换会话
    expect(createdSessions.length).toBe(0);          // 没创建新会话
    expect(abortedSessions.length).toBe(0);
    expect(tuiPublished.length).toBe(0);

    const text = String(res);
    expect(text).toContain("回退说明");
    expect(text).toContain("已从步骤 `c` 回退到 `a`");   // from-step 头（回归）
    expect(text).toContain("方向错了");
    expect(text).toContain("当前任务");
    // reason 仍写入 cache（重要：keep_session 时 idle 之后还会重注入）
    expect(engine.readDoPromptCache(instId)).toContain("方向错了");
  });

  it("keep_session + wasPaused: 返回带「已从暂停恢复并回退」前缀", async () => {
    const instId = startAt("d", "sess-1", ["a", "b", "c"]);
    engine.writeState({
      ...engine.readState(instId)!,
      fail_count: 2, paused: true, pause_reason: "max_failures", last_failure_reason: "反复失败",
    }, instId);
    const tools = createTools(engine, makeRewindClient());
    const res = await tools.ralphflow_rewind.execute(
      { step: "b", reason: "换方向", keep_session: true } as any, { sessionID: "sess-1" } as any);

    const text = String(res);
    expect(text).toContain("已从暂停恢复并回退到步骤 `b`");
    expect(text).toContain("已从步骤 `d` 回退到 `b`");   // from-step 头（回归）
    const st = engine.readState(instId)!;
    expect(st.paused).toBe(false);
    expect(st.session_id).toBe("sess-1");                // keep_session 不换会话
  });

  it("新会话创建失败：状态机已倒退但给出明确下一步指引（不静默）", async () => {
    const instId = startAt("c", "sess-1", ["a", "b"]);
    const client = makeRewindClient();
    // 让 session.create 对 🔙 标题返回无 id —— executeContextReset 走失败路径
    client.session.create = async (args: any) => {
      createdSessions.push(args);
      return { data: {} };
    };
    const tools = createTools(engine, client);
    const res = await tools.ralphflow_rewind.execute(
      { step: "a", reason: "方向错了" } as any, { sessionID: "sess-1" } as any);

    const text = String(res);
    expect(text).toContain("状态机已倒退到步骤 `a`");
    expect(text).toContain("开新会话失败");
    expect(text).toContain("keep_session");
    // 状态机确实已倒退、属主未转移
    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("a");
    expect(st.session_id).toBe("sess-1");
  });

  it("reason is required: missing reason → refuse, ask the user", async () => {
    startAt("c", "sess-1", ["a", "b"]);
    const tools = createTools(engine, makeRewindClient());
    const res1 = await tools.ralphflow_rewind.execute(
      { step: "a" } as any, { sessionID: "sess-1" } as any);
    expect(String(res1)).toContain("原因");
    // 全空白也算缺
    const res2 = await tools.ralphflow_rewind.execute(
      { step: "a", reason: "   " } as any, { sessionID: "sess-1" } as any);
    expect(String(res2)).toContain("原因");
  });

  it("step must be specified: missing step → refuse", async () => {
    startAt("c", "sess-1", ["a", "b"]);
    const tools = createTools(engine, makeRewindClient());
    const res = await tools.ralphflow_rewind.execute(
      { reason: "x" } as any, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("目标步骤");
  });

  it("refuses when target is not in passed records, lists available targets", async () => {
    // a + b 通过过；state 在 d；rewind 到 c → c 没通过过 CHECK 且不是当前步，拒绝
    startAt("d", "sess-1", ["a", "b"]);
    const tools = createTools(engine, makeRewindClient());
    const res = await tools.ralphflow_rewind.execute(
      { step: "c", reason: "重做" } as any, { sessionID: "sess-1" } as any);
    const text = String(res);
    expect(text).toContain("只能回退到");
    expect(text).toContain("已通过 CHECK");
    // 列表里应含 a 和 b
    expect(text).toContain("`a`");
    expect(text).toContain("`b`");
  });

  it("refuses rewinding to the current step → directs to /ralphflow-reset", async () => {
    // state 在 b + b 通过过 CHECK（罕见但合法：用户已批准但又开始改 b）
    const instId = startAt("b", "sess-1", ["a", "b"]);
    const tools = createTools(engine, makeRewindClient());
    const res = await tools.ralphflow_rewind.execute(
      { step: "b", reason: "想重来" } as any, { sessionID: "sess-1" } as any);
    const text = String(res);
    expect(text).toContain("当前步骤");
    expect(text).toContain("/ralphflow-reset");
    expect(engine.readState(instId)!.current_step).toBe("b"); // 状态没动
  });

  it("refuses during the active CHECK phase (not paused)", async () => {
    const instId = startAt("c", "sess-1", ["a", "b"]);
    engine.writeState({ ...engine.readState(instId)!, current_phase: "check", paused: false }, instId);
    const tools = createTools(engine, makeRewindClient());
    const res = await tools.ralphflow_rewind.execute(
      { step: "a", reason: "x" } as any, { sessionID: "sess-1" } as any);
    expect(String(res)).toMatch(/独立 CHECK 进行中|稍候/);
    expect(engine.readState(instId)!.current_step).toBe("c");
    expect(engine.readState(instId)!.current_phase).toBe("check");
  });

  it("refuses when the caller is not the owner (must /ralphflow-continue first)", async () => {
    const instId = startAt("c", "sess-owner", ["a", "b"]);
    const tools = createTools(engine, makeRewindClient());
    const res = await tools.ralphflow_rewind.execute(
      { step: "a", reason: "x" } as any, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("属主");
    expect(engine.readState(instId)!.session_id).toBe("sess-owner");
  });

  it("paused instance rewind: clears paused + zeroes fail_count + advances state", async () => {
    const instId = startAt("d", "sess-1", ["a", "b", "c"]);
    // 把实例挂起：达到 max_failures 后典型状态——phase=do + paused + 有 fail_count
    engine.writeState({
      ...engine.readState(instId)!,
      current_phase: "do", fail_count: 3, paused: true,
      pause_reason: "max_failures", last_failure_reason: "卡住了",
    }, instId);
    const before = engine.readState(instId)!;
    expect(before.paused).toBe(true);

    const client = makeRewindClient();
    const tools = createTools(engine, client);
    const res = await tools.ralphflow_rewind.execute(
      { step: "b", reason: "换条路重试" } as any, { sessionID: "sess-1" } as any);

    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("b");
    expect(st.paused).toBe(false);
    expect(st.pause_reason).toBeUndefined();
    expect(st.fail_count).toBe(0);           // 暂停时的预算被均赦免
    expect(st.last_failure_reason).toBeUndefined();
    expect(st.session_id).not.toBe("sess-1"); // 默认换会话

    // 响应里点出"从暂停恢复"
    expect(String(res)).toMatch(/暂停|新会话/);
  });

  it("rewinding to a manual_step re-arms the manual review marker", async () => {
    const instId = startAt("c", "sess-1", ["a", "b"]);
    // 为保证测试的"从无到有"逻辑干净，先确认 manual_step 标记没预布防
    expect(engine.markerExists(MANUAL_STEP_MARKER, instId)).toBe(false);
    const tools = createTools(engine, makeRewindClient());
    await tools.ralphflow_rewind.execute(
      { step: "b", reason: "回头改 b 的产出方向", keep_session: true } as any,
      { sessionID: "sess-1" } as any);
    // b 在 workflow.manual_step 中——rewind 等价于 ralphflow_start 命中它：布防
    // .manual-step-active，让 driver 在 b 的 DO 完成后停下来请用户审查（而非自动验证）。
    expect(engine.markerExists(MANUAL_STEP_MARKER, instId)).toBe(true);
    expect(engine.readState(instId)!.current_step).toBe("b");
  });

  it("refuses rewinding to a target that is not in the workflow", async () => {
    startAt("c", "sess-1", ["a", "b"]);
    const tools = createTools(engine, makeRewindClient());
    const res = await tools.ralphflow_rewind.execute(
      { step: "notexist", reason: "x" } as any, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("不在工作流");
  });

  it("refuses cross-stack-frame rewind when inside a sub-workflow", async () => {
    // WF_REWIND 是普通工作流；要测跨栈帧，必须进子工作流——push 一帧父状态
    // 取巧：用户问"在子工作流里回到父工作流步骤"。这里用一个能 stack 非空的 trick：
    // 直接 push 一个栈帧伪造子工作流环境（rewind 第一版一律拒掉这种场景）。
    const instId = startAt("c", "sess-1", ["a", "b"]);
    engine.pushState(
      { active: true, workflow_name: "wf", current_step: "a", current_phase: "do",
        fail_count: 0, user_task: "task", paused: false },
      instId,
    );
    // 现在 stack 非空——rewind 拒绝
    const tools = createTools(engine, makeRewindClient());
    const res = await tools.ralphflow_rewind.execute(
      { step: "a", reason: "x" } as any, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("子工作流内");
    expect(String(res)).toContain("不支持");
    // 状态未动
    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("c");
    expect(st.paused).toBe(false);
  });
});

// ─── /ralphflow-reset 顺手补的可选 reason 注入 ───────────────────────────────

describe("reset with optional reason", () => {
  // 复用 reset gate 描述块里 4-step 工作流：WF_RESET（build→review→deploy）。
  const WF_RESET_4 = `
steps:
  - id: a
    desc: first
    do: do a
    check: check a
    input: i
    output: "a.md"
    on_pass: b
    on_fail: a
    max_fail_count: 3
  - id: b
    desc: mid (reset)
    do: do b
    check: check b
    input: a.md
    output: "b.md"
    reset: true
    on_pass: c
    on_fail: b
    max_fail_count: 2
  - id: c
    desc: last
    do: do c
    check: check c
    input: b.md
    output: "c.md"
    on_pass: done
    on_fail: c
    max_fail_count: 1
`;

  function makeResetClient() {
    const newSessionId = "new-" + Math.random().toString(36).slice(2, 8);
    const record = (args: any) => {
      injected.push({ sessionId: args.path.id, text: args.body.parts[0].text, noReply: !!args.body.noReply });
      return { data: {} };
    };
    return {
      session: {
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: lastAssistantText }] }] }),
        create: async (args: any) => {
          createdSessions.push(args);
          return String(args.body?.title || "").startsWith("🔄")
            ? { data: { id: newSessionId } }
            : { data: { id: "chk-" + Math.random().toString(36).slice(2) } };
        },
        delete: async () => ({}),
        abort: async (args: any) => {
          abortedSessions.push({
            id: args.path.id,
            ownersAtAbort: engine.listInstances().map((i) => `${i.id}:${i.owner}`),
          });
          return {};
        },
        promptAsync: async (args: any) => record(args),
        prompt: async (args: any) => record(args),
      },
      tui: {
        publish: async (args: any) => { tuiPublished.push(args); return { data: true }; },
        showToast: async () => ({ data: true }),
      },
    };
  }

  function startInStep(step = "a", sessionId = "sess-1"): string {
    const instId = engine.generateInstanceId("wf");
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, "task");
    engine.writeState({
      active: true, workflow_name: "wf", current_step: step, current_phase: "do",
      fail_count: 2, last_failure_reason: "broke twice", user_task: "task",
      paused: false, session_id: sessionId,
    }, instId);
    const wf = engine.loadWorkflow("wf")!;
    engine.buildDoPrompt(instId, wf.steps.find((s) => s.id === step) as any, "task");
    return instId;
  }

  beforeEach(() => {
    __resetDrivingSessions();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-reset-reason-"));
    const platform: Platform = {};
    engine = createEngine(tmpDir, platform) as Engine;
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), WF_RESET_4);
    injected = [];
    createdSessions = [];
    tuiPublished = [];
    abortedSessions = [];
    lastAssistantText = "";
    lastHasToolUse = false;
    checkVerdict = "true";
  });

  it("without reason: byte-compatible with the old transition text (regression)", async () => {
    const instId = startInStep("a", "sess-1");
    const before = engine.readState(instId)!;
    const client = makeResetClient();
    const tools = createTools(engine, client);

    await tools.ralphflow_reset.execute({} as any, { sessionID: "sess-1" } as any);

    const st = engine.readState(instId)!;
    // fail_count 与 last_failure_reason 保持不变（reset 不赦免）
    expect(st.fail_count).toBe(before.fail_count);
    expect(st.last_failure_reason).toBe(before.last_failure_reason);
    const newMsgs = injected.filter((m) => m.sessionId === st.session_id && !m.noReply);
    // 旧式 transitionText 的头部还在
    expect(newMsgs.some((m) => m.text.includes("上下文已手动重置"))).toBe(true);
    expect(newMsgs.some((m) => m.text.includes("步骤 `a` 将重新执行"))).toBe(true);
    // 出现"上下文重置说明"或"重置原因"——只有传 reason 时才出现
    expect(newMsgs.some((m) => m.text.includes("重置原因"))).toBe(false);
  });

  it("with reason: pulls reason into the new session + persists in cache", async () => {
    const instId = startInStep("a", "sess-1");
    const client = makeResetClient();
    const tools = createTools(engine, client);

    await tools.ralphflow_reset.execute(
      { reason: "模型开始跑偏、把无关重构也夹带进来了" } as any,
      { sessionID: "sess-1" } as any,
    );

    const st = engine.readState(instId)!;
    expect(st.fail_count).toBe(2); // reset 仍不赦免
    const newMsgs = injected.filter((m) => m.sessionId === st.session_id && !m.noReply);
    expect(newMsgs.some((m) => m.text.includes("上下文已手动重置"))).toBe(true);
    expect(newMsgs.some((m) => m.text.includes("重置原因"))).toBe(true);
    expect(newMsgs.some((m) => m.text.includes("模型开始跑偏"))).toBe(true);
    // cache 被覆盖成带 reason 的版本（idle keep-alive 仍保留）
    expect(engine.readDoPromptCache(instId)).toContain("模型开始跑偏");
  });
});

// ─── check_voting driver-level smoke tests ────────────────────────────────────

describe("check_voting via handleSessionIdle", () => {
  let vTmpDir: string;
  let vEngine: Engine;

  // A voting client whose verifier prompt routes verdicts by the check text.
  function makeVotingClient(votes: Record<string, boolean>) {
    return {
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: lastAssistantText }],
            },
          ],
        }),
        create: async () => ({ data: { id: "chk-v-" + Math.random().toString(36).slice(2) } }),
        delete: async () => ({}),
        abort: async () => ({}),
        promptAsync: async (args: any) => {
          injected.push({ sessionId: args.path.id, text: args.body.parts[0].text, noReply: !!args.body.noReply });
          return { data: {} };
        },
        prompt: async (args: any) => {
          const text: string = args.body.parts?.[0]?.text ?? "";
          for (const [key, pass] of Object.entries(votes)) {
            if (text.includes(key)) {
              return { data: { parts: [{ type: "text", text: `判定:${key}\n<promise-check>${pass ? "true" : "false"}</promise-check>` }] } };
            }
          }
          return { data: { parts: [{ type: "text", text: "ok\n<promise-check>true</promise-check>" }] } };
        },
      },
    };
  }

  const VOTING_WF = `
steps:
  - id: build
    desc: build it
    do: build the thing
    input: user input
    output: "thing.md"
    check_voting:
      - check: "PASS:视角A"
      - check: "PASS:视角B"
    on_pass: done
    on_fail: build
    max_fail_count: 3
`;

  function startVotingStep(sessionId = "sess-1"): string {
    const instId = vEngine.generateInstanceId("voting-smoke");
    fs.mkdirSync(vEngine.getInstanceDir(instId), { recursive: true });
    vEngine.writeArtifactsDirName(instId, "task");
    vEngine.writeState({
      active: true, workflow_name: "voting-smoke", current_step: "build", current_phase: "do",
      fail_count: 0, user_task: "task", paused: false, session_id: sessionId,
    }, instId);
    const wf = vEngine.loadWorkflow("voting-smoke")!;
    vEngine.buildDoPrompt(instId, wf.steps[0] as any, "task");
    return instId;
  }

  beforeEach(() => {
    injected = [];
    __resetDrivingSessions();
    vTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-voting-driver-"));
    const platform: Platform = {};
    vEngine = createEngine(vTmpDir, platform) as Engine;
    const wfDir = path.join(vTmpDir, ".opencode", "ralph-flow", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "voting-smoke.yaml"), VOTING_WF, "utf-8");
  });

  afterEach(() => {
    fs.rmSync(vTmpDir, { recursive: true, force: true });
  });

  it("all voters pass → workflow advances to done", async () => {
    const instId = startVotingStep();
    lastAssistantText = "done\n<promise>done</promise>";
    lastHasToolUse = false;
    await handleSessionIdle(makeVotingClient({ "视角A": true, "视角B": true }), vEngine, "sess-1");

    const st = vEngine.readState(instId);
    expect(st).toBeNull(); // completed → instance destroyed
  });

  it("one voter fails → back to DO with aggregated reason", async () => {
    const instId = startVotingStep();
    lastAssistantText = "done\n<promise>done</promise>";
    lastHasToolUse = false;
    await handleSessionIdle(makeVotingClient({ "视角A": true, "视角B": false }), vEngine, "sess-1");

    const st = vEngine.readState(instId)!;
    expect(st.current_phase).toBe("do");
    expect(st.current_step).toBe("build");
    expect(st.fail_count).toBe(1);
    expect(st.last_failure_reason).toContain("视角B");
    expect(st.last_failure_reason).toContain("全过才放行");
  });

  it("live per-vote progress is injected into the owner session", async () => {
    const instId = startVotingStep();
    lastAssistantText = "done\n<promise>done</promise>";
    lastHasToolUse = false;
    const before = injected.length;
    await handleSessionIdle(makeVotingClient({ "视角A": true, "视角B": false }), vEngine, "sess-1");
    const progressMsgs = injected.slice(before).filter((m) => /^🔍 [✅❌⚠️]/.test(m.text) && m.noReply);
    expect(progressMsgs.length).toBe(2); // one per vote
    const all = progressMsgs.map((m) => m.text).join("\n");
    expect(all).toContain("✅ 验证者");
    expect(all).toContain("❌ 验证者");
  });
});
