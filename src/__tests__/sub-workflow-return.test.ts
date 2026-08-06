import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createEngine, type Platform, type Engine } from "../engine.js";
import { handleSessionIdle, __resetDrivingSessions } from "../driver.js";
import { createTools } from "../tools.js";

// 用户反馈：子工作流完成了回不到父工作流。
// 本测试端到端验证：父(stepA → nest(child) → stepC) → 子(sub1 → sub2)，
// 子工作流完成必须正常回父继续 stepC 并最终完成父工作流。

let tmpDir: string;
let engine: Engine;
let injected: Array<{ sessionId: string; text: string; noReply: boolean }>;
let lastAssistantText: string;
let checkVerdict = "true";

const PARENT_WF = `
steps:
  - id: stepA
    desc: first
    do: do a
    check: check a
    input: i
    output: o
    on_pass: nest
    on_fail: stepA
    max_fail_count: 3
  - id: nest
    desc: nested block
    workflow: child
    input: i
    output: o
    on_pass: stepC
    on_fail: nest
    max_fail_count: 3
  - id: stepC
    desc: last
    do: do c
    check: check c
    input: i
    output: o
    on_pass: done
    on_fail: stepC
    max_fail_count: 3
`;

const CHILD_WF = `
steps:
  - id: sub1
    desc: child first
    do: do sub1
    check: check sub1
    input: i
    output: o
    on_pass: sub2
    on_fail: sub1
    max_fail_count: 3
  - id: sub2
    desc: child last
    do: do sub2
    check: check sub2
    input: i
    output: o
    on_pass: done
    on_fail: sub2
    max_fail_count: 3
`;

function makeClient() {
  const record = (args: any) => {
    injected.push({ sessionId: args.path.id, text: args.body.parts[0].text, noReply: !!args.body.noReply });
    return { data: {} };
  };
  return {
    session: {
      messages: async () => ({
        data: [
          { info: { role: "assistant" }, parts: [{ type: "text", text: lastAssistantText }] },
        ],
      }),
      create: async () => ({ data: { id: "chk-" + Math.random().toString(36).slice(2) } }),
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
    app: { agents: async () => ({ data: [] }) },
  };
}

function startAtStepA(): string {
  const instId = engine.generateInstanceId("wf");
  fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
  engine.writeArtifactsDirName(instId, "task");
  const wf = engine.loadWorkflow("wf")!;
  const first = wf.steps[0];
  engine.writeState({ active: true, workflow_name: "wf", current_step: first.id, current_phase: "do", fail_count: 0, user_task: "task", paused: false, session_id: "sess-1" }, instId);
  engine.buildDoPrompt(instId, first as any, "task");
  return instId;
}

beforeEach(() => {
  __resetDrivingSessions();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-subret-"));
  const platform: Platform = {};
  engine = createEngine(tmpDir, platform) as Engine;
  const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "wf.yaml"), PARENT_WF);
  fs.writeFileSync(path.join(wfDir, "child.yaml"), CHILD_WF);
  injected = [];
  lastAssistantText = "";
  checkVerdict = "true";
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("子工作流完成回父工作流（端到端）", () => {
  it("父A → 子(sub1→sub2) → 回父 stepC → 父完成", async () => {
    const client = makeClient();
    const instId = startAtStepA();
    const step = () => engine.readState(instId);

    // 1. stepA done → check 通过 → 进入子工作流
    lastAssistantText = "done a\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = step()!;
    expect(st.workflow_name).toBe("child");
    expect(st.current_step).toBe("sub1");
    expect(engine.readStateStack(instId).length).toBe(1); // 父帧在栈上

    // 2. sub1 done → check 通过 → sub2
    lastAssistantText = "done sub1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    st = step()!;
    expect(st.workflow_name).toBe("child");
    expect(st.current_step).toBe("sub2");

    // 3. sub2 done → check 通过 → 必须回父工作流 stepC
    lastAssistantText = "done sub2\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    st = step()!;
    expect(st.workflow_name).toBe("wf");          // 回到父工作流
    expect(st.current_step).toBe("stepC");        // 父继续
    expect(st.current_phase).toBe("do");
    expect(engine.readStateStack(instId).length).toBe(0); // 栈已弹空
    expect(injected.some((m) => m.text.includes("子工作流") && m.text.includes("已完成"))).toBe(true);
    expect(injected.some((m) => m.text.includes("stepC"))).toBe(true);

    // 4. stepC done → check 通过 → 父工作流完成（实例销毁）
    lastAssistantText = "done c\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)).toBeNull(); // 完成销毁
  });

  it("父(stepA → nest(child) → stepC)：nest.on_pass 不是 done 时子完成也能回父（父步骤继续）", async () => {
    // 上面的流程已覆盖 on_pass: stepC；此条用 on_pass: done 的变体检查直接完成场景
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), PARENT_WF.replace("on_pass: stepC", "on_pass: done").replace("  - id: stepC", "  - id: stepC"));
    const client = makeClient();
    const instId = startAtStepA();

    lastAssistantText = "done a\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.workflow_name).toBe("child");

    lastAssistantText = "done sub1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.current_step).toBe("sub2");

    lastAssistantText = "done sub2\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    // 子完成 → 父 nest 的 on_pass: done → 父工作流整体完成
    expect(engine.readState(instId)).toBeNull();
  });
});

