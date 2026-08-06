/**
 * Ralph Flow Driver — opencode's session.idle handler.
 *
 * This is opencode-native (not a mirror of the Claude Stop hook). Because the
 * check runs while the session is IDLE (the model already finished emitting the
 * done tag), the driver can freely inject visible messages around it — the
 * transparent, automatic UX of the original opencode plugin:
 *
 *   done detected → transition to check → inject a visible "CHECK phase +
 *   criteria" message → run the independent verifier → inject a visible
 *   "check result + reason" message → advance / retry / pause.
 *
 * The model does NOT call a tool for normal steps; ralphflow_continue is only
 * for manual-review approval, resume, and cross-session attach.
 *
 * Driving the model uses promptAsync (non-blocking); user-facing notes use
 * prompt+noReply.
 */

import fs from "fs";
import path from "path";
import type { Engine, WorkflowDef, NormalStepDef, RalphFlowState } from "./engine.js";
import { isSubWorkflowStep, MANUAL_GATE_MARKER, DONE_TAG_MARKER, REINJECT_WARNED_MARKER, MAX_DO_REINJECT, DEFAULT_ADVERSARIAL_TIMEOUT_MS, shouldResetOnTransition } from "./engine.js";
import { adversarialCheck, readOwnerSessionModel } from "./check.js";
import { runVotingCheck } from "./check-voting.js";
import { readVotingProgress, deleteVotingProgress } from "./voting-progress.js";

type Client = any;

// Per-session in-flight guard. The driver holds NO engine lock (its state is
// read via listInstances and its writes are instId-scoped marker files), so a
// long injectPrompt/getLastAssistantMessage can never stall a tool call. This
// set just prevents two overlapping idle drives of the SAME session from racing
// on that session's markers.
const drivingSessions = new Set<string>();

// Catch-up drives scheduled when the post-delivery grace window swallows an
// idle that may have been the session's ONLY one (see the debounce below).
// Held so tests can cancel them between cases; unref'd so they never keep a
// process (or a test runner) alive for the grace window.
const pendingRetries = new Set<ReturnType<typeof setTimeout>>();

/** Test-only: clear the in-flight guard and pending catch-up drives between cases. */
export function __resetDrivingSessions(): void {
  drivingSessions.clear();
  for (const t of pendingRetries) clearTimeout(t);
  pendingRetries.clear();
}

// ─── Helpers (mirror of the hook's file utils) ───────────────────────────────

function readTextFile(filePath: string): string {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  } catch {
    return "";
  }
}

function writeFileSafe(filePath: string, content: string): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
  } catch {}
}

function removeFile(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch {}
}

function fileExists(filePath: string): boolean {
  try { fs.accessSync(filePath); return true; } catch { return false; }
}

// ─── Prompt injection (replaces hook JSON output) ────────────────────────────

