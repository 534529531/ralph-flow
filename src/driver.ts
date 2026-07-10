/**
 * Ralph Flow Driver — opencode adapter, structural mirror of the Claude Code
 * plugin's hooks/done-detect.js (Stop hook).
 *
 * Claude Code fires a Stop hook whose JSON output can block the stop and show
 * a systemMessage; here the equivalent signal is the `session.idle` event, and
 * the equivalents of the hook's outputs are:
 *   - decision:"block" + systemMessage  →  injectPrompt(...)          (drives the model)
 *   - systemMessage only (session stops) →  injectPrompt(..., noReply) (user-facing note)
 *   - {} (silent allow)                  →  return without injecting
 *
 * All dedup/counter markers keep the exact filenames of the hook version so
 * the two implementations stay diffable.
 */

import fs from "fs";
import path from "path";
import type { Engine, WorkflowDef, NormalStepDef } from "./engine.js";
import { isSubWorkflowStep, MANUAL_GATE_MARKER, DONE_TAG_MARKER } from "./engine.js";

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

export async function injectPrompt(
  client: Client,
  sessionId: string,
  prompt: string,
  noReply = false
): Promise<boolean> {
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: prompt }],
        noReply,
      },
    });
    return true;
  } catch {
    return false;
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
      // A done tag only means something during the DO phase. One emitted while
      // a check is running must NOT leave a marker behind — a stale marker
      // would make the driver tell the model to skip the NEXT step's work.
      if (statePhase !== "do") return;

      removeFile(reinjectFile);

      // Persist that done was reached — used by Case 2, and by the attach
      // logic to distinguish "died mid-DO" from "done, awaiting check".
      writeFileSafe(doneTagDetectedFile, Date.now().toString());

      // Manual step: the review gate sits BEFORE the check phase. Do NOT drive
      // the model — let the session stop so the USER can review. The user's
      // /ralphflow-continue is the approval that starts the verification.
      if (fileExists(manualStepMarker)) {
        writeFileSafe(manualGateMarker, Date.now().toString());
        await injectPrompt(client, sessionId,
          `📋 手动步骤 \`${stateStep}\` 已完成，等待你的审查。\n\n- 满意后运行 /ralphflow-continue 进入独立验证\n- 需要修改直接在对话里说明，修改完成后会再次提示审查\n- 放弃可运行 /ralphflow-cancel`,
          true);
        return;
      }

      // Build step progress info
      let stepInfo = "";
      if (stateStep) {
        stepInfo = `**Current Step**: \`${stateStep}\``;
        if (stateFailCount > 0) stepInfo += ` (failed ${stateFailCount}x)`;
      }

      // Update dedup file to prevent duplicates
      writeFileSafe(phaseReportFile, `check:${stateStep}`);

      await injectPrompt(client, sessionId,
        `## ✅ DO 阶段完成\n\n${stepInfo}\n\n调用 \`ralphflow_continue\` 以启动 CHECK 阶段，对步骤 \`${stateStep}\` 运行独立验证。`);
      return;
    }

    // ── Case 2: Workflow active, report current phase (with dedup) ──────────
    if (fileExists(doneTagDetectedFile) && statePhase === "do") {
      // Manual gate active: the user is reviewing. Stay completely silent so
      // the user can chat freely; the gate is only released by their
      // ralphflow_continue.
      if (fileExists(manualGateMarker)) return;
      // Non-manual: done tag was output but ralphflow_continue not yet called —
      // keep reminding the model to call it instead of re-injecting the DO prompt.
      await injectPrompt(client, sessionId,
        `## ✅ DO 阶段已完成\n\n步骤 \`${stateStep}\` 已输出完成标记。请立即调用 \`ralphflow_continue\` 工具继续验证阶段。\n\n不要继续执行 DO 阶段的任务。`);
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