describe("嵌套边缘场景", () => {
  it("三层嵌套：A→B(child)→C(grandchild)→回 B→回 A 完成", async () => {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), `steps:
  - id: a1
    desc: a1
    do: d
    check: c
    input: i
    output: o
    on_pass: nestB
    on_fail: a1
    max_fail_count: 3
  - id: nestB
    desc: nestB
    workflow: child
    input: i
    output: o
    on_pass: done
    on_fail: nestB
    max_fail_count: 3
`);
    fs.writeFileSync(path.join(wfDir, "child.yaml"), `steps:
  - id: b1
    desc: b1
    do: d
    check: c
    input: i
    output: o
    on_pass: nestC
    on_fail: b1
    max_fail_count: 3
  - id: nestC
    desc: nestC
    workflow: grandchild
    input: i
    output: o
    on_pass: done
    on_fail: nestC
    max_fail_count: 3
`);
    fs.writeFileSync(path.join(wfDir, "grandchild.yaml"), `steps:
  - id: g1
    desc: g1
    do: d
    check: c
    input: i
    output: o
    on_pass: done
    on_fail: g1
    max_fail_count: 3
`);
    const client = makeClient();
    const instId = startAtStepA();

    lastAssistantText = "done a1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("child");
    expect(st.current_step).toBe("b1");

    lastAssistantText = "done b1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("grandchild");
    expect(st.current_step).toBe("g1");
    expect(engine.readStateStack(instId).length).toBe(2);

    lastAssistantText = "done g1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    // g1 完成 → 回 B（child 的 nestC 完成 → 回 B1 的 on_pass done → 回 A 完成）
    expect(engine.readState(instId)).toBeNull(); // 整个三层完成销毁
  });

  it("子工作流最后一步失败达上限 → 回父 on_fail 路径（父继续重试）", async () => {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), `steps:
  - id: a1
    desc: a1
    do: d
    check: c
    input: i
    output: o
    on_pass: nestB
    on_fail: a1
    max_fail_count: 5
  - id: nestB
    desc: nestB
    workflow: child
    input: i
    output: o
    on_pass: done
    on_fail: a1
    max_fail_count: 5
`);
    fs.writeFileSync(path.join(wfDir, "child.yaml"), `steps:
  - id: b1
    desc: b1
    do: d
    check: c
    input: i
    output: o
    on_pass: done
    on_fail: b1
    max_fail_count: 2
`);
    const client = makeClient();
    const instId = startAtStepA();

    // 进入子工作流
    lastAssistantText = "done a1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.workflow_name).toBe("child");

    // 子工作流 b1 失败 2 次 → 子 max 达上限 → 回父 on_fail: a1
    checkVerdict = "false";
    lastAssistantText = "done b1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.workflow_name).toBe("child");

    lastAssistantText = "done b1 again\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    const st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("wf");     // 回父
    expect(st.current_step).toBe("a1");      // 父 on_fail: a1
    expect(st.current_phase).toBe("do");
  });
});

