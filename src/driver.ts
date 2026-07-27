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
import { isSubWorkflowStep, MANUAL_GATE_MARKER, DONE_TAG_MARKER, DEFAULT_ADVERSARIAL_TIMEOUT_MS } from "./engine.js";
import { adversarialCheck } from "./check.js";

type Client = any;

const MAX_DO_REINJECT = 5;

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
    engine.addStepRecord(instId, state.current_step, "do", "passed", state.fail_count || 0);
  }
  engine.clearManualStepMarker(instId);
  engine.clearManualGate(instId);
  engine.clearReinjectCounter(instId);
  engine.clearDoPromptCache(instId);
  engine.clearDoneTagDetected(instId);
  engine.writeState({ ...state, current_phase: "check" }, instId);
  engine.recordStepStart(instId, state.current_step, "check");
  engine.logEvent(instId, "info", "step_start", { step: state.current_step, phase: "check" });

  const checkPrompt = engine.buildCheckPrompt(instId, step, state.user_task);

  // Visible: the full context the independent verifier sees — user task, what the
  // DO phase was supposed to produce, and the check criteria. The original v1
  // plugin injected the complete buildCheckPrompt; the user should see everything
  // the verifier judges against, not just the check criteria in isolation.
  const visibleSections: string[] = [];
  if (state.user_task) {
    visibleSections.push(`### 用户需求\n\n${state.user_task}`);
  }
  visibleSections.push(`### Do 阶段任务\n\n**任务描述**：${engine.renderStepText(instId, step.do)}\n\n**输入**：${engine.renderStepText(instId, step.input)}\n\n**预期输出**：${engine.renderStepText(instId, step.output)}`);
  visibleSections.push(`### 检查依据\n\n${engine.renderStepText(instId, step.check)}`);
  // Report the CONFIGURED timeout ceiling, not a made-up "~1 minute". The
  // verifier independently explores the project and runs the check commands
  // (builds/tests can take minutes); its only hard bound is this timeout.
  // Field-level inheritance: a sub-workflow step checks with the nearest
  // ancestor's value for every field it doesn't validly define itself.
  const adversarialConfig = engine.getEffectiveAdversarialCheck(instId, workflow);
  const timeoutMin = Math.max(1, Math.round((adversarialConfig?.timeout_ms || DEFAULT_ADVERSARIAL_TIMEOUT_MS) / 60000));
  await injectPrompt(client, sessionId,
    `## 🔍 CHECK 阶段 · 自动验证中\n\n正在用**独立验证会话**验证步骤 \`${step.id}\`（与本对话隔离运行，最长 ${timeoutMin} 分钟）。\n\n⏳ **现在无需你操作，请等待结果。** 这一步由独立会话完成，在这里发消息不会加快它、也不影响判定。\n> 迟迟没有结果时：\`/ralphflow-status\` 看进度，或 \`/ralphflow-cancel\` 取消。\n\n---\n\n以下是它正在核对的依据（供你了解，不用回复）：\n\n${visibleSections.join("\n\n")}`,
    true);

  let checkResult;
  try {
    checkResult = await adversarialCheck(client, engine, instId, sessionId, step, checkPrompt, state.user_task, adversarialConfig);
  } catch (err: any) {
    engine.logEvent(instId, "error", "adversarial_check_uncaught", { stepId: step.id, error: err.message });
    const st = engine.readState(instId);
    if (st && st.active && st.current_phase === "check" && st.current_step === state.current_step && st.workflow_name === state.workflow_name) {
      engine.writeState({ ...st, paused: true, pause_reason: "check_error", last_failure_reason: `对抗性检查崩溃：${err.message}` }, instId);
    }
    await injectPrompt(client, sessionId, `## ⚠️ 验证未能运行 · 🙋 轮到你了\n\n对抗性检查崩溃：${err.message}\n\n这是**验证程序自身**的问题，不是你工作成果的问题——本次不计入失败次数，已完成的工作保持原样。\n\n👉 处理后运行 \`/ralphflow-continue\` 即可重新验证（无需重做任务），或 \`/ralphflow-cancel\` 放弃。`, true);
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
      `## ⚠️ 验证未能运行 · 🙋 轮到你了\n\n${checkResult.reason}\n\n这是验证进程自身的问题（额度/API/超时），**不是**你工作成果的问题：本次不计入失败次数，已完成的工作无需重做。\n\n👉 问题解决后运行 \`/ralphflow-continue\` 直接重新验证，或 \`/ralphflow-cancel\` 放弃。`,
      true);
    return;
  }

  engine.addStepRecord(instId, cur.current_step, "check", checkResult.passed ? "passed" : "failed", cur.fail_count || 0, checkResult.reason);
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

      // Only raise the max-reinjection alarm when the model is actually idle —
      // and do NOT keep driving: hand control to the user (the workflow state
      // itself is NOT paused — driving resumes as soon as the user or the
      // model acts again).
      if (reinjectCount > MAX_DO_REINJECT && !hasToolUse) {
        await injectPrompt(client, sessionId,
          `## ⏸ 已暂停自动驱动 · 🙋 轮到你了\n\n步骤 \`${stateStep}\` 的 DO 阶段连续 ${reinjectCount} 次被催促仍未完成，为避免空转已停下等你：\n\n1. 🔍 看看卡在哪，补充信息后**直接发消息**让模型继续\n2. ✅ 若其实已经做完 → 运行 \`/ralphflow-continue\` 进入验证\n3. 🗑️ 运行 \`/ralphflow-cancel\` 取消\n\n（工作流没有真正暂停——你或模型一有动作就会自动恢复驱动。）`,
          true);
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
