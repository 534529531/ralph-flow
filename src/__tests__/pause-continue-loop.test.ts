import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine } from "../engine.js";
import { handleSessionIdle, __resetDrivingSessions } from "../driver.js";
import { createTools } from "../tools.js";

// 用户报告：暂停（达到 max_fail_count）后 continue，模型再输出 <promise>done</promise>，
// 无论如何 continue 都"不能往下走"，反复提示超过暂停次数。
// 本测试端到端复现：暂停 → continue → done → 检查失败 → 应正常走 on_fail（fail_count 重新计），
// 而不是死锁在暂停。

let tmpDir: string;
let engine: Engine;
let injected: Array<{ sessionId: string; text: string; noReply: boolean }>;
let lastAssistantText: string;
let lastHasToolUse: boolean;
let checkVerdict = "true";
let failCountSeq: string[] = [];

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
      create: async () => ({ data: { id: "chk-" + Math.random().toString(36).slice(2) } }),
      delete: async () => ({}),
      abort: async () => ({}),
      promptAsync: async (args: any) => record(args),
      prompt: async (args: any) => {
        if (String(args.path.id).startsWith("chk-")) {
          const verdict = failCountSeq.length > 0 ? failCountSeq.shift()! : checkVerdict;
          return { data: { parts: [{ type: "text", text: `check reason\n<promise-check>${verdict}</promise-check>` }] } };
        }
        return record(args);
      },
    },
  };
}

const WF = `
steps:
  - id: loop
    desc: iterate until pass
    do: do the work
    check: verify the work
    input: user input
    output: "out.md"
    on_pass: done
    on_fail: loop
    max_fail_count: 3
`;

function startInstance(): string {
  const instId = engine.generateInstanceId("wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  engine.writeState({ active: true, workflow_name: "wf", current_step: "loop", current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: "sess-1" }, instId);
  const wf = engine.loadWorkflow("wf")!;
  engine.buildDoPrompt(instId, wf.steps[0] as any, "task");
  return instId;
}

beforeEach(() => {
  __resetDrivingSessions();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-pause-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
  const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "wf.yaml"), WF);
  injected = [];
  lastAssistantText = "";
  lastHasToolUse = false;
  checkVerdict = "true";
  failCountSeq = [];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("暂停 → continue → done → 再失败（用户报告的死锁场景）", () => {
  it("暂停后 continue 归零 fail_count；done 后失败重新从 1 计，不再直接暂停", async () => {
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startInstance();

    // 1. 连续失败 3 次达到 max_fail_count → 暂停
    for (let i = 0; i < 3; i++) {
      failCountSeq.push("false");
      lastAssistantText = "did the work\n<promise>done</promise>";
      await handleSessionIdle(client, engine, "sess-1");
    }
    let st = engine.readState(instId)!;
    expect(st.paused).toBe(true);
    expect(st.pause_reason).toBe("max_failures");
    expect(st.fail_count).toBe(3);

    // 2. 用户 /ralphflow-continue → 恢复 DO，fail_count 归零
    const res = await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("工作流已恢复");
    st = engine.readState(instId)!;
    expect(st.paused).toBe(false);
    expect(st.fail_count).toBe(0);
    expect(st.current_phase).toBe("do");

    // 3. 模型重新输出 done → 检查失败 1 次 → 应只到 1/3，绝不直接暂停
    failCountSeq.push("false");
    lastAssistantText = "redone\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    st = engine.readState(instId)!;
    expect(st.paused).toBe(false);                    // 不能又暂停
    expect(st.fail_count).toBe(1);                    // 从 1 重新计
    expect(st.current_phase).toBe("do");
    // 最后一次注入是失败反馈（走 on_fail 重试），不是暂停文案
    const lastInj = injected[injected.length - 1];
    expect(lastInj.text).toContain("检查结果：失败 ✗ (1/3)");
    expect(lastInj.text).not.toContain("工作流已暂停");
  });

  it("暂停 → continue 后模型输出 done 但从未通过 → 每次都重新从 1 计，三次后再次暂停（循环可再 continue）", async () => {
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startInstance();

    // 首次达到暂停
    for (let i = 0; i < 3; i++) {
      failCountSeq.push("false");
      lastAssistantText = "did the work\n<promise>done</promise>";
      await handleSessionIdle(client, engine, "sess-1");
    }
    expect(engine.readState(instId)!.paused).toBe(true);

    // 5 轮「continue → done → 失败」循环，每一轮都应从 1 计到 3 再暂停
    for (let round = 0; round < 5; round++) {
      await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
      let st = engine.readState(instId)!;
      expect(st.paused).toBe(false);
      expect(st.fail_count).toBe(0);

      for (let i = 0; i < 3; i++) {
        failCountSeq.push("false");
        lastAssistantText = `round ${round} attempt ${i}\n<promise>done</promise>`;
        await handleSessionIdle(client, engine, "sess-1");
        st = engine.readState(instId)!;
        if (i < 2) {
          expect(st.paused).toBe(false);   // 前两次失败只累加，不暂停
          expect(st.fail_count).toBe(i + 1);
        }
      }
      // 第三次失败 → 再次暂停（可继续 continue，不是死锁）
      st = engine.readState(instId)!;
      expect(st.paused).toBe(true);
      expect(st.pause_reason).toBe("max_failures");
    }
  });

  it("暂停 → continue → done → 检查通过 → 工作流正常推进完成（continue 后不能卡死）", async () => {
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startInstance();

    for (let i = 0; i < 3; i++) {
      failCountSeq.push("false");
      lastAssistantText = "did the work\n<promise>done</promise>";
      await handleSessionIdle(client, engine, "sess-1");
    }
    expect(engine.readState(instId)!.paused).toBe(true);

    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);

    failCountSeq.push("true");
    lastAssistantText = "fixed it\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");

    const st = engine.readState(instId);
    expect(st).toBeNull(); // 单步工作流 on_pass: done → 完成销毁
  });
});