describe("暂停/继续与子工作流组合", () => {
  it("子工作流失败达上限 → 父暂停(composite) → continue 重进子工作流 → 子完成 → 回父完成", async () => {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), `steps:
  - id: a1
    desc: a1
    do: d
    check: c
    input: i
    output: o
    on_pass: nestB
    on_fail: a1
    max_fail_count: 5
  - id: nestB
    desc: nestB
    workflow: child
    input: i
    output: o
    on_pass: done
    on_fail: nestB
    max_fail_count: 1
`);
    fs.writeFileSync(path.join(wfDir, "child.yaml"), `steps:
  - id: b1
    desc: b1
    do: d
    check: c
    input: i
    output: o
    on_pass: done
    on_fail: b1
    max_fail_count: 2
`);
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startAtStepA();

    // 进子工作流
    lastAssistantText = "done a1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.workflow_name).toBe("child");

    // 子 b1 失败 2 次 → 子超限 → 父 composite max_fail_count:1 → 父暂停
    checkVerdict = "false";
    lastAssistantText = "done b1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    lastAssistantText = "done b1 again\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = engine.readState(instId)!;
    expect(st.paused).toBe(true);
    expect(st.workflow_name).toBe("wf");       // 父工作流
    expect(st.current_step).toBe("nestB");     // composite 步骤
    expect(engine.readStateStack(instId).length).toBe(1);

    // continue → 重进子工作流
    checkVerdict = "true";
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    st = engine.readState(instId)!;
    expect(st.paused).toBe(false);
    expect(st.workflow_name).toBe("child");    // 重新进入子工作流
    expect(st.current_step).toBe("b1");

    // 子完成 → 回父 → 父完成
    lastAssistantText = "done b1 fixed\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)).toBeNull(); // 整体完成
  });

  it("子工作流内 check_error 暂停 → continue → 空闲补跑（子步骤不丢）→ 子完成回父", async () => {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), `steps:
  - id: a1
    desc: a1
    do: d
    check: c
    input: i
    output: o
    on_pass: nestB
    on_fail: a1
    max_fail_count: 5
  - id: nestB
    desc: nestB
    workflow: child
    input: i
    output: o
    on_pass: done
    on_fail: nestB
    max_fail_count: 3
`);
    fs.writeFileSync(path.join(wfDir, "child.yaml"), `steps:
  - id: b1
    desc: b1
    do: d
    check: c
    input: i
    output: o
    on_pass: done
    on_fail: b1
    max_fail_count: 3
`);
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startAtStepA();

    lastAssistantText = "done a1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.workflow_name).toBe("child");

    // 检查 infra → check_error 暂停（子工作流内）
    // mock 无法直接返回 infra，改用崩溃路径：直接模拟状态
    engine.writeState({ ...engine.readState(instId)!, paused: true, pause_reason: "check_error", last_failure_reason: "验证未能运行", current_phase: "check" }, instId);
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    const st1 = engine.readState(instId)!;
    expect(st1.paused).toBe(false);

    // 空闲 → Case 1（check 阶段 + done 标签 + 无验证者）→ 补跑子工作流检查
    checkVerdict = "true";
    lastAssistantText = "done b1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    // 补跑通过 → 子工作流完成 → 回父 → 父完成
    expect(engine.readState(instId)).toBeNull();
  });
});

describe("嵌套 + manual / reset 门组合", () => {
  it("子工作流完成回父，父下一步是 manual 步骤 → 审查门正常布防 → continue → check → 完成", async () => {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), `manual_step: [stepC]
steps:
  - id: a1
    desc: a1
    do: d
    check: c
    input: i
    output: o
    on_pass: nestB
    on_fail: a1
    max_fail_count: 3
  - id: nestB
    desc: nestB
    workflow: child
    input: i
    output: o
    on_pass: stepC
    on_fail: nestB
    max_fail_count: 3
  - id: stepC
    desc: stepC manual
    do: d
    check: c
    input: i
    output: o
    on_pass: done
    on_fail: stepC
    max_fail_count: 3
`);
    fs.writeFileSync(path.join(wfDir, "child.yaml"), `steps:
  - id: b1
    desc: b1
    do: d
    check: c
    input: i
    output: o
    on_pass: done
    on_fail: b1
    max_fail_count: 3
`);
    const client = makeClient();
    const tools = createTools(engine, client);
    const instId = startAtStepA();

    lastAssistantText = "done a1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)!.workflow_name).toBe("child");

    lastAssistantText = "done b1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    // 回父 → stepC 是 manual → 模型 done → 审查门布防
    let st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("wf");
    expect(st.current_step).toBe("stepC");

    lastAssistantText = "done c\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    // 审查门布防（不是直接检查）
    expect(injected.some((m) => m.text.includes("轮到你审查"))).toBe(true);
    expect(engine.readState(instId)!.current_phase).toBe("do");

    // 用户 continue → check → 通过 → 完成
    await tools.ralphflow_continue.execute({}, { sessionID: "sess-1" } as any);
    await handleSessionIdle(client, engine, "sess-1");
    expect(engine.readState(instId)).toBeNull(); // 完成
  });
});