// The driver drives the model by posting a message. It MUST use promptAsync
// ("start if needed and return immediately"), NOT prompt (which blocks until
// the whole model turn completes). If it blocked, the drive would hold the
// per-session in-flight guard across the entire turn, and the session.idle
// fired when that turn finishes — the one carrying the model's new output, e.g.
// a done tag — would be dropped as "already driving", stalling the workflow.
export async function injectPrompt(
  client: Client,
  sessionId: string,
  prompt: string,
  noReply = false,
  model?: { providerID: string; modelID: string }
): Promise<boolean> {
  try {
    const body: any = { parts: [{ type: "text", text: prompt }], noReply };
    if (model) body.model = model;
    if (client.session.promptAsync) {
      await client.session.promptAsync({ path: { id: sessionId }, body });
    } else {
      // Older SDKs: fire prompt without awaiting the model turn.
      void client.session.prompt({ path: { id: sessionId }, body }).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Context Reset (Reset Gate) ───────────────────────────────────────────────

/**
 * 交接简报头：加在新会话第一条注入（transitionText）之前。
 *
 * 新会话是冷启动——它不知道工作流的存在，更不知道为什么第一条消息就是
 * "检查结果：通过"。transitionText 的口吻是写给经历过全程的旧会话模型的，
 * 直接注入会让新模型困惑（"我是不是漏看了上下文？"），甚至怀疑自己该重做
 * 已完成的工作。简报给它三样东西：你为什么在这里（reset 门接手）、进度
 * 全景（步骤列表 + 当前位置 + 已完成标记）、现场在哪（artifacts 目录）。
 * 保持紧凑：详细任务内容在后面的 DO 提示里，不重复。
 */
function buildResetBriefing(engine: Engine, instId: string, workflowName: string, targetStepId: string): string {
  const lines: string[] = [
    `## 🔀 会话交接说明`,
    ``,
    `这是一个**上下文重置后的新工作会话**：上一个会话已由工作流的「重置门」替换，你从它接手。你没有漏看任何消息——所需背景都在下面，之前步骤的产出都已落盘。`,
    ``,
    `- **工作流**：\`${workflowName}\``,
  ];

  const wf = engine.loadWorkflow(workflowName);
  if (wf && wf.steps.length > 0) {
    const idx = wf.steps.findIndex((s) => s.id === targetStepId);
    if (idx >= 0) {
      const passed = new Set(
        engine.loadStepRecords(instId)
          .filter((r) => r.phase === "check" && r.status === "passed")
          .map((r) => r.stepId)
      );
      const overview = wf.steps
        .map((s, i) => (i === idx ? `**${s.id} 👈**` : passed.has(s.id) ? `${s.id} ✓` : s.id))
        .join(" · ");
      lines.push(`- **进度**：第 ${idx + 1}/${wf.steps.length} 步（${overview}）`);
    }
  }

  lines.push(
    `- **工作现场**：文档产出统一放在 \`${engine.getArtifactsRelDir(instId)}/\`；之前步骤的产出已在项目和该目录中，直接读取使用，**不要重做**`,
    `- **交互约定**：完成当前步骤后，在回复最后一行单独输出 \`<promise>done</promise>\`，之后会有独立验证会话自动检查`,
  );
  return lines.join("\n");
}

/**
 * 重置门执行：创建新会话、转移 owner、停掉旧会话回合、旧会话告别、
 * 新会话注入交接简报 + DO 提示。
 * 返回 true 表示已走重置路径（调用方不再向旧会话注入 transitionText）。
 *
 * opts.kind：reset（默认，🔄 标题 + "上下文已重置"告别）与 rewind（🔙 标题
 * + "已回退"告别）共用同一条换会话路径——用户执行的是哪个命令，旧会话
 * 看到的告别就该说哪个，避免"我明明回退，它却说重置"的心智错位。
 */
export async function executeContextReset(
  client: Client,
  engine: Engine,
  instId: string,
  oldSessionId: string,
  transitionText: string,
  workflowName: string,
  targetStepId: string,
  opts?: { kind?: "reset" | "rewind" },
): Promise<boolean> {
  try {
    const model = await readOwnerSessionModel(client, oldSessionId);

    const kind = opts?.kind ?? "reset";
    const title = `${kind === "rewind" ? "🔙" : "🔄"} ${workflowName} · ${targetStepId}`;
    const newSession = await client.session.create({
      // Deliberately NO parentID: a child session is filtered out of every
      // session list in the TUI (dialog-session-list and the home session index
      // both drop any session with a parentID), so a reset child session ran
      // the workflow in a place the user could never find or open — the exact
      // "reset said it happened but nothing did" bug. The reset session is the
      // workflow's new long-term home, not a throwaway subagent session, so it
      // must be a top-level session. (check.ts keeps parentID because its
      // verifier sessions ARE throwaway and are deleted right after.)
      body: { title },
      // Pin the project: with multiple projects open in one TUI, an unqualified
      // create can land the session under the wrong project (check.ts does the same).
      query: { directory: engine.projectDir },
    });
    const newSessionId = (newSession as { data?: { id?: string } } | null)?.data?.id;
    if (!newSessionId) {
      engine.logEvent(instId, "error", "context_reset_session_create_failed", { workflow: workflowName, step: targetStepId });
      return false;
    }

    engine.claimOwnership(instId, newSessionId);

    // Stop the old session's in-flight turn. Ownership moved above, so the old
    // session would no longer be DRIVEN on idle — but a turn already running
    // keeps going to completion, and meanwhile the new session starts redoing
    // the same step: two sessions editing one workspace concurrently. This is
    // not hypothetical for /ralphflow-reset, whose very tool call runs INSIDE
    // the old session's active turn.
    //
    // ORDER MATTERS: abort fires session.error (MessageAbortedError) →
    // handleSessionGone pauses the instance owned by that session. Because
    // claimOwnership already moved ownership to the new session, the old
    // session's abort matches no instance and is harmless. Aborting BEFORE
    // the ownership move would pause the very instance we are resetting.
    // A no-op when the old session is idle (auto-gate path); failures are
    // swallowed — a finished turn needs no abort and the reset must not fail
    // over it.
    try { await client.session?.abort?.({ path: { id: oldSessionId } }); } catch {}

    // Drive the model in the new session FIRST, so when the TUI navigates below
    // there is already work on screen — not an empty session.
    const briefing = buildResetBriefing(engine, instId, workflowName, targetStepId);
    const delivered = await injectPrompt(client, newSessionId, `${briefing}\n\n---\n\n${transitionText}`, false, model);
    if (!delivered) {
      // Ownership already moved: the new session will still be driven by its
      // own idle handler (cached DO prompt), so the workflow is not lost — but
      // log it, because a silent failure here reads as "nothing happened".
      engine.logEvent(instId, "warn", "context_reset_first_inject_failed", { to: newSessionId.slice(0, 8), step: targetStepId });
    }

    const farewell = kind === "rewind"
      ? `## 🔙 已回退到步骤 \`${targetStepId}\` 重做\n\n工作流 \`${workflowName}\` 已回退到步骤 \`${targetStepId}\`，并在新会话 **${title}** 中重做该步及后续（正在自动跳转过去；若未跳转，用 \`/session\` 打开 🔙 开头的会话即可）。本会话正在进行的生成已停止；新会话已带完整交接简报与回退原因，无需你重复背景。\n\n本会话的历史仍保留，你可以随时切回来查看；但工作流已不在本会话中执行。`
      : `## 🔄 上下文已重置\n\n工作流 \`${workflowName}\` 已在新会话 **${title}** 中继续（正在自动跳转过去；若未跳转，用 \`/session\` 打开 🔄 开头的会话即可）。本会话正在进行的生成已停止；新会话已带完整交接简报，无需你重复背景。\n\n本会话的历史仍保留，你可以随时切回来查看；但工作流已不在本会话中执行。`;
    await injectPrompt(client, oldSessionId, farewell, true);

    // Ask the TUI to follow the workflow into its new home. The v1 SDK client
    // predates the /tui/select-session endpoint, but the server's publish
    // handler already routes tui.session.select (and the TUI navigates on it);
    // older servers reject or ignore the unknown event type, which is fine —
    // the top-level session stays findable via /session either way.
    try {
      await client.tui?.publish?.({
        body: { type: "tui.session.select", properties: { sessionID: newSessionId } },
        query: { directory: engine.projectDir },
      });
    } catch {}

    engine.logEvent(instId, "info", "context_reset", { from: oldSessionId.slice(0, 8), to: newSessionId.slice(0, 8), step: targetStepId });

    // hey-api v1 wraps the request payload in `body` — a bare {variant, message}
    // sends an empty payload, the server 400s, and the toast never shows.
    try { await client.tui?.showToast?.({ body: { variant: "info", message: "工作流已在干净上下文中继续" } }); } catch {}

    return true;
  } catch (e: any) {
    engine.logEvent(instId, "error", "context_reset_failed", { error: e.message });
    return false;
  }
}

// ─── Check orchestration (idle-driven & tool-driven share this) ──────────────

/**
 * Run the independent check for a step whose DO just completed, injecting the
 * visible CHECK-phase and result messages, then advance / retry / pause the
 * workflow. The session is IDLE while this runs (the model finished emitting
 * done), so the visible injections are safe.
 *
 * Preconditions: `state` is the instance's current state in "do" phase, its
 * done reached (normal auto-flow or a user-approved manual gate). This function
 * transitions to check, runs, and applies the result.
 */
export async function runCheckAndAdvance(
  client: Client,
  engine: Engine,
  sessionId: string,
  instId: string,
  workflow: WorkflowDef,
  step: NormalStepDef,
  state: RalphFlowState
): Promise<void> {
  // Record DO completion and transition to check. The DO-completion records are
  // written only on the real do→check edge; this function is also re-entered
  // with the state already in "check" (infra-error retry after continue, or the
  // crashed-check anomaly path), where re-recording would double the report rows.
  if (state.current_phase === "do") {
    engine.logEvent(instId, "info", "done_detected", { step: state.current_step });
    engine.addStepRecord(instId, state.current_step, "do", "passed", state.fail_count || 0, undefined, state.workflow_name);
  }
  engine.clearManualStepMarker(instId);
  engine.clearManualGate(instId);
  engine.clearReinjectCounter(instId);
  engine.clearDoPromptCache(instId);
  engine.clearDoneTagDetected(instId);
  engine.writeState({ ...state, current_phase: "check" }, instId);
  engine.recordStepStart(instId, state.current_step, "check");
  engine.logEvent(instId, "info", "step_start", { step: state.current_step, phase: "check" });

  const isVoting = Array.isArray(step.check_voting) && step.check_voting.length > 0;
  const checkPrompt = isVoting ? "" : engine.buildCheckPrompt(instId, step, state.user_task);

  // Visible: the full context the independent verifier sees — user task, what the
  // DO phase was supposed to produce, and the check criteria. The original v1
  // plugin injected the complete buildCheckPrompt; the user should see everything
  // the verifier judges against, not just the check criteria in isolation.
  //
  // PLAIN TEXT: opencode renders user-role messages with HighlightedText (no
  // markdown), so every noReply injection here must avoid markdown syntax —
  // emoji + indentation instead of tables/headings/bold.
  const visibleSections: string[] = [];
  if (state.user_task) {
    visibleSections.push(`[用户需求]\n${state.user_task}`);
  }
  visibleSections.push(`[Do 阶段任务]\n任务描述:${engine.renderStepText(instId, step.do)}\n输入:${engine.renderStepText(instId, step.input)}\n预期输出:${engine.renderStepText(instId, step.output)}`);
  if (isVoting && step.check_voting) {
    const n = step.check_voting.length;
    const rows = step.check_voting
      .map((e, i) => `  ${i + 1}/${n} ${engine.renderStepText(instId, e.check).split("\n")[0].trim().substring(0, 50)} · 模型:${typeof e.model === "string" ? e.model : e.model ? `${e.model.providerID}/${e.model.modelID}` : "默认"}`)
      .join("\n");
    visibleSections.push(`[各验证者检查依据]\n${rows}`);
  } else {
    visibleSections.push(`[检查依据]\n${engine.renderStepText(instId, (step as any).check || "")}`);
  }
  // Report the CONFIGURED timeout ceiling, not a made-up "~1 minute". The
  // verifier independently explores the project and runs the check commands
  // (builds/tests can take minutes); its only hard bound is this timeout.
  // Field-level inheritance: a sub-workflow step checks with the nearest
  // ancestor's value for every field it doesn't validly define itself.
  const adversarialConfig = engine.getEffectiveAdversarialCheck(instId, workflow);
  const timeoutMin = Math.max(1, Math.round((adversarialConfig?.timeout_ms || DEFAULT_ADVERSARIAL_TIMEOUT_MS) / 60000));
  await injectPrompt(client, sessionId,
    isVoting
      ? `🔍 CHECK 阶段:多验证者并行验证中\n\n正在用 ${step.check_voting!.length} 个独立验证会话并行验证步骤 ${step.id}(各自与本对话隔离,最长 ${timeoutMin} 分钟)。\n\n⏳ 现在无需你操作,请等待结果。验证者互不共享记忆,全过才放行。\n迟迟没有结果时:/ralphflow-status 看进度,或 /ralphflow-cancel 取消。\n\n以下是验证者正在核对的依据(供你了解,不用回复):\n\n${visibleSections.join("\n\n")}`
      : `🔍 CHECK 阶段:自动验证中\n\n正在用独立验证会话验证步骤 ${step.id}(与本对话隔离运行,最长 ${timeoutMin} 分钟)。\n\n⏳ 现在无需你操作,请等待结果。这一步由独立会话完成,在这里发消息不会加快它、也不影响判定。\n迟迟没有结果时:/ralphflow-status 看进度,或 /ralphflow-cancel 取消。\n\n以下是它正在核对的依据(供你了解,不用回复):\n\n${visibleSections.join("\n\n")}`,
    true);

  let checkResult;
  try {
    if (isVoting && step.check_voting) {
      // 进度文件生命周期(设计 §5.3):phase="do" 跨轮 → 删;phase="check" 续跑/全投
      if (state.current_phase === "do") {
        deleteVotingProgress(engine, instId);
      }
      const progress = readVotingProgress(engine, instId);
      const outcome = await runVotingCheck(client, engine, instId, sessionId, step, state.user_task, step.check_voting, adversarialConfig, {
        phase: state.current_phase,
        workflowName: state.workflow_name,
        progress,
        // 投票进度推送(设计:长耗时验证不让用户误以为卡死):每票完成注入一行 noreply
        onVoteProgress: (msg) => { void injectPrompt(client, sessionId, `🔍 ${msg}`, true); },
      });
      if (outcome.kind === "cancelled") {
        engine.logEvent(instId, "warn", "voting_cancelled", { step: step.id });
        return;
      }
      if (outcome.kind === "infra_pause") {
        checkResult = { passed: false, infra: true, reason: outcome.reason };
      } else {
        checkResult = { passed: outcome.kind === "passed", reason: outcome.reason };
      }
    } else {
      // 单 check 场景:步骤级 check_model 覆盖全局(设计 §7 优先级链第 2 级)
      const singleCheckConfig = step.check_model
        ? { ...(adversarialConfig || {}), model: step.check_model }
        : adversarialConfig;
      checkResult = await adversarialCheck(client, engine, instId, sessionId, step, checkPrompt, state.user_task, singleCheckConfig);
    }
  } catch (err: any) {
    engine.logEvent(instId, "error", "adversarial_check_uncaught", { stepId: step.id, error: err.message });
    const st = engine.readState(instId);
    if (st && st.active && st.current_phase === "check" && st.current_step === state.current_step && st.workflow_name === state.workflow_name) {
      engine.writeState({ ...st, paused: true, pause_reason: "check_error", last_failure_reason: `对抗性检查崩溃：${err.message}` }, instId);
    }
    await injectPrompt(client, sessionId, `⚠️ 验证未能运行 · 🙋 轮到你了\n\n对抗性检查崩溃:${err.message}\n\n这是验证程序自身的问题,不是你工作成果的问题——本次不计入失败次数,已完成的工作保持原样。\n\n👉 处理后运行 /ralphflow-continue 即可重新验证(无需重做任务),或 /ralphflow-cancel 放弃。`, true);
    return;
  }

  // Re-check state: a cancel, a concurrent continue, or a session-gone pause
  // (owner session aborted/deleted while the ~1-min check ran) may have moved
  // on. If paused, DISCARD the verdict — applying it would clear the pause and
  // inject the next DO prompt into a now-dead session, orphaning the instance.
  // Keeping it paused lets a new session attach cleanly via ralphflow_continue.
  const cur = engine.readState(instId);
  if (!cur || !cur.active || cur.paused || cur.current_phase !== "check"
      || cur.workflow_name !== state.workflow_name || cur.current_step !== state.current_step) {
    engine.logEvent(instId, "warn", "check_result_discarded", { reason: cur?.paused ? "instance paused during check" : "state changed during check" });
    return;
  }

  // Infra failure: verifier produced no verdict — pause in check, no fail burn.
  if (checkResult.infra) {
    engine.writeState({ ...cur, paused: true, pause_reason: "check_error", last_failure_reason: checkResult.reason }, instId);
    engine.logEvent(instId, "warn", "workflow_paused", { workflow: cur.workflow_name, step: cur.current_step, reason: "check_infra_error" });
    await injectPrompt(client, sessionId,
      isVoting
        ? `⚠️ 部分验证未能运行 · 🙋 轮到你了\n\n${checkResult.reason}\n\n这是验证进程自身的问题(额度/API/超时),不是你工作成果的问题:本次不计入失败次数,已完成的工作无需重做。已通过的验证者结果保留,不会重跑。\n\n👉 问题解决后运行 /ralphflow-continue 只重新验证失败的验证者,或 /ralphflow-cancel 放弃。`
        : `⚠️ 验证未能运行 · 🙋 轮到你了\n\n${checkResult.reason}\n\n这是验证进程自身的问题(额度/API/超时),不是你工作成果的问题:本次不计入失败次数,已完成的工作无需重做。\n\n👉 问题解决后运行 /ralphflow-continue 直接重新验证,或 /ralphflow-cancel 放弃。`,
      true);
    return;
  }

  engine.addStepRecord(instId, cur.current_step, "check", checkResult.passed ? "passed" : "failed", cur.fail_count || 0, checkResult.reason, cur.workflow_name);
  const result = checkResult.passed
    ? engine.handleCheckPassed(instId, cur, workflow, step, checkResult)
    : engine.handleCheckFailed(instId, cur, workflow, step, checkResult);

  // Set up the next DO phase markers before injecting the transition text
  // (handleCheckPassed/Failed already updated the state and cached the DO prompt).
  if (!result.completed && !result.paused) {
    const next = engine.readState(instId);
    if (next && next.active && next.current_phase === "do") {
      engine.clearDoneTagDetected(instId);
      engine.clearManualGate(instId);
      const nextWf = next.workflow_name === workflow.name ? workflow : engine.loadWorkflow(next.workflow_name);
      if (nextWf?.manual_step?.includes(next.current_step)) engine.writeManualStepMarker(instId);
      engine.markPromptDelivered(next.current_step, instId);
    }
  }

  // Use the engine's transition text directly — same approach as the Claude Code
  // version (which returns result.text as the tool response). This gives the user
  // the full context: check verdict + reason + transition (sub-workflow completion
  // notices, next-step info, DO prompt) in one coherent message. Completions and
  // pauses are noReply (workflow stopped); advances must drive the model.
  //
  // Reset Gate: if this is a cross-step transition to a step marked reset (or
  // workflow auto_reset), spawn a fresh session instead of injecting into the
  // old bloated one.
  if (!result.completed && !result.paused) {
    const freshState = engine.readState(instId);
    if (freshState && freshState.active) {
      let resetHit = false;
      if (result.enteredCompositeStepId) {
        // Sub-workflow entry: the state already advanced to the CHILD's first
        // step, so a (source → current) check can never see the marks — they
        // live on the composite step (or its parent workflow). Judge them
        // there. The composite's parent workflow is the top stack frame.
        // (Nested workflows are where big tasks live, so this gate matters
        // most exactly here. Sub-workflow COMPLETION back to a plain parent
        // step needs no such handling — the regular branch below finds it.)
        const stack = engine.readStateStack(instId);
        const top = stack.length > 0 ? stack[stack.length - 1] : null;
        const parentWf = top ? engine.loadWorkflow(top.workflow_name) : null;
        if (parentWf) {
          resetHit = parentWf.auto_reset === true
            || engine.getStep(parentWf, result.enteredCompositeStepId)?.reset === true;
        }
      } else {
        // Regular transition (same workflow, or sub-workflow completion routing
        // back into a plain parent step). Same-step retry (on_fail back to
        // self) lands here too — reset-marked steps reset on retry as well.
        const effectiveWf = freshState.workflow_name === workflow.name ? workflow : engine.loadWorkflow(freshState.workflow_name);
        resetHit = !!effectiveWf && shouldResetOnTransition(effectiveWf, state.current_step, freshState.current_step);
      }
      if (resetHit) {
        await executeContextReset(client, engine, instId, sessionId, result.text, freshState.workflow_name, freshState.current_step);
        return;
      }
    }
  }
  await injectPrompt(client, sessionId, result.text, result.completed || result.paused);
}

// ─── Extract last assistant message (mirror of the hook's transcript read) ───

export async function getLastAssistantMessage(
  client: Client,
  sessionId: string
): Promise<{ text: string; hasToolUse: boolean }> {
  try {
    const response = await client.session.messages({ path: { id: sessionId } });
    const messages = (response as { data?: Array<{ info?: { role?: string }; parts?: Array<{ type: string; text?: string }> }> }).data ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info?.role !== "assistant") continue;
      const parts = msg.parts || [];
      const hasToolUse = parts.some((p) => p.type === "tool");
      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
      return { text, hasToolUse };
    }
  } catch {}
  return { text: "", hasToolUse: false };
}

// ─── Done-tag detection ──────────────────────────────────────────────────────

// Strip markdown code blocks and inline code before checking for done tag.
// This prevents false positives when the model outputs the tag inside code
// fences (e.g., when explaining, debugging, or modifying ralph-flow internals).
export function stripCodeBlocks(text: string): string {
  // Remove fenced code blocks (```...```). Indented lines are deliberately NOT
  // stripped: models emit code as fences, and stripping every 4-space-indented
  // line would silently delete legitimate content (including a done tag the
  // model happened to indent).
  let result = text.replace(/```[\s\S]*?```/g, "");
  // Remove inline code (`...`)
  result = result.replace(/`[^`\n]+`/g, "");
  return result;
}

const DONE_TAG_REGEX = /<promise>\s*done\s*<\/promise>/i;

export function detectDoneTag(lastOutput: string): boolean {
  const textOutsideCode = stripCodeBlocks(lastOutput);
  // Check last line, or within last 100 chars
  const lines = textOutsideCode.trim().split("\n");
  const lastLine = lines[lines.length - 1].trim();
  if (DONE_TAG_REGEX.test(lastLine)) return true;
  const lastPart = textOutsideCode.trim().substring(Math.max(0, textOutsideCode.trim().length - 100));
  return DONE_TAG_REGEX.test(lastPart);
}

// ─── The idle handler (mirror of the Stop hook main flow) ────────────────────

export async function handleSessionIdle(
  client: Client,
  engine: Engine,
  sessionId: string
): Promise<void> {
  if (drivingSessions.has(sessionId)) return; // a drive is already in flight for this session
  drivingSessions.add(sessionId);
  try {
    const instances = engine.listInstances();
    if (instances.length === 0) return;

    // Drive only the instance THIS session owns. Never auto-claim another
    // session's instance from an idle — that session (or the verifier session,
    // which also idles in this project) would be silenced. A new session takes
    // over an interrupted instance explicitly via /ralphflow-continue.
    const owned = instances.filter((i) => i.owner === sessionId);
    owned.sort((a, b) => (b.lastActivity?.getTime() || 0) - (a.lastActivity?.getTime() || 0));
    const mine = owned[0] || null;
    if (!mine) return;

    // ── Instance-scoped paths ────────────────────────────────────────────────
    const instDir = engine.getInstanceDir(mine.id);
    const phaseReportFile = path.join(instDir, ".last-phase-report");
    const reinjectFile = path.join(instDir, ".do-reinject-count");
    const reinjectWarnedFile = path.join(instDir, REINJECT_WARNED_MARKER);
    const manualStepMarker = path.join(instDir, ".manual-step-active");
    const manualGateMarker = path.join(instDir, MANUAL_GATE_MARKER);
    const doneTagDetectedFile = path.join(instDir, DONE_TAG_MARKER);
    const postToolMarker = path.join(instDir, ".post-tool-active");

    const state = mine.state;

    if (state.paused === true) {
      removeFile(phaseReportFile);
      return;
    }

    const statePhase = state.current_phase || "";
    const stateStep = state.current_step || "";
    const stateWorkflow = state.workflow_name || "";
    const stateFailCount = state.fail_count || 0;

    // Sub-workflow steps advance through the engine, never through idle nudges.
    const workflow: WorkflowDef | null = engine.loadWorkflow(stateWorkflow);
    if (!workflow) {
      // Workflow deleted after instance creation — pause to avoid silent stall.
      engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: `工作流 "${stateWorkflow}" 未找到。` }, mine.id);
      return;
    }
    const currentStep = workflow ? engine.getStep(workflow, stateStep) : null;
    if (currentStep && isSubWorkflowStep(currentStep)) return;
    // Step removed from YAML after instance creation — pause, don't silently deadlock.
    if (!currentStep) {
      engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: `步骤 "${stateStep}" 在工作流 "${stateWorkflow}" 中未找到。` }, mine.id);
      return;
    }

    const { text: lastOutput, hasToolUse } = await getLastAssistantMessage(client, sessionId);

    // Re-check paused: handleSessionGone may have paused the instance during the
    // await above (session deleted/aborted while we were fetching messages).
    const freshState = engine.readState(mine.id);
    if (!freshState || !freshState.active || freshState.paused) return;

    const hasDoneTag = lastOutput ? detectDoneTag(lastOutput) : false;

    // ── Reinjection counter helpers ──────────────────────────────────────────
    const reinjectKey = `${stateStep}:${statePhase}`;
    const getReinjectCount = (): number => {
      const content = readTextFile(reinjectFile);
      const [storedKey, storedCount] = content.split(" ");
      if (storedKey === reinjectKey) return parseInt(storedCount, 10) || 0;
      return 0;
    };
    const incrementReinjectCount = (): number => {
      const count = getReinjectCount() + 1;
      writeFileSafe(reinjectFile, `${reinjectKey} ${count}`);
      return count;
    };

    const shouldReportPhase = (): boolean => {
      const currentKey = `${statePhase}:${stateStep}`;
      const lastReported = readTextFile(phaseReportFile);
      if (currentKey !== lastReported) {
        writeFileSafe(phaseReportFile, currentKey);
        return true;
      }
      return false;
    };

    // ── Case 1: Done tag detected ────────────────────────────────────────────
    if (hasDoneTag) {
      // A done tag only means something during the DO phase.
      if (statePhase !== "do") return;

      removeFile(reinjectFile);
      writeFileSafe(doneTagDetectedFile, Date.now().toString());

      // Manual step: the review gate sits BEFORE the check. Do NOT run the
      // check — stop so the USER can review. Their /ralphflow-continue is the
      // approval that starts verification.
      if (fileExists(manualStepMarker)) {
        writeFileSafe(manualGateMarker, Date.now().toString());
        await injectPrompt(client, sessionId,
          `## 🙋 轮到你审查\n\n手动步骤 \`${stateStep}\` 已完成，**现在停下等你**——你有三个选择：\n\n- ✅ **满意** → 运行 \`/ralphflow-continue\`，进入独立验证并继续\n- ✏️ **要改** → 直接在对话里说要改什么，模型会修改，改完再次提示你审查\n- 🗑️ **放弃** → 运行 \`/ralphflow-cancel\`\n\n在你做出选择前，工作流会一直停在这里，你可以放心地跟模型来回讨论。`,
          true);
        return;
      }

      // Normal step: run the independent check automatically (idle-driven),
      // injecting the visible CHECK-phase and result messages. The model does
      // not need to call any tool.
      if (currentStep && !isSubWorkflowStep(currentStep)) {
        await runCheckAndAdvance(client, engine, sessionId, mine.id, workflow!, currentStep as NormalStepDef, state);
      }
      return;
    }

    // ── Case 2: done was reached earlier but we're still in DO ──────────────
    if (fileExists(doneTagDetectedFile) && statePhase === "do") {
      // Manual gate active: the user is reviewing. Stay silent so they can chat
      // freely; the gate is only released by their /ralphflow-continue.
      if (fileExists(manualGateMarker)) return;
      // Non-manual anomaly (e.g. a check that crashed and reset to DO): the done
      // was reached, so re-run the check rather than nagging.
      if (currentStep && !isSubWorkflowStep(currentStep)) {
        await runCheckAndAdvance(client, engine, sessionId, mine.id, workflow!, currentStep as NormalStepDef, state);
      }
      return;
    }

    // ── Manual step, DO phase, no done tag yet: human-in-the-loop, stay silent ─
    // A manual step exists so a human stays in control while the work is done.
    // If the model stops here without a done tag — e.g. it paused to ask the user
    // a clarifying question — an auto keep-alive nudge would bulldoze that very
    // exchange. Do NOT drive: let the user reply (or nudge it themselves). The
    // step still advances the moment the model emits done (→ Case 1 arms the
    // review gate); the initial DO prompt was already delivered by the tool /
    // transition that entered this step, so nothing here is starved of input.
    if (statePhase === "do" && fileExists(manualStepMarker)) {
      removeFile(postToolMarker);
      return;
    }

    const alreadyReported = !shouldReportPhase();

    // Check phase: normally silent while the verifier runs. But after a
    // check_error pause is cleared by continue, the state is unpaused "check"
    // with no active verifier — re-trigger the check here so the continue
    // tool's promise ("空闲时自动重新验证") actually works.
    if (statePhase === "check") {
      if (!state.paused && currentStep && !isSubWorkflowStep(currentStep) && !engine.readAdversarialSession(mine.id)) {
        await runCheckAndAdvance(client, engine, sessionId, mine.id, workflow!, currentStep as NormalStepDef, state);
      }
      return;
    }

    let phaseGuidance = "";

    if (statePhase === "do") {
      // Only increment reinject counter when the model stopped WITHOUT making
      // tool calls. If it made tool calls, it's actively working and not stuck.
      const reinjectCount = hasToolUse ? getReinjectCount() : incrementReinjectCount();

      // Only raise the max-reinjection alarm ONCE — and do NOT keep driving:
      // hand control to the user (the workflow state itself is NOT paused —
      // driving resumes as soon as the user or the model acts again). Repeating
      // the warning on every idle would just re-spam the exact message the user
      // already acted on; the user's next action (a message to the model, or
      // /ralphflow-continue declaring the step done) is what moves things.
      if (reinjectCount > MAX_DO_REINJECT && !hasToolUse) {
        if (!fileExists(reinjectWarnedFile)) {
          writeFileSafe(reinjectWarnedFile, Date.now().toString());
          await injectPrompt(client, sessionId,
            `## ⏸ 已暂停自动驱动 · 🙋 轮到你了\n\n步骤 \`${stateStep}\` 的 DO 阶段连续被催促 ${MAX_DO_REINJECT} 次仍未完成，为避免空转已停下等你：\n\n1. 🔍 看看卡在哪，补充信息后**直接发消息**让模型继续（模型补上 \`<promise>done</promise>\` 后自动进入验证）\n2. ✅ 若其实已经做完 → 运行 \`/ralphflow-continue\` 将其**标记为完成**并进入独立验证\n3. 🗑️ 运行 \`/ralphflow-cancel\` 取消\n\n（工作流没有真正暂停——你或模型一有动作就会自动恢复驱动。）`,
            true);
        }
        return;
      }

      if (alreadyReported) {
        // A tool response that just delivered the DO prompt sets .post-tool-active.
        // This is a DEBOUNCE, not mere dedup: session.idle can fire in the window
        // after delivery but before the model's tool calls register in its message
        // (getLastAssistantMessage would then see hasToolUse=false even though the
        // model is about to write). Nudging there interrupts the model mid-work.
        // So stay silent for a short grace period after delivery; one idle is
        // consumed, and if the model genuinely stopped, the user resumes it.
        if (fileExists(postToolMarker)) {
          const markerTime = parseInt(readTextFile(postToolMarker), 10);
          const age = Date.now() - (markerTime || 0);
          removeFile(postToolMarker);
          if (age < 10000) {
            // The swallowed idle may be the session's ONLY one: a model that
            // finished within the window has stopped emitting, so no further
            // idle will fire — and if its done tag simply hadn't registered in
            // the message list when we read it (the race the debounce guards),
            // the workflow deadlocks here until the user notices. Schedule ONE
            // catch-up drive for when the window closes; by then the done tag
            // has registered (→ Case 1 advances), or tool calls show active
            // work (→ stay silent), or the model genuinely stopped (→ the
            // keep-alive nudge below finally fires). The marker is already
            // consumed, so the retry takes the normal path.
            const retry = setTimeout(() => {
              pendingRetries.delete(retry);
              handleSessionIdle(client, engine, sessionId).catch(() => {});
            }, 10000 - age);
            retry.unref();
            pendingRetries.add(retry);
            return;
          }
        }

        // Already reported full phase info — send keep-alive with DO prompt to
        // keep the session working when the workflow expects more.
        await injectPrompt(client, sessionId, engine.buildDoNudge(mine.id, stateStep));
        return;
      }

      // First report of this phase: the header below already names the workflow,
      // instance, step and phase, so the body is the same nudge as any other.
      phaseGuidance = engine.buildDoNudge(mine.id, stateStep);
    }

    let stepInfo = "";
    if (stateStep) {
      stepInfo = `Step: \`${stateStep}\``;
      if (stateFailCount > 0) stepInfo += ` (failed ${stateFailCount}x)`;
    }

    await injectPrompt(client, sessionId,
      `## 🔨 Ralph Flow: ${statePhase.toUpperCase()} 阶段\n\n**工作流**: ${stateWorkflow}\n**实例**: \`${mine.id}\`\n${stepInfo}\n\n${phaseGuidance}`);
  } finally {
    drivingSessions.delete(sessionId);
  }
}

// ─── Session lifecycle events (opencode-specific; no Claude hook equivalent) ─

/** session.error (aborted) / session.deleted → pause the instance owned by that session. */
export async function handleSessionGone(
  engine: Engine,
  sessionId: string,
  reason: "aborted" | "deleted"
): Promise<void> {
  const instances = engine.listInstances();
  const mine = instances.find((i) => i.owner === sessionId);
  if (!mine || mine.state.paused) return;
  // Aborted mid-run: pausing keeps the driver quiet until the user resumes.
  engine.writeState({ ...mine.state, paused: true, pause_reason: `session_${reason}` }, mine.id);
  engine.logEvent(mine.id, "warn", `session_${reason}`, { instance: mine.id, step: mine.state.current_step, phase: mine.state.current_phase });
}
