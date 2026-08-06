import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine, type NormalStepDef, type CheckVotingEntry } from "../engine.js";
import { runVotingCheck, formatVotingFailureReason, formatVotingPassReason } from "../check-voting.js";
import { readVotingProgress, deleteVotingProgress, writeVotingProgress, initVotingProgress } from "../voting-progress.js";

let tmpDir: string;
let engine: Engine;

const ENTRIES: CheckVotingEntry[] = [
  { check: "视角A:功能完整性" },
  { check: "视角B:安全性" },
  { check: "视角C:性能" },
];

const STEP: NormalStepDef = {
  id: "build",
  desc: "build it",
  do: "do the thing",
  input: "user input",
  output: "out.md",
  check_voting: ENTRIES,
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

type VoteSpec = { passed?: boolean; infra?: boolean };

/** prompt mock routes by the check text each voter prompt contains. */
function makeClient(specs: Record<string, VoteSpec>) {
  const promptCalls: any[] = [];
  const client = {
    promptCalls,
    session: {
      create: async () => ({ data: { id: "chk-x" } }),
      delete: async () => ({}),
      abort: async () => ({}),
      prompt: async (args: any) => {
        promptCalls.push(args);
        const text: string = args?.body?.parts?.[0]?.text ?? "";
        for (const [key, spec] of Object.entries(specs)) {
          if (!text.includes(key)) continue;
          if (spec.infra) return { error: { message: "rate limit" } };
          const verdict = spec.passed ? "true" : "false";
          return { data: { parts: [{ type: "text", text: `${key} 检查完成\n<promise-check>${verdict}</promise-check>` }] } };
        }
        return { data: { parts: [{ type: "text", text: "ok\n<promise-check>true</promise-check>" }] } };
      },
      messages: async () => ({ data: [] }),
    },
    app: { agents: async () => ({ data: [] }) },
  };
  return client;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-voting-test-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runVotingCheck — aggregation (all must pass)", () => {
  it("all passed → passed", async () => {
    const instId = startInstance();
    const client = makeClient({ "视角A": { passed: true }, "视角B": { passed: true }, "视角C": { passed: true } });
    const outcome = await runVotingCheck(client, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "do", workflowName: "test-wf", progress: null });
    expect(outcome.kind).toBe("passed");
    expect(outcome.verdicts.length).toBe(3);
    expect(outcome.verdicts.every((v) => v.status === "passed")).toBe(true);
    expect(readVotingProgress(engine, instId)).toBeNull(); // file deleted after pass
  });

  it("any failed → failed (all must pass), reason aggregates failed voters only", async () => {
    const instId = startInstance();
    const client = makeClient({ "视角A": { passed: true }, "视角B": { passed: false }, "视角C": { passed: true } });
    const outcome = await runVotingCheck(client, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "do", workflowName: "test-wf", progress: null });
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toContain("多验证者检查 2/3 通过,全过才放行");
    expect(outcome.reason).toContain("视角B");       // failed voter listed
    expect(outcome.reason).toContain("已通过的验证者");
    expect(readVotingProgress(engine, instId)).toBeNull();
  });

  it("onVoteProgress fires per completed vote (live progress push)", async () => {
    const instId = startInstance();
    const client = makeClient({ "视角A": { passed: true }, "视角B": { passed: false }, "视角C": { passed: true } });
    const messages: string[] = [];
    const outcome = await runVotingCheck(client, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, {
      phase: "do", workflowName: "test-wf", progress: null,
      onVoteProgress: (m) => messages.push(m),
    });
    expect(outcome.kind).toBe("failed");
    // one message per vote, in completion order
    expect(messages.length).toBe(3);
    const all = messages.join("\n");
    expect(all).toContain("✅ 验证者");      // passed votes
    expect(all).toContain("❌ 验证者");      // failed vote
    expect(messages.some((m) => m.includes("1/3") || m.includes("2/3") || m.includes("3/3"))).toBe(true);
    expect(messages.some((m) => m.includes("视角B"))).toBe(true); // check summary included
  });

  it("onVoteProgress reports infra retry lifecycle", async () => {
    const instId = startInstance();
    const client = makeClient({ "视角A": { passed: true }, "视角B": { passed: true }, "视角C": { infra: true } });
    const messages: string[] = [];
    const outcome = await runVotingCheck(client, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, {
      phase: "do", workflowName: "test-wf", progress: null,
      onVoteProgress: (m) => messages.push(m),
    });
    expect(outcome.kind).toBe("infra_pause");
    const all = messages.join("\n");
    expect(all).toContain("⚠️");             // infra vote flagged
    expect(all).toContain("自动重试中");
    expect(all).toContain("重试仍失败，工作流将暂停");
  });

  it("failed beats infra (mixed round judges failed, not pause)", async () => {
    const instId = startInstance();
    const client = makeClient({ "视角A": { passed: false }, "视角B": { infra: true } });
    // 2 entries only for this test — use a smaller step
    const smallStep: NormalStepDef = { ...STEP, check_voting: [{ check: "视角A" }, { check: "视角B" }] };
    const outcome = await runVotingCheck(client, engine, instId, "sess-1", smallStep, "t", smallStep.check_voting!, undefined, { phase: "do", workflowName: "test-wf", progress: null });
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toContain("视角A");
    expect(readVotingProgress(engine, instId)).toBeNull();
  });
});