describe("嵌套 + reset 门（换新会话）组合", () => {
  it("composite 标 reset: true：进入子工作流换新会话 → 新会话完成子工作流 → 回父继续", async () => {
    const wfDir = path.join(tmpDir, ".opencode", "ralph-flow", "workflows");
    fs.writeFileSync(path.join(wfDir, "wf.yaml"), `steps:
  - id: a1
    desc: a1
    do: d
    check: c
    input: i
    output: o
    on_pass: nestB
    on_fail: a1
    max_fail_count: 3
  - id: nestB
    desc: nestB
    workflow: child
    reset: true
    input: i
    output: o
    on_pass: stepC
    on_fail: nestB
    max_fail_count: 3
  - id: stepC
    desc: stepC
    do: d
    check: c
    input: i
    output: o
    on_pass: done
    on_fail: stepC
    max_fail_count: 3
`);
    fs.writeFileSync(path.join(wfDir, "child.yaml"), `steps:
  - id: b1
    desc: b1
    do: d
    check: c
    input: i
    output: o
    on_pass: done
    on_fail: b1
    max_fail_count: 3
`);
    // 支持 session.create 返回新会话
    const record = (args: any) => {
      injected.push({ sessionId: args.path.id, text: args.body.parts[0].text, noReply: !!args.body.noReply });
      return { data: {} };
    };
    let newSid = "";
    const client: any = {
      session: {
        messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: lastAssistantText }] }] }),
        create: async (args: any) => {
          if (String(args.body?.title || "").startsWith("🔄")) {
            newSid = "new-" + Math.random().toString(36).slice(2, 8);
            return { data: { id: newSid } };
          }
          return { data: { id: "chk-" + Math.random().toString(36).slice(2) } };
        },
        delete: async () => ({}),
        abort: async () => ({}),
        promptAsync: async (args: any) => record(args),
        prompt: async (args: any) => {
          if (String(args.path.id).startsWith("chk-")) {
            return { data: { parts: [{ type: "text", text: `ok\n<promise-check>${checkVerdict}</promise-check>` }] } };
          }
          return record(args);
        },
      },
      tui: { publish: async () => ({}), showToast: async () => ({}) },
      app: { agents: async () => ({ data: [] }) },
    };
    const instId = startAtStepA();

    // a1 通过 → 进入子工作流（nestB reset → 换新会话）
    lastAssistantText = "done a1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, "sess-1");
    let st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("child");
    expect(st.current_step).toBe("b1");
    expect(st.session_id).not.toBe("sess-1"); // 换会话了
    expect(newSid).not.toBe("");
    expect(engine.readStateStack(instId).length).toBe(1); // 栈帧还在（composite）

    // 新会话完成子工作流 → 回父
    lastAssistantText = "done b1\n<promise>done</promise>";
    await handleSessionIdle(client, engine, newSid);
    st = engine.readState(instId)!;
    expect(st.workflow_name).toBe("wf");
    expect(st.current_step).toBe("stepC");
    expect(st.session_id).toBe(newSid);   // 回归：回父不得覆盖 reset 换的新会话所有权
    expect(engine.readStateStack(instId).length).toBe(0);

    // 父完成
    lastAssistantText = "done c\n<promise>done</promise>";
    await handleSessionIdle(client, engine, newSid);
    expect(engine.readState(instId)).toBeNull();
  });
});
