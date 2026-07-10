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
import { isSubWorkflowStep, MANUAL_GATE_MARKER, DONE_TAG_MARKER } from "./engine.js";
import { adversarialCheck } from "./check.js";

type Client = any;

const MAX_DO_REINJECT = 5;

// Per-session in-flight guard. The driver holds NO engine lock (its state is
// read via listInstances and its writes are instId-scoped marker files), so a
// long injectPrompt/getLastAssistantMessage can never stall a tool call. This
// set just prevents two overlapping idle drives of the SAME session from racing
// on that session's markers.
const drivingSessions = new Set<string>();

/** Test-only: clear the in-flight guard between cases. */
export function __resetDrivingSessions(): void {
  drivingSessions.clear();
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
  noReply = false
): Promise<boolean> {
  try {
    const body = { parts: [{ type: "text", text: prompt }], noReply };
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

// ─── Check orchestration (idle-driven & tool-driven share this) ──────────────

const PAUSE_REASON_CN: Record<string, string> = {
  max_failures: "已达最大失败次数",
  config_error: "工作流配置错误",
  check_error: "验证进程未能运行（额度/API/超时）",
};

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
  // Record DO completion and transition to check.
  engine.logEvent(instId, "info", "done_detected", { step: state.current_step });
  engine.addStepRecord(instId, state.current_step, "do", "passed", 0);
  engine.clearManualStepMarker(instId);
  engine.clearManualGate(instId);
  engine.clearReinjectCounter(instId);
  engine.clearDoPromptCache(instId);
  engine.clearDoneTagDetected(instId);
  engine.writeState({ ...state, current_phase: "check" }, instId);
  engine.recordStepStart(instId, state.current_step, "check");
  engine.logEvent(instId, "info", "step_start", { step: state.current_step, phase: "check" });

  const checkPrompt = engine.buildCheckPrompt(instId, step, state.user_task);

  // Visible: what is being checked.
  await injectPrompt(client, sessionId,
    `## 🔍 CHECK 阶段\n\n正在用**独立只读会话**验证步骤 \`${step.id}\`（约需 1 分钟，独立于本对话）。\n\n### 检查依据\n\n${engine.renderStepText(instId, step.check)}`,
    true);

  let checkResult;
  try {
    checkResult = await adversarialCheck(client, engine, instId, sessionId, step, checkPrompt, state.user_task, workflow.adversarial_check);
  } catch (err: any) {
    engine.logEvent(instId, "error", "adversarial_check_uncaught", { stepId: step.id, error: err.message });
    const st = engine.readState(instId);
    if (st && st.active && st.current_phase === "check" && st.current_step === state.current_step && st.workflow_name === state.workflow_name) {
      engine.writeState({ ...st, paused: true, pause_reason: "check_error", last_failure_reason: `对抗性检查崩溃：${err.message}` }, instId);
    }
    await injectPrompt(client, sessionId, `## ⚠️ 验证未能运行\n\n对抗性检查崩溃：${err.message}\n\n工作流已暂停（不计入失败次数，已完成的工作保持原样）。问题解决后运行 \`/ralphflow-continue\` 重新验证。`, true);
    return;
  }

  // Re-check state: a cancel or a concurrent continue may have moved on.
  const cur = engine.readState(instId);
  if (!cur || !cur.active || cur.current_phase !== "check"
      || cur.workflow_name !== state.workflow_name || cur.current_step !== state.current_step) {
    engine.logEvent(instId, "warn", "check_result_discarded", { reason: "state changed during check" });
    return;
  }

  // Infra failure: verifier produced no verdict — pause in check, no fail burn.
  if (checkResult.infra) {
    engine.writeState({ ...cur, paused: true, pause_reason: "check_error", last_failure_reason: checkResult.reason }, instId);
    engine.logEvent(instId, "warn", "workflow_paused", { workflow: cur.workflow_name, step: cur.current_step, reason: "check_infra_error" });
    await injectPrompt(client, sessionId,
      `## ⚠️ 验证未能运行\n\n${checkResult.reason}\n\n这是验证进程自身的问题（额度/API/超时），**不是**工作成果的问题：本次不计入失败次数，已完成的工作无需重做。问题解决后运行 \`/ralphflow-continue\` 直接重新验证。`,
      true);
    return;
  }

  // Visible: the verdict and its reason (its own clean message).
  await injectPrompt(client, sessionId,
    `## ${checkResult.passed ? "检查结果：通过 ✓" : "检查结果：未通过 ✗"}（步骤 \`${step.id}\`）\n\n### ${checkResult.passed ? "通过原因" : "失败原因"}\n\n${checkResult.reason || "（验证者未给出原因）"}`,
    true);

  engine.addStepRecord(instId, cur.current_step, "check", checkResult.passed ? "passed" : "failed", cur.fail_count || 0, checkResult.reason);
  const result = checkResult.passed
    ? engine.handleCheckPassed(instId, cur, workflow, step, checkResult)
    : engine.handleCheckFailed(instId, cur, workflow, step, checkResult);

  if (result.completed) {
    await injectPrompt(client, sessionId, `## 🎉 工作流完成\n\n所有步骤已通过独立验证。`, true);
    return;
  }
  if (result.paused) {
    const paused = engine.readState(instId);
    const why = paused?.pause_reason ? (PAUSE_REASON_CN[paused.pause_reason] || paused.pause_reason) : "未知原因";
    await injectPrompt(client, sessionId,
      `## ⏸️ 工作流已暂停\n\n原因：${why}。\n\n${paused?.last_failure_reason || ""}\n\n修复问题后运行 \`/ralphflow-continue\` 从当前步骤恢复。`,
      true);
    return;
  }

  // Advanced to the next step's DO phase — drive the model with its DO prompt.
  const next = engine.readState(instId);
  if (next && next.active && !next.paused && next.current_phase === "do") {
    engine.clearDoneTagDetected(instId);
    engine.clearManualGate(instId);
    const nextWf = next.workflow_name === workflow.name ? workflow : engine.loadWorkflow(next.workflow_name);
    if (nextWf?.manual_step?.includes(next.current_step)) engine.writeManualStepMarker(instId);
    engine.markPromptDelivered(next.current_step, instId);
    // handleCheckPassed already built & cached the next DO prompt.
    const doPrompt = readTextFile(path.join(engine.getInstanceDir(instId), ".do-prompt-cache"));
    await injectPrompt(client, sessionId,
      `## ▶️ 下一步：\`${next.current_step}\`\n\n---\n\n${doPrompt}`);
  }
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
    const manualStepMarker = path.join(instDir, ".manual-step-active");
    const manualGateMarker = path.join(instDir, MANUAL_GATE_MARKER);
    const doPromptCacheFile = path.join(instDir, ".do-prompt-cache");
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
    const currentStep = workflow ? engine.getStep(workflow, stateStep) : null;
    if (currentStep && isSubWorkflowStep(currentStep)) return;

    const { text: lastOutput, hasToolUse } = await getLastAssistantMessage(client, sessionId);

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
          `📋 手动步骤 \`${stateStep}\` 已完成，等待你的审查。\n\n- 满意后运行 /ralphflow-continue 进入独立验证\n- 需要修改直接在对话里说明，修改完成后会再次提示审查\n- 放弃可运行 /ralphflow-cancel`,
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

    const alreadyReported = !shouldReportPhase();

    // Check phase: always suppress during verification (no action needed)
    if (statePhase === "check") return;

    let phaseGuidance = "";

    if (statePhase === "do") {
      // Only increment reinject counter when the model stopped WITHOUT making
      // tool calls. If it made tool calls, it's actively working and not stuck.
      const reinjectCount = hasToolUse ? getReinjectCount() : incrementReinjectCount();

      // Only raise the max-reinjection alarm when the model is actually idle —
      // and do NOT keep driving: hand control to the user (the workflow state
      // itself is NOT paused — driving resumes as soon as the user or the
      // model acts again).
      if (reinjectCount > MAX_DO_REINJECT && !hasToolUse) {
        await injectPrompt(client, sessionId,
          `## ⚠️ Ralph Flow 已停止自动驱动\n\n步骤 \`${stateStep}\` 的 DO 阶段已连续 ${reinjectCount} 次收到继续提示但未产出完成标记，会话已停止，请人工介入：\n1. 查看任务卡在哪里，补充信息后让模型继续\n2. 若任务实际已完成，运行 /ralphflow-continue 进入验证\n3. 运行 /ralphflow-cancel 取消工作流`,
          true);
        return;
      }

      if (alreadyReported) {
        // Check if a tool response just delivered the DO prompt this turn — if
        // so, skip the keep-alive to avoid duplicate messages
        if (fileExists(postToolMarker)) {
          const markerTime = parseInt(readTextFile(postToolMarker), 10);
          const age = Date.now() - (markerTime || 0);
          removeFile(postToolMarker);
          if (age < 10000) return; // Within 10 seconds
        }

        // Already reported full phase info — send keep-alive with DO prompt to
        // keep the session working when the workflow expects more.
        const cachedPromptForKeepalive = readTextFile(doPromptCacheFile);
        const keepaliveTask = cachedPromptForKeepalive ? `\n\n${cachedPromptForKeepalive}` : "";
        await injectPrompt(client, sessionId,
          `继续执行步骤 \`${stateStep}\` 的任务。${keepaliveTask}\n\n当所有要求满足后，在单独一行输出 \`<promise>done</promise>\`。如果任务已完成且需要验证，调用 \`ralphflow_continue\`。`);
        return;
      }

      // Include full context with cached do prompt (always available on first report)
      const cachedPrompt = readTextFile(doPromptCacheFile);
      if (cachedPrompt) {
        phaseGuidance = `你正在步骤 \`${stateStep}\` 的 **DO 阶段**。以下是你的当前任务：\n\n${cachedPrompt}\n\n继续执行。当所有要求满足后，在单独一行输出 \`<promise>done</promise>\`。`;
      } else {
        phaseGuidance = `你正在步骤 \`${stateStep}\` 的 **DO 阶段**。继续执行任务。当所有要求满足后，在单独一行输出 \`<promise>done</promise>\`。任务完成前不要停止。`;
      }
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
