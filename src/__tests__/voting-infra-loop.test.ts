import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine } from "../engine.js";
import { handleSessionIdle, __resetDrivingSessions } from "../driver.js";
import { createTools } from "../tools.js";

// 用户报告：暂停后 continue 无法推进。回归测试：
// voting 全票 infra → check_error 暂停 → continue → 空闲必须补跑投票
// （修复前：模型最后消息带 done 标签 → Case 1 静默 → 永不重跑 → 再 continue
//  误入崩溃恢复重置 DO，无限循环）。
// 修复后：continue 一次即补跑；infra 恢复则推进，持续 infra 则明确再暂停。

let tmpDir: string;
let engine: Engine;
let injected: Array<{ sessionId: string; text: string; noReply: boolean }>;
let lastAssistantText: string;
let infraAlways: string[] = [];   // 永远 infra 的票文本
let failAlways: string[] = [];    // 永远真实失败的票文本
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
        const text: string = args?.body?.parts?.[0]?.text ?? "";
        for (const key of infraAlways) {
          if (!text.includes(key)) continue;
          infraCalls++;
          return { error: { message: "API key invalid: 401" } };
        }
        for (const key of failAlways) {
          if (!text.includes(key)) continue;
          return { data: { parts: [{ type: "text", text: `${key} 检查未通过\n<promise-check>false</promise-check>` }] } };
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

function startInstance(): string {
  const instId = engine.generateInstanceId("voting-wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  engine.writeState(
    { active: true, workflow_name: "voting-wf", current_step: "build", current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: "sess-1" },
    instId,
  );
  const wf = engine.loadWorkflow("voting-wf")!;
  engine.buildDoPrompt(instId, wf.steps[0] as any, "task");
  return instId;
}

const WF_YAML = `steps:
  - id: build
    desc: build it
    do: do the thing
    input: in
    output: out.md
    check_voting:
      - check: "视角A:功能完整性"
      - check: "视角B:安全性"
    on_pass: done
    on_fail: build
    max_fail_count: 3
`;

beforeEach(() => {
  __resetDrivingSessions();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-voting-loop-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
  const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "voting-wf.yaml"), WF_YAML);
  injected = [];
  lastAssistantText = "";
  infraAlways = [];
  infraCalls = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("voting infra_pause → continue → 补跑投票（回归）", () => {
  it("continue 后旧 done 标签仍在：空闲必须补跑投票（修复前静默死锁）", async () => {
    infraAlways = ["视角A", "视角B"];
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startInstance();

    // 第一轮：done → 投票（2 票全 infra，自动重试 1 次）→ infra_pause
    lastAssistantText = "did it\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = engine.readState(instId)!;
    expect(st.paused).toBe(true);
    expect(st.pause_reason).toBe("check_error");
    expect(st.current_phase).toBe("check");
    const callsAfterPause = client.promptCalls.length;
    expect(callsAfterPause).toBe(4); // 2 票 × 2 轮
    expect(injected.some((m) => m.text.includes("部分验证未能运行"))).toBe(true);

    // continue → 分支 1 清暂停；模型无新输出，done 标签仍是最后消息
    const res = await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("基础设施故障已清除");
    st = engine.readState(instId)!;
    expect(st.paused).toBe(false);

    // 空闲 → 必须补跑投票（回归点：修复前此处静默，promptCalls 不增长）
    await handleSessionIdle(client, engine, "sess-1");
    st = engine.readState(instId)!;
    expect(client.promptCalls.length).toBe(callsAfterPause + 4); // 重投 2 票 × 2 轮
    expect(st.paused).toBe(true);          // 仍全 infra → 再暂停（明确提示，不是静默）
    expect(st.pause_reason).toBe("check_error");
    expect(st.fail_count).toBe(0);         // infra 不计失败
    expect(st.current_phase).toBe("check");
    // 投票进度保留（infra_failed 票），已通过票不重跑
    expect(injected.some((m) => m.text.includes("部分验证未能运行"))).toBe(true);
  });

  it("infra 恢复后：continue → 空闲补跑 → 全过 → 工作流推进（不再卡死）", async () => {
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startInstance();

    // 第一轮：一票 infra（另一票过）→ 自动重试仍 infra → infra_pause
    infraAlways = ["视角B"];
    lastAssistantText = "did it\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = engine.readState(instId)!;
    expect(st.paused).toBe(true);
    expect(st.pause_reason).toBe("check_error");

    // infra 恢复（不再有 infra 票）
    infraAlways = [];
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    // 模型无新输出，done 标签仍在 → 修复前这里永不重跑
    await handleSessionIdle(client, engine, "sess-1");

    // 补跑只投 infra_failed 的票（视角B），已过的视角A 不重投 → 2 次 prompt 调用
    // 视角A 在 resume 里保持 passed；视角B 重投通过 → 全过 → 单步 on_pass: done → 完成
    st = engine.readState(instId);
    expect(st).toBeNull(); // 工作流完成销毁
    expect(injected.some((m) => m.text.includes("全过")) || injected.some((m) => m.text.includes("通过"))).toBe(true);
  });
});

describe("新 bug 排查：补跑不双跑 / 补跑遇到真实失败", () => {
  it("验证进行中（.adversarial-session 非空）+ check 阶段 + done 标签 → 不补跑（防双跑）", async () => {
    const client = makeClient();
    const instId = startInstance();
    // 模拟验证会话正在跑：注册 .adversarial-session
    engine.writeAdversarialSession("chk-live-1", instId);
    engine.writeState({ ...engine.readState(instId)!, current_phase: "check" }, instId);
    lastAssistantText = "did it\n<promise>done</promise>";
    const callsBefore = client.promptCalls.length;

    await handleSessionIdle(client, engine, "sess-1");
    expect(client.promptCalls.length).toBe(callsBefore); // 没有双跑
    expect(engine.readState(instId)!.current_phase).toBe("check"); // 状态没动
  });

  it("补跑遇到真实失败（非 infra）→ 正常走 on_fail，fail_count 递增", async () => {
    failAlways = ["视角A"];
    const client = makeClient();
    const instId = startInstance();
    engine.writeState({ ...engine.readState(instId)!, current_phase: "check" }, instId);
    lastAssistantText = "did it\n<promise>done</promise>";
    // 补跑时一票真实失败（视角A 失败，视角B 通过）→ failed 优先 → on_fail 重试
    await handleSessionIdle(client, engine, "sess-1");
    const st = engine.readState(instId)!;
    expect(st.paused).toBe(false);
    expect(st.current_phase).toBe("do");      // on_fail: build 回到 DO
    expect(st.fail_count).toBe(1);            // 真实失败计 1 次
  });
});

describe("manual gate 与暂停叠加（continue 分支顺序）", () => {
  it("manual gate + session_gone 暂停：第一次 continue 清 gate，第二次 continue 恢复 DO（不是死锁）", async () => {
    // 手动步骤 done → gate 布防 → 会话中止 → session_gone 暂停（gate 残留）
    // continue 分支 2 优先于分支 3：第一次清 gate（paused 仍在），第二次走分支 3 恢复
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startInstance();
    engine.writeManualStepMarker(instId); // 模拟 manual_step 步骤
    fs.writeFileSync(path.join(engine.getInstanceDir(instId), ".manual-gate"), Date.now().toString(), "utf-8");
    engine.writeState({
      ...engine.readState(instId)!,
      paused: true, pause_reason: "session_aborted", fail_count: 2,
    }, instId);

    const res1 = await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res1)).toContain("审查通过");
    let st = engine.readState(instId)!;
    expect(st.paused).toBe(true); // 暂停未清——需要第二次 continue

    const res2 = await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res2)).toContain("工作流已恢复");
    st = engine.readState(instId)!;
    expect(st.paused).toBe(false);
    expect(st.fail_count).toBe(0);
    expect(st.current_phase).toBe("do");
  });
});