describe("runVotingCheck — infra auto-retry", () => {
  it("infra retried once; still infra with no failed → infra_pause, progress kept with infra_failed", async () => {
    const instId = startInstance();
    // 视角C always infra (2 rounds), others pass
    const client = makeClient({ "视角A": { passed: true }, "视角B": { passed: true }, "视角C": { infra: true } });
    const outcome = await runVotingCheck(client, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "do", workflowName: "test-wf", progress: null });
    expect(outcome.kind).toBe("infra_pause");
    expect(outcome.keepProgress).toBe(true);
    const progress = readVotingProgress(engine, instId);
    expect(progress).not.toBeNull();
    const c = progress!.entries.find((e) => e.check.includes("视角C"));
    expect(c?.status).toBe("infra_failed");
    const a = progress!.entries.find((e) => e.check.includes("视角A"));
    expect(a?.status).toBe("passed");
  });

  it("transient infra passes on retry → passed (cached votes not re-run)", async () => {
    const instId = startInstance();
    // 视角C infra only on the FIRST attempt — but the mock routes by prompt text,
    // so simulate by counting prompt calls for 视角C.
    let cCalls = 0;
    const client: any = {
      promptCalls: [] as any[],
      session: {
        create: async () => ({ data: { id: "chk-x" } }),
        delete: async () => ({}),
        abort: async () => ({}),
        prompt: async (args: any) => {
          client.promptCalls.push(args);
          const text: string = args?.body?.parts?.[0]?.text ?? "";
          if (text.includes("视角C")) {
            cCalls++;
            if (cCalls === 1) return { error: { message: "rate limit" } };
            return { data: { parts: [{ type: "text", text: "视角C 重试后通过\n<promise-check>true</promise-check>" }] } };
          }
          if (text.includes("视角B")) return { data: { parts: [{ type: "text", text: "视角B ok\n<promise-check>true</promise-check>" }] } };
          return { data: { parts: [{ type: "text", text: "视角A ok\n<promise-check>true</promise-check>" }] } };
        },
        messages: async () => ({ data: [] }),
      },
      app: { agents: async () => ({ data: [] }) },
    };
    const outcome = await runVotingCheck(client, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "do", workflowName: "test-wf", progress: null });
    expect(outcome.kind).toBe("passed");
    expect(cCalls).toBe(2); // initial + one retry, no more
    expect(readVotingProgress(engine, instId)).toBeNull();
  });
});

