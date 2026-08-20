import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine } from "../engine.js";
import { handleSessionIdle, __resetDrivingSessions } from "../driver.js";

/**
 * 端到端 driver 级验证对抗性 check 可选化:一个没有 check 的步骤,DO 完成后
 * 不 spawn 验证者会话(chk-*),直接视为通过并走 on_pass,结果如实标记"跳过对抗性验证"。
 * (与 pause-continue-loop.test.ts 共用同一套 mock client 手法)
 */

let tmpDir: string;
let engine: Engine;
let injected: Array<{ sessionId: string; text: string; noReply: boolean }>;
let lastAssistantText: string;
let verifierSessionsCreated: number;

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
            parts: [{ type: "text", text: lastAssistantText }],
          },
        ],
      }),
      create: async () => {
        verifierSessionsCreated++;
        return { data: { id: "chk-" + Math.random().toString(36).slice(2) } };
      },
      delete: async () => ({}),
      abort: async () => ({}),
      promptAsync: async (args: any) => record(args),
      prompt: async (args: any) => {
        if (String(args.path.id).startsWith("chk-")) {
          return { data: { parts: [{ type: "text", text: "check reason\n<promise-check>true</promise-check>" }] } };
        }
        return record(args);
      },
    },
  };
}

// 单步、无 check 的工作流 → 该步被解析为 no_check
const WF_NOCHECK = `
steps:
  - id: only
    desc: do a thing
    do: make it
    input: user input
    output: "out.md"
    on_pass: done
    on_fail: only
    max_fail_count: 3
`;

// 对照组:带 check 的正常工作流
const WF_CHECK = WF_NOCHECK.replace("    output: \"out.md\"", "    output: \"out.md\"\n    check: verify the work");

function startInstance(stepId = "only"): string {
  const instId = engine.generateInstanceId("wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  engine.writeState({ active: true, workflow_name: "wf", current_step: stepId, current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: "sess-1" }, instId);
  const wf = engine.loadWorkflow("wf")!;
  engine.buildDoPrompt(instId, wf.steps[0] as any, "task");
  return instId;
}

function setup(WF: string) {
  const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "wf.yaml"), WF);
}

beforeEach(() => {
  __resetDrivingSessions();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-check-optional-driver-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
  injected = [];
  lastAssistantText = "";
  verifierSessionsCreated = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("driver: no-check step skips the adversarial verifier", () => {
  it("DO done on a no-check step completes the workflow WITHOUT spawning a verifier session", async () => {
    setup(WF_NOCHECK);
    const client = makeClient();
    const instId = startInstance();

    lastAssistantText = "made it\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");

    expect(verifierSessionsCreated).toBe(0); // 绝不创建独立验证会话
    // 完成即销毁实例 → 状态为 null(无暂停/重试残留),正是走完 on_pass=done 的证据
    expect(engine.readState(instId)).toBeNull();
    // 完成文案如实标记"跳过对抗性验证",不伪造"检查通过"
    const lastInj = injected[injected.length - 1];
    expect(lastInj.text).toContain("跳过对抗性验证");
  });

  it("control: a step WITH check still spawns the verifier (backward compat)", async () => {
    setup(WF_CHECK);
    const client = makeClient();
    startInstance();

    lastAssistantText = "made it\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");

    expect(verifierSessionsCreated).toBe(1); // check 步骤照常跑验证者
  });
});
