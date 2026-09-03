import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine, MANUAL_GATE_MARKER, MANUAL_GATE_APPROVED_MARKER } from "../engine.js";
import { handleSessionIdle, __resetDrivingSessions } from "../driver.js";
import { createTools } from "../tools.js";

/**
 * 端到端集成验证：真实会话序列驱动完整工作流生命周期（普通 → manual → 普通），
 * 以及 review 阶段的质量循环（失败自动重试不打扰用户、用户要改后 re-check）。
 * 比单测更接近真实：每个 idle 用真实的 lastAssistantText 模拟模型输出，
 * 验证者用 mock 会话返回可切换的判定。
 */

let tmpDir: string;
let engine: Engine;
let injected: Array<{ sessionId: string; text: string; noReply: boolean }>;
let lastAssistantText: string;
let checkVerdict: string;
let createdSessions: Array<{ title: string }>;

// 三步骤工作流：build(普通) → review(manual) → deploy(普通) → done
const WF = `
manual_step: [review]
steps:
  - id: build
    desc: build it
    do: build the thing
    check: verify build
    input: user input
    output: "out.md"
    on_pass: review
    on_fail: build
    max_fail_count: 3
  - id: review
    desc: manual review step
    do: prepare review
    check: verify review
    input: out.md
    output: "review.md"
    on_pass: deploy
    on_fail: review
    max_fail_count: 3
  - id: deploy
    desc: deploy it
    do: deploy the thing
    check: verify deploy
    input: review.md
    output: "deploy.md"
    on_pass: done
    on_fail: deploy
    max_fail_count: 3
`;

function makeClient() {
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
        createdSessions.push({ title: args.body?.title || "" });
        const title = args.body?.title || "";
        // 🔄/🔙 标题 = reset/rewind 换的新会话；其余（含验证会话）用 chk-*
        if (title.startsWith("🔄") || title.startsWith("🔙")) {
          return { data: { id: newSessionId } };
        }
        return { data: { id: "chk-" + Math.random().toString(36).slice(2) } };
      },
      delete: async () => ({}),
      abort: async () => ({}),
      promptAsync: async (args: any) => record(args),
      prompt: async (args: any) => {
        if (String(args.path.id).startsWith("chk-")) {
          return { data: { parts: [{ type: "text", text: `check reason\n<promise-check>${checkVerdict}</promise-check>` }] } };
        }
        return record(args);
      },
    },
    tui: { publish: async () => ({}), showToast: async () => ({}) },
  };
}

beforeEach(() => {
  __resetDrivingSessions();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-manual-gate-e2e-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
  const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "wf.yaml"), WF);
  injected = [];
  lastAssistantText = "";
  checkVerdict = "true";
  createdSessions = [];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function startInstance(): string {
  const tools = createTools(engine, makeClient());
  const res = tools.ralphflow_start;
  return res as any;
}