describe("runVotingCheck — resume after continue (no deadlock)", () => {
  it("infra_failed reset to pending on resume; passed votes cached", async () => {
    const instId = startInstance();
    // First run: C infra twice → infra_pause
    const c1 = makeClient({ "视角A": { passed: true }, "视角B": { passed: true }, "视角C": { infra: true } });
    const outcome1 = await runVotingCheck(c1, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "do", workflowName: "test-wf", progress: null });
    expect(outcome1.kind).toBe("infra_pause");

    // User continue → driver idle re-enters with phase="check" and the kept file.
    const progress = readVotingProgress(engine, instId)!;
    // Second run: C now works → passed. A/B must NOT be re-run (cached).
    const c2 = makeClient({ "视角A": { passed: true }, "视角B": { passed: true }, "视角C": { passed: true } });
    const c2Calls = c2.promptCalls;
    const outcome2 = await runVotingCheck(c2, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "check", workflowName: "test-wf", progress });
    expect(outcome2.kind).toBe("passed");
    // Only 视角C re-voted on resume (its prompt is the only one with 视角C text… but
    // prompt routing matches on includes("视角A") too — count by check text).
    const resumedPrompts = c2Calls.map((p: any) => p?.body?.parts?.[0]?.text ?? "");
    const aVotes = resumedPrompts.filter((t: string) => t.includes("视角A")).length;
    const bVotes = resumedPrompts.filter((t: string) => t.includes("视角B")).length;
    const cVotes = resumedPrompts.filter((t: string) => t.includes("视角C")).length;
    expect(aVotes).toBe(0); // cached
    expect(bVotes).toBe(0); // cached
    expect(cVotes).toBe(1); // only the infra_failed vote re-ran
    expect(readVotingProgress(engine, instId)).toBeNull(); // file deleted after pass
  });

  it("no deadlock: continue → re-pause cycle works with budget reset per pause", async () => {
    const instId = startInstance();
    const c1 = makeClient({ "视角A": { passed: true }, "视角B": { passed: true }, "视角C": { infra: true } });
    const o1 = await runVotingCheck(c1, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "do", workflowName: "test-wf", progress: null });
    expect(o1.kind).toBe("infra_pause");

    // continue #1 — C still broken → pause again (budget resets per pause-session)
    const p1 = readVotingProgress(engine, instId)!;
    const c2 = makeClient({ "视角A": { passed: true }, "视角B": { passed: true }, "视角C": { infra: true } });
    const o2 = await runVotingCheck(c2, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "check", workflowName: "test-wf", progress: p1 });
    expect(o2.kind).toBe("infra_pause");
    const p2 = readVotingProgress(engine, instId)!;
    expect(p2.entries.find((e) => e.check.includes("视角C"))?.status).toBe("infra_failed");

    // continue #2 — C finally works → passed
    const c3 = makeClient({ "视角A": { passed: true }, "视角B": { passed: true }, "视角C": { passed: true } });
    const o3 = await runVotingCheck(c3, engine, instId, "sess-1", STEP, "t", ENTRIES, undefined, { phase: "check", workflowName: "test-wf", progress: p2 });
    expect(o3.kind).toBe("passed");
  });
});

describe("aggregation formatters", () => {
  it("formatVotingFailureReason lists failed voters with their check criteria", () => {
    const reason = formatVotingFailureReason(
      [
        { index: 0, status: "passed", reason: "全绿" },
        { index: 1, status: "failed", reason: "[auth.ts:47] 硬编码密钥" },
      ],
      ENTRIES,
    );
    expect(reason).toContain("视角B:安全性");
    expect(reason).toContain("[auth.ts:47] 硬编码密钥");
    expect(reason).toContain("已通过的验证者");
  });

  it("formatVotingPassReason lists all votes", () => {
    const reason = formatVotingPassReason(
      [
        { index: 0, status: "passed", reason: "功能 ok" },
        { index: 1, status: "passed", reason: "安全 ok" },
      ],
      ENTRIES,
    );
    expect(reason).toContain("2/2 验证者全过");
    expect(reason).toContain("功能");
  });

  it("formatters survive empty/missing reasons", () => {
    const reason = formatVotingFailureReason([{ index: 0, status: "failed", reason: "" }], ENTRIES);
    expect(reason).toContain("必须修复");
  });
});

describe("voting progress file lifecycle", () => {
  it("fresh round deletes existing file (cross-round)", () => {
    const instId = startInstance();
    deleteVotingProgress(engine, instId);
    // simulate a leftover file from a previous round
    writeVotingProgress(engine, instId, initVotingProgress("build", "test-wf", ENTRIES));
    expect(readVotingProgress(engine, instId)).not.toBeNull();
    // driver calls delete on phase="do" — mimic:
    deleteVotingProgress(engine, instId);
    expect(readVotingProgress(engine, instId)).toBeNull();
  });
});
