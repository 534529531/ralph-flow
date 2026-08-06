import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine } from "../engine.js";
import { handleSessionIdle, __resetDrivingSessions } from "../driver.js";
import { createTools } from "../tools.js";

// 用户补充：单 check（非 check_voting）场景同样复现——检查器持续 infra
// （超时/API 错/模型不可用）→ check_error 暂停 → continue 后验证永不重跑 →
// 再 continue 误入崩溃恢复重置 DO → 无限循环。
// 回归：continue 后（旧 done 标签仍在）空闲必须补跑单检查；infra 恢复则推进。

let tmpDir: string;
let engine: Engine;
let injected: Array<{ sessionId: string; text: string; noReply: boolean }>;
let lastAssistantText: string;
let checkInfra = false;   // 单检查 mock 是否返回 infra
let infraCalls = 0;

function makeClient() {
  const client: any = {
    promptCalls: [] as any[],
    session: {
      create: async () => ({ data: { id: "chk-" + Math.random().toString(36).slice(2) } }),
      delete: async () => ({}),
      abort: async () => ({}),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: lastAssistantText }],
          },
        ],
      }),
      prompt: async (args: any) => {
        client.promptCalls.push(args);
        if (checkInfra) {
          infraCalls++;
          return { error: { message: "API key invalid: 401" } };
        }
        return { data: { parts: [{ type: "text", text: "ok\n<promise-check>true</promise-check>" }] } };
      },
      promptAsync: async (args: any) => {
        injected.push({ sessionId: args.path.id, text: args.body.parts[0].text, noReply: !!args.body.noReply });
        return { data: {} };
      },
    },
    app: { agents: async () => ({ data: [] }) },
  };
  return client;
}

const WF_YAML = `steps:
  - id: build
    desc: build it
    do: do the thing
    input: in
    output: out.md
    check: verify the thing
    on_pass: done
    on_fail: build
    max_fail_count: 3
`;

function startInstance(): string {
  const instId = engine.generateInstanceId("plain-wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  engine.writeState(
    { active: true, workflow_name: "plain-wf", current_step: "build", current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: "sess-1" },
    instId,
  );
  const wf = engine.loadWorkflow("plain-wf")!;
  engine.buildDoPrompt(instId, wf.steps[0] as any, "task");
  return instId;
}

beforeEach(() => {
  __resetDrivingSessions();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-plain-check-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
  const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "plain-wf.yaml"), WF_YAML);
  injected = [];
  lastAssistantText = "";
  checkInfra = false;
  infraCalls = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("单 check infra_pause → continue → 补跑（回归）", () => {
  it("continue 后旧 done 标签仍在：空闲必须补跑单检查（修复前静默死锁）", async () => {
    checkInfra = true;
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startInstance();

    // done → 单检查 infra → 自动重试 1 次仍 infra → check_error 暂停
    lastAssistantText = "did it\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = engine.readState(instId)!;
    expect(st.paused).toBe(true);
    expect(st.pause_reason).toBe("check_error");
    expect(st.current_phase).toBe("check");
    const callsAfterPause = client.promptCalls.length;
    expect(callsAfterPause).toBe(1); // 单检查：1 次 infra（无 voting 式自动重试）
    expect(injected.some((m) => m.text.includes("验证未能运行"))).toBe(true);

    // continue → 分支 1 清暂停；模型无新输出，done 标签仍是最后消息
    const res = await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("基础设施故障已清除");
    st = engine.readState(instId)!;
    expect(st.paused).toBe(false);

    // 空闲 → 必须补跑单检查（回归点：修复前此处静默，promptCalls 不增长）
    await handleSessionIdle(client, engine, "sess-1");
    st = engine.readState(instId)!;
    expect(client.promptCalls.length).toBe(callsAfterPause + 1); // 补跑 1 次单检查
    expect(st.paused).toBe(true);          // 仍 infra → 再暂停（明确，不静默）
    expect(st.pause_reason).toBe("check_error");
    expect(st.fail_count).toBe(0);         // infra 不计失败
    expect(st.current_phase).toBe("check");
  });

  it("单 check infra 恢复后：continue → 空闲补跑 → 通过 → 工作流推进（不再卡死）", async () => {
    checkInfra = true;
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startInstance();

    lastAssistantText = "did it\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.paused).toBe(true);

    // infra 恢复
    checkInfra = false;
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    // 模型无新输出，done 标签仍在 → 修复前这里永不重跑
    await handleSessionIdle(client, engine, "sess-1");

    // 补跑通过 → on_pass: done → 单步工作流完成销毁
    const st = engine.readState(instId);
    expect(st).toBeNull();
  });
});