describe("manual gate end-to-end", () => {
  it("完整生命周期 build→review(门)→deploy→完成", async () => {
    const client = makeClient();
    const tools = createTools(engine, client);
    const res = await tools.ralphflow_start.execute({ workflow: "wf", task: "ship it" }, { sessionID: "sess-1" } as any);
    const startText = typeof res === "string" ? res : (res as any).output;
    expect(startText).toContain("已启动");
    const instId = engine.listInstances()[0].id;
    expect(engine.readState(instId)!.current_step).toBe("build");

    // build DO done → 自动 check 通过 → 推进到 review
    lastAssistantText = "built\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = engine.readState(instId)!;
    expect(st.current_step).toBe("review");
    expect(st.current_phase).toBe("do");

    // review DO done → 自动 check 通过 → 停下布防审查门（不推进到 deploy）
    lastAssistantText = "reviewed\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    st = engine.readState(instId)!;
    expect(st.current_step).toBe("review");
    expect(st.current_phase).toBe("do");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(true);
    expect(injected.some((i) => i.text.includes("轮到你审查"))).toBe(true);

    // 批准放行 → 推进到 deploy
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    await handleSessionIdle(client, engine, "sess-1");
    st = engine.readState(instId)!;
    expect(st.current_step).toBe("deploy");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(false);

    // deploy DO done → 自动 check 通过 → 完成
    lastAssistantText = "deployed\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)).toBeNull();
  });

  it("review check 失败自动重试（不布防门）→ 通过 → 门 → 用户要改 → re-check → 门 → 放行", async () => {
    const client = makeClient();
    const tools = createTools(engine, client);
    await tools.ralphflow_start.execute({ workflow: "wf", task: "ship it" }, { sessionID: "sess-1" } as any);
    const instId = engine.listInstances()[0].id;

    // 推进到 review（build check 通过）
    lastAssistantText = "built\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.current_step).toBe("review");

    // review check 第一次失败 → 自动重试回 review DO，不布防审查门
    checkVerdict = "false";
    lastAssistantText = "reviewed\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = engine.readState(instId)!;
    expect(st.current_step).toBe("review");
    expect(st.current_phase).toBe("do");
    expect(st.fail_count).toBe(1);
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(false);
    expect(injected.some((i) => i.text.includes("轮到你审查"))).toBe(false);

    // 第二次通过 → 布防门
    checkVerdict = "true";
    lastAssistantText = "reviewed v2\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    st = engine.readState(instId)!;
    expect(st.fail_count).toBe(1);
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(true);
    expect(injected.some((i) => i.text.includes("轮到你审查"))).toBe(true);

    // 用户要改 → 模型改 → done → 自动 re-check → 通过 → 门重新布防
    checkVerdict = "true";
    lastAssistantText = "reviewed v3 after user feedback\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(true);
    expect(injected.some((i) => i.text.includes("轮到你审查"))).toBe(true);

    // 批准放行 → 推进到 deploy（不是完成——review on_pass = deploy）
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    await handleSessionIdle(client, engine, "sess-1");
    let st2 = engine.readState(instId)!;
    expect(st2.current_step).toBe("deploy");
    expect(st2.current_phase).toBe("do");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(false);

    // deploy 完成 → 工作流完成
    lastAssistantText = "deployed\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)).toBeNull();
  });

  it("审查门布防期间 /ralphflow-reset → 换干净会话且旧 gate marker 不残留", async () => {
    const client = makeClient();
    const tools = createTools(engine, client);
    await tools.ralphflow_start.execute({ workflow: "wf", task: "ship it" }, { sessionID: "sess-1" } as any);
    const instId = engine.listInstances()[0].id;

    // 推进到 review 并布防门
    lastAssistantText = "built\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    lastAssistantText = "reviewed\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(true);

    // reset → 换新会话
    const res = await tools.ralphflow_reset.execute({}, { sessionID: "sess-1" } as any);
    expect(String(res)).toContain("已在新");
    const st = engine.readState(instId)!;
    expect(st.session_id).not.toBe("sess-1");
    expect(st.current_step).toBe("review");
    // 关键：旧 gate / approved / done 标记全部清理，不残留到新会话
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_APPROVED_MARKER))).toBe(false);

    // 新会话正常驱动：重做 review → done → 自动 check 通过 → 门重新布防（未被残留卡死）
    lastAssistantText = "redoing review\n<promise>done</promise>";
    await handleSessionIdle(client, engine, st.session_id);
    expect(engine.readState(instId)!.current_step).toBe("review");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(true);
    expect(injected.some((i) => i.text.includes("轮到你审查"))).toBe(true);
  });

  it("另一会话接管审查门布防中的实例 → continue 直接放行进入下一步", async () => {
    const client = makeClient();
    const tools = createTools(engine, client);
    await tools.ralphflow_start.execute({ workflow: "wf", task: "ship it" }, { sessionID: "sess-1" } as any);
    const instId = engine.listInstances()[0].id;

    // 推进到 review 并布防门（owner 仍是 sess-1）
    lastAssistantText = "built\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    lastAssistantText = "reviewed\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(true);

    // 新会话 sess-2 用 continue 接管并批准 → 直接放行（不重新验证）
    const res = await tools.ralphflow_continue.execute({}, { sessionID: "sess-2" } as any);
    expect(String(res)).toContain("审查通过");
    await handleSessionIdle(client, engine, "sess-2");
    const st = engine.readState(instId)!;
    expect(st.current_step).toBe("deploy");
    expect(st.session_id).toBe("sess-2");
  });

  it("voting + manual：check_voting 全过 → 门布防 → 放行完成", async () => {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), `manual_step: [review]
steps:
  - id: build
    desc: build it
    do: build the thing
    check_voting:
      - check: "视角A:完整性"
      - check: "视角B:安全性"
    input: i
    output: out.md
    on_pass: review
    on_fail: build
    max_fail_count: 3
  - id: review
    desc: manual review
    do: prepare review
    check_voting:
      - check: "视角C:可维护性"
    input: out.md
    output: review.md
    on_pass: done
    on_fail: review
    max_fail_count: 3
`);
    const client = makeClient();
    const tools = createTools(engine, client);
    await tools.ralphflow_start.execute({ workflow: "wf", task: "ship it" }, { sessionID: "sess-1" } as any);
    const instId = engine.listInstances()[0].id;

    // build 投票通过 → 推进 review
    lastAssistantText = "built\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.current_step).toBe("review");

    // review 投票通过 → 布防门
    lastAssistantText = "reviewed\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(fs.existsSync(path.join(engine.getInstanceDir(instId), MANUAL_GATE_MARKER))).toBe(true);
    expect(injected.some((i) => i.text.includes("轮到你审查"))).toBe(true);

    // 放行 → 完成
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)).toBeNull();
  });
});