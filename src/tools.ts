/**
 * Ralph Flow tools — opencode adapter.
 *
 * Tool names use the SAME underscore names as the Claude MCP tools
 * (ralphflow_start, ralphflow_continue, …) so the behavior rules, workflow
 * texts and docs stay word-for-word portable between the two plugins.
 *
 * Runtime is opencode-native (see SYNC.md): no engine lock, no shared "bound
 * instance". Every op takes an explicit instId; ownership is the session_id in
 * the instance's state.json. `context.sessionID` identifies the caller.
 *
 * Check is NOT run from any tool — the driver runs it automatically on idle
 * for normal steps and for manual steps whose gate was just approved.
 * ralphflow_continue is pure state management (approve gate / resume / attach).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { tool } from "@opencode-ai/plugin";
import type { Engine } from "./engine.js";
import { isSubWorkflowStep, MAX_NESTING_DEPTH, MAX_DO_REINJECT, MANUAL_GATE_MARKER, DONE_TAG_MARKER, type NormalStepDef, type RalphFlowState } from "./engine.js";
import { hasActiveCheck } from "./check.js";
import { executeContextReset } from "./driver.js";
import { deleteVotingProgress, readVotingProgress } from "./voting-progress.js";
import { voterStatusLabel } from "./check-voting.js";

type Client = any;

export function createTools(engine: Engine, client: Client) {
  // ─── Tool: ralphflow_start ──────────────────────────────────────────────────

  // One-time orientation shown at start so first-time users learn the rhythm:
  // most of the run is autonomous (just wait); they are only pulled in at clearly
  // announced handoff points (manual review, or a pause on repeated failure).
  const ONBOARDING = `> 💡 **怎么配合它**：工作流会「自动执行 → 自动独立验证」一步步推进，**大多数时间你只需等待，不用管**。只有两类时刻会**明确提示「轮到你了」**：① 手动审查步骤，② 连续失败或异常导致的暂停。看到 🙋 就是需要你操作；看到 ⏳/🔍 就是自动进行中、静候即可。任何时候想调整方向，直接发消息就行。`;

  /**
   * 构造「回退/重置」的注入文本（transitionText）——把用户的"为什么回退/重置"
   * 原因段拼到 DO 提示之前，让新会话冷启动第一眼就看到；同时把它覆盖进
   * `.do-prompt-cache`，让 idle keep-alive 重注入时也保留这段原因（否则几轮
   * 后会被 buildDoNudge 退化为裸 DO 提示，用户的"为什么"在最该被记住时丢失）。
   *
   * 不传 reason（或全空）：构造与历史行为字节级一致的 transitionText（reset
   * 的回归测试依赖此路径），buildDoPrompt 自己写的 cache 不覆盖。
   *
   * kind="reset"：原「## 🔄 上下文已手动重置 / 步骤 X 将重新执行」头 +
   * 可选的 reason 段；kind="rewind"：换 🔙 回退说明头，并显式点明"下游 ✓
   * 仅为历史、本次重做、插件不删产物"。两个 kind 共用同一覆盖 cache 路径。
   *
   * fromStepId 仅 rewind 用：调用方传入的是**已倒退后**的 state（current_step
   * 已是目标步），头里的"从哪回退"必须显式给出，不能从 state 读——否则
   * 写出来就是"已从步骤 X 回退到 X"（本次修复的 bug）。reset 不传，from 即
   * state.current_step。
   */
  function buildRewindOrResetTransitionText(
    instId: string,
    step: NormalStepDef,
    state: RalphFlowState,
    reason: string | undefined,
    kind: "rewind" | "reset",
    fromStepId?: string,
  ): string {
    const reasonText = reason && reason.trim() ? reason.trim() : null;
    // buildDoPrompt 会自己 writeDoPromptCache(doPrompt)（engine.ts），下面的
    // 覆盖在有 reason 时才覆盖；无 reason 时保持 buildDoPrompt 的版本，与历史
    // 行为一致。
    const doPrompt = engine.buildDoPrompt(
      instId, step, state.user_task, state.last_failure_reason, state.fail_count || 0,
    );
    if (!reasonText) {
      // 字节级兼容老 reset 的 transitionText（回归测试依赖）。
      return `## 🔄 上下文已手动重置\n\n步骤 \`${state.current_step}\` 将重新执行。\n\n---\n\n${doPrompt}`;
    }
    const fromStep = fromStepId ?? state.current_step;
    const header = kind === "rewind"
      ? `## 🔙 回退说明\n\n已从步骤 \`${fromStep}\` 回退到 \`${step.id}\` 重做。会话交接说明里下游的 ✓ 仅为历史记录，本次将重做这些步骤。\n\n**用户回退原因**：\n\n${reasonText}\n\n> 已落盘的代码/文档保留。插件**不会自动删除**任何产物——按上面的原因，决定保留、调整还是让模型覆盖旧产出。`
      : `## 🔄 上下文已手动重置\n\n步骤 \`${state.current_step}\` 将重新执行。\n\n**用户重置原因**：\n\n${reasonText}`;
    const fullText = `${header}\n\n---\n\n${doPrompt}`;
    // 让 idle keep-alive 重注入也带上 reason（buildDoPrompt 写的裸 cache 被覆盖）。
    engine.writeDoPromptCache(fullText, instId);
    return fullText;
  }

  const ralphflow_start = tool({
    description: "启动一个工作流实例。需提供工作流名称和任务描述。同一项目下多个会话可各自运行自己的实例。",
    args: {
      workflow: tool.schema.string().describe("工作流名称（用 ralphflow_list 查看可用工作流）"),
      task: tool.schema.string().describe("任务描述——需要完成什么"),
      extra_dirs: tool.schema.array(tool.schema.string()).optional().describe("任务源材料所在的、项目目录之外的目录（绝对路径或 ~/...）。独立的 CHECK 验证器会获得对它们的只读访问；每个目录必须存在，否则拒绝启动。"),
    },
    async execute({ workflow, task, extra_dirs }, context) {
      const sessionId = context.sessionID;
      // Refuse if this session already runs an active instance.
      const instances = engine.listInstances();
      const mine = instances.find((i) => i.owner === sessionId);
      if (mine) {
        return `当前会话已有活跃工作流实例 \`${mine.id}\`（工作流: ${mine.state.workflow_name}，步骤: ${mine.state.current_step}）。\n\n使用 /ralphflow-continue 继续，或先用 /ralphflow-cancel 取消。`;
      }

      const workflowProblems: string[] = [];
      const workflowDef = engine.loadWorkflow(workflow, workflowProblems);
      if (!workflowDef) {
        if (workflowProblems.length > 0) {
          return `工作流 "${workflow}" 定义无效，无法启动：\n${workflowProblems.map((p) => `- ${p}`).join("\n")}\n\n请修复工作流 YAML 后重试。`;
        }
        const available = engine.listWorkflows();
        return available.length > 0
          ? `工作流 "${workflow}" 未找到。可用工作流：\n${available.map((w) => `- ${w.name}: ${w.desc}`).join("\n")}`
          : "没有找到工作流。请在 .opencode/ralph-flow/workflows/ 目录创建工作流定义文件。";
      }

      const firstStep = workflowDef.steps[0];
      if (!firstStep) return "工作流没有步骤。";

      // Validate extra_dirs before creating anything.
      const home = os.homedir() || "";
      const resolvedExtraDirs: string[] = [];
      for (const d of extra_dirs || []) {
        let p = String(d).trim();
        if (!p) continue;
        if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
        if (!path.isAbsolute(p)) p = path.resolve(engine.projectDir, p);
        let st = null;
        try { st = fs.statSync(p); } catch {}
        if (!st || !st.isDirectory()) {
          return `extra_dirs 校验失败：\`${d}\`（解析为 \`${p}\`）不存在或不是目录。请修正后重新启动。`;
        }
        resolvedExtraDirs.push(p);
      }

      // Create a fresh instance owned by this session.
      const instId = engine.generateInstanceId(workflow);
      fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
      engine.writeArtifactsDirName(instId, task);
      engine.writeExtraDirs(instId, resolvedExtraDirs);

      const othersNote = instances.length > 0
        ? `\n\n> ℹ️ 本目录下另有 ${instances.length} 个工作流实例，使用 /ralphflow-status 查看。`
        : "";
      const extraDirsNote = resolvedExtraDirs.length > 0
        ? `\n\n验证器额外可读目录：${resolvedExtraDirs.map((d) => `\`${d}\``).join("、")}`
        : "";
      const baseState = { active: true, workflow_name: workflow, current_step: firstStep.id, current_phase: "do", fail_count: 0, user_task: task, paused: false, session_id: sessionId };

      if (isSubWorkflowStep(firstStep)) {
        engine.recordStepStart(instId, firstStep.id, "do");
        engine.logEvent(instId, "info", "step_start", { step: firstStep.id, phase: "do" });
        engine.writeState(baseState, instId);
        engine.pushState(baseState, instId);
        const subResult = engine.resolveSubWorkflowEntry(instId, firstStep.workflow, task, firstStep);
        if (subResult.error) {
          try { fs.rmSync(engine.getInstanceDir(instId), { recursive: true, force: true }); } catch {}
          return subResult.text;
        }
        engine.markPromptDelivered(engine.readState(instId)?.current_step || firstStep.id, instId);
        engine.logEvent(instId, "info", "workflow_start", { workflow, instance: instId });
        const stepsOverview = workflowDef.steps.map((s, i) => `  ${i + 1}. **${s.id}**: ${s.desc}${isSubWorkflowStep(s) ? ` (子工作流: ${s.workflow})` : ""}`).join("\n");
        return `工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${stepsOverview}\n\n启动子工作流：**${firstStep.id}** → ${firstStep.workflow}${extraDirsNote}${othersNote}\n\n${ONBOARDING}\n\n---\n\n${subResult.text}`;
      }

      engine.writeState(baseState, instId);
      engine.logEvent(instId, "info", "workflow_start", { workflow, instance: instId });
      engine.recordStepStart(instId, firstStep.id, "do");
      engine.logEvent(instId, "info", "step_start", { step: firstStep.id, phase: "do" });
      if (workflowDef.manual_step && workflowDef.manual_step.includes(firstStep.id)) {
        engine.writeManualStepMarker(instId);
      }
      engine.markPromptDelivered(firstStep.id, instId);
      const stepsOverview = workflowDef.steps.map((s, i) => `  ${i + 1}. **${s.id}**: ${s.desc}${isSubWorkflowStep(s) ? ` (子工作流: ${s.workflow})` : ""}`).join("\n");
      return `工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${stepsOverview}\n\n开始：**${firstStep.id}** - ${firstStep.desc}${extraDirsNote}${othersNote}\n\n${ONBOARDING}\n\n---\n\n${engine.buildDoPrompt(instId, firstStep, task)}`;
    },
  });

  // ─── Tool: ralphflow_continue ───────────────────────────────────────────────
  //
  // NEVER runs a check. Check is always idle-driven (driver.ts). This tool is
  // pure state management: clear a manual review gate, resume a paused
  // workflow, or attach to an interrupted instance. After it returns, the
  // session goes idle and the driver picks up whatever is next (for a manual
  // step whose gate just cleared, that means the idle auto-runs the check with
  // the same visible messages as normal steps).

  const ralphflow_continue = tool({
    description: "批准手动审查 / 恢复暂停的工作流 / 接管中断的实例。不会运行验证——验证会在你空闲时自动进行。（可选实例 id，支持唯一前缀。）",
    args: {
      instance: tool.schema.string().optional().describe("实例 id（支持唯一前缀）。仅在从新会话接管特定实例时需要。"),
    },
    async execute({ instance }, context) {
      const sessionId = context.sessionID;

      const resolution = engine.resolveInstance(instance, sessionId);
      if (!resolution.ok) return resolution.text;
      const instId = resolution.id;
      const attached = resolution.attached;

      // One session drives at most one instance.
      if (attached) {
        const other = engine.listInstances().find((i) => i.id !== instId && i.owner === sessionId);
        if (other) {
          return `当前会话已有活跃工作流实例 \`${other.id}\`（工作流: ${other.state.workflow_name}，步骤: ${other.state.current_step}）。一个会话同时只能驱动一个实例——请先完成或取消它，或在另一个会话中接管 \`${instId}\`。`;
        }
      }
      engine.bindInstance(instId, sessionId);

      let state = engine.readState(instId);
      if (!state || !state.active) {
        return "没有活跃的工作流。使用 ralphflow_start 启动一个。";
      }

      const workflow = engine.loadWorkflow(state.workflow_name);
      if (!workflow) {
        return `工作流 "${state.workflow_name}" 未找到。`;
      }

      // 1. check_error pause: the verifier couldn't run. Reset to check phase
      //    (the work is untouched). On the next idle the driver automatically
      //    re-runs the check — nothing more to do here.
      if (state.paused && state.pause_reason === "check_error" && state.current_phase === "check") {
        const step = engine.getStep(workflow, state.current_step);
        if (step && !isSubWorkflowStep(step)) {
          engine.writeState({ ...state, paused: false, pause_reason: undefined }, instId);
          engine.logEvent(instId, "info", "check_retry_after_infra_error", { workflow: state.workflow_name, step: step.id });
          return "验证基础设施故障已清除，工作流恢复。空闲时自动重新验证。";
        }
      }

      // 2. manual gate: the user approves the work. Clear the gate so the
      //    next idle auto-runs the check (same path as normal steps). Do NOT
      //    touch the done-tag marker — the original detected-done idle wrote
      //    it, and Case 2 needs it to trigger check on the next idle.
      if (engine.markerExists(MANUAL_GATE_MARKER, instId)) {
        engine.clearManualStepMarker(instId);
        engine.clearManualGate(instId);
        engine.logEvent(instId, "info", "manual_gate_approved", { step: state.current_step });
        return `## ✅ 审查通过\n\n步骤 \`${state.current_step}\` 已批准。空闲时将自动运行独立验证。`;
      }

      // 3. Paused (max_failures / config_error / session_*): reset fail_count
      //    and return the DO prompt for a fresh attempt.
      if (state.paused) {
        const previousFailCount = state.fail_count;
        const previousReason = state.last_failure_reason;
        engine.clearReinjectCounter(instId);
        engine.clearDoneTagDetected(instId);
        engine.clearManualGate(instId);
        engine.writeState({ ...state, current_phase: "do", paused: false, pause_reason: undefined, fail_count: 0 }, instId);
        engine.logEvent(instId, "info", "workflow_resumed", { workflow: state.workflow_name, step: state.current_step });

        const step = engine.getStep(workflow, state.current_step);
        if (!step) {
          return `已恢复。当前步骤：${state.current_step}`;
        }

        if (isSubWorkflowStep(step)) {
          engine.recordStepStart(instId, step.id, "do");
          engine.logEvent(instId, "info", "step_start", { step: step.id, phase: "do" });
          const staleTop = engine.popState(instId);
          const staleIsMismatch = staleTop && !(staleTop.workflow_name === state.workflow_name && staleTop.current_step === state.current_step);
          if (staleIsMismatch) {
            engine.pushState(staleTop, instId);
          }
          engine.pushState({ ...state, current_step: step.id, current_phase: "do", fail_count: 0, paused: false, pause_reason: undefined }, instId);
          const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step, MAX_NESTING_DEPTH, previousReason, previousFailCount);
          if (subResult.error) {
            engine.popState(instId); // undo our push
            if (staleIsMismatch) engine.popState(instId); // also undo the stale push-back
            engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
            return subResult.text;
          }
          engine.markPromptDelivered(engine.readState(instId)?.current_step || step.id, instId);
          let resumeMsg = `## 工作流已恢复\n\n之前尝试次数：${previousFailCount}`;
          if (previousReason) resumeMsg += `\n\n### 上次失败原因\n${previousReason}`;
          resumeMsg += "\n\n---\n\n";
          return resumeMsg + `重新进入子工作流：**${step.id}**\n\n---\n\n${subResult.text}`;
        }

        if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
          engine.writeManualStepMarker(instId);
        }
        const doPrompt = engine.buildDoPrompt(instId, step, state.user_task, previousReason, previousFailCount);
        engine.markPromptDelivered(step.id, instId);
        return `## 工作流已恢复\n\n---\n\n${doPrompt}`;
      }

      // 4. Crash recovery: stuck in check phase with no active verifier →
      //    reset to do, return the DO prompt.
      if (state.current_phase !== "do") {
        if (state.current_phase === "check") {
          if (hasActiveCheck(instId)) {
            engine.logEvent(instId, "info", "crash_recovery_skipped", { step: state.current_step });
            return `## ⏳ 验证进行中\n\n步骤 **${state.current_step}** 的对抗性检查仍在运行。\n\n请等待完成，或使用 \`/ralphflow-cancel\` 取消工作流。`;
          }
          // Orphan verifier sessions from a previous process: no one will ever
          // collect their results — drop them before re-driving (design §6.2).
          const orphans = engine.readAdversarialSessions(instId);
          for (const sid of orphans) {
            try { await client.session.delete({ path: { id: sid } }); } catch {}
          }
          engine.clearAdversarialSession(instId);
          deleteVotingProgress(engine, instId);
          engine.logEvent(instId, "warn", "crash_recovery", { step: state.current_step, orphan_sessions: orphans.length });
          state = { ...state, current_phase: "do" };
          engine.writeState(state, instId);
          engine.clearReinjectCounter(instId);
          engine.clearManualStepMarker(instId);
          engine.clearManualGate(instId);
          engine.clearDoneTagDetected(instId);
          const step = engine.getStep(workflow, state.current_step);
          if (!step) {
            return `崩溃恢复：步骤 "${state.current_step}" 在工作流中未找到。`;
          }
          if (isSubWorkflowStep(step)) {
            const staleTop = engine.popState(instId);
            const staleIsMismatch = staleTop && !(staleTop.workflow_name === state.workflow_name && staleTop.current_step === state.current_step);
            if (staleIsMismatch) {
              engine.pushState(staleTop, instId);
            }
            engine.pushState({ ...state, current_step: step.id, current_phase: "do", fail_count: state.fail_count || 0 }, instId);
            const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step, MAX_NESTING_DEPTH, "之前的验证被中断（进程崩溃）。请重新执行任务。", state.fail_count || 0);
            if (subResult.error) {
              engine.popState(instId); // undo our push
              if (staleIsMismatch) engine.popState(instId); // also undo the stale push-back
              engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
              return subResult.text;
            }
            engine.markPromptDelivered(engine.readState(instId)?.current_step || step.id, instId);
            return `## ⚠️ 崩溃恢复\n\n进程在验证期间崩溃。\n\n---\n\n重新进入子工作流：**${step.id}**\n\n---\n\n${subResult.text}`;
          }
          if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
            engine.writeManualStepMarker(instId);
          }
          const prompt = engine.buildDoPrompt(instId, step, state.user_task, "之前的验证被中断（进程崩溃）。请重新执行任务。", state.fail_count || 0);
          engine.markPromptDelivered(step.id, instId);
          return `## ⚠️ 崩溃恢复\n\n进程在验证期间崩溃。DO 阶段已重置。\n\n---\n\n${prompt}`;
        }
        return `当前阶段是 "${state.current_phase}"，不是 "do"。工作流已在处理中。`;
      }

      const step = engine.getStep(workflow, state.current_step);
      if (!step) return `步骤 "${state.current_step}" 未找到。`;

      // 5. Attach: taking over an instance that died MID-DO (no done tag, no
      //    manual gate). Re-issue the DO prompt — the check runs on the
      //    next idle after the model re-does this step.
      if (attached && !engine.markerExists(DONE_TAG_MARKER, instId) && !engine.markerExists(MANUAL_GATE_MARKER, instId)) {
        if (isSubWorkflowStep(step)) {
          engine.pushState({ ...state, current_step: step.id, current_phase: "do", fail_count: state.fail_count || 0 }, instId);
          const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step, MAX_NESTING_DEPTH, state.last_failure_reason, state.fail_count || 0);
          if (subResult.error) {
            engine.popState(instId);
            engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
            return subResult.text;
          }
          engine.markPromptDelivered(engine.readState(instId)?.current_step || step.id, instId);
          engine.logEvent(instId, "info", "instance_attached_resume_do", { instance: instId, step: step.id });
          return `## 已接管工作流实例 \`${instId}\`\n\n该实例中断于 DO 阶段，继续执行子工作流。\n\n---\n\n${subResult.text}`;
        }
        if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
          engine.writeManualStepMarker(instId);
        }
        const prompt = engine.buildDoPrompt(instId, step, state.user_task, state.last_failure_reason, state.fail_count || 0);
        engine.markPromptDelivered(step.id, instId);
        engine.logEvent(instId, "info", "instance_attached_resume_do", { instance: instId, step: step.id });
        return `## 已接管工作流实例 \`${instId}\`\n\n该实例中断于 DO 阶段，继续执行当前步骤。\n\n---\n\n${prompt}`;
      }

      // 5.5. Reinject-exhausted DO step: the driver stopped auto-driving after
      //      MAX_DO_REINJECT nudges (it told the user "run /ralphflow-continue
      //      to confirm completion"). THIS is that path — the user calling
      //      continue here is declaring the step done. Arm the done-tag marker
      //      so the next idle's Case 2 auto-runs the independent check. Without
      //      this, continue would fall through to branch 6 ("nothing to do"),
      //      the exhausted counter would never reset, and the driver would
      //      re-warn forever — the workflow could never advance.
      if (state.current_phase === "do" && engine.readReinjectCount(instId, state.current_step, "do") > MAX_DO_REINJECT) {
        engine.writeMarker(DONE_TAG_MARKER, Date.now().toString(), instId);
        engine.clearReinjectCounter(instId);
        engine.logEvent(instId, "info", "do_confirmed_done_by_user", { step: state.current_step });
        return `## ✅ 已确认完成\n\n步骤 \`${state.current_step}\` 已标记为完成，空闲时将自动运行独立验证（与模型自己输出 \`<promise>done</promise>\` 走同一条验证路径）。\n\n> 若其实还没做完——直接发消息告诉模型继续即可，验证不会擅自开始（验证只在空闲驱动检测到完成标记后才运行）。`;
      }

      // 6. In do, no gate, no pause, no attach. Nothing for this tool to change
      //    — but "nothing to continue" alone reads as a failed call, and the old
      //    wording ("验证会在你空闲时自动运行") reads as "verification is already
      //    underway", so the model waits for a verdict that will never come and
      //    calls again. State the phase it is actually in, then hand back the
      //    same DO nudge the driver injects on idle: the step isn't done, and
      //    the done tag is the only thing that ends it — manual or not.
      engine.markPromptDelivered(step.id, instId);
      return `步骤 \`${state.current_step}\` 仍在 **DO 阶段**（没有待批准的审查、没有暂停、没有中断的实例），本工具无需操作。验证只在 DO 阶段结束后才开始。\n\n${engine.buildDoNudge(instId, state.current_step)}`;
    },
  });

  // ─── Tool: ralphflow_reset ───────────────────────────────────────────────────

  const ralphflow_reset = tool({
    description: "手动重置当前工作流上下文：创建新会话，在新会话中重新执行当前步骤的 DO 阶段。当前会话的上下文仍保留，但工作流驱动权转移到新会话。",
    args: {
      reason: tool.schema.string().optional().describe("可选的重置原因——来自用户，说明为什么重置、重做时要注意什么。传入后会拼到新会话首条 DO 提示前，并随 idle keep-alive 保留；不传时行为旧版一致。"),
      instance: tool.schema.string().optional().describe("实例 id（支持唯一前缀）。仅当本会话有多个实例时需指定。"),
    },
    async execute({ reason, instance }, context) {
      const sessionId = context.sessionID;
      const resolution = engine.resolveInstance(instance, sessionId);
      if (!resolution.ok) return resolution.text;
      const instId = resolution.id;

      const state = engine.readState(instId);
      if (!state || !state.active) return "没有活跃的工作流。使用 ralphflow_start 启动一个。";
      if (state.session_id !== sessionId) {
        return "该实例的属主是另一个会话。只有属主会话可以重置。在当前会话调用 ralphflow_continue 接管该实例。";
      }

      // 暂停实例拒绝 reset：paused 会随状态原样带进新会话，而新会话的 idle
      // 驱动对 paused 实例静默——用户看到"已在新会话继续"却永远不动，得自己
      // 察觉后再 continue。暂停的解除必须走显式路径，所以在这里就拦下。
      if (state.paused) {
        return `实例当前处于暂停状态（${state.pause_reason || "未知原因"}）。重置不会解除暂停——换新会话后空闲驱动对暂停实例静默，看似"没反应"。\n\n请先运行 \`/ralphflow-continue\` 恢复（解除暂停并归零失败计数）；恢复后若仍想换干净上下文，再运行 \`/ralphflow-reset\`。想回退到上游已通过步骤改方向重做，用 \`/ralphflow-rewind\`（它会解除暂停）。`;
      }

      if (state.current_phase !== "do") {
        return `当前阶段是 "${state.current_phase}"，不是 "do"。\n\n重置只能在 DO 阶段进行——CHECK 阶段有独立验证在跑，请稍候。`;
      }

      const workflow = engine.loadWorkflow(state.workflow_name);
      if (!workflow) return `工作流 "${state.workflow_name}" 未找到。`;

      const step = engine.getStep(workflow, state.current_step);
      if (!step) return `步骤 "${state.current_step}" 未找到。`;

      // fail_count / last_failure_reason 原样保留：reset 只是换一个干净的上下文
      // 容器，不赦免失败——否则模型（或用户）反复 reset 就能无限续命，
      // max_fail_count 这道自动刹车就失效了。想重算失败预算，走
      // 「暂停 → ralphflow_continue」的显式赦免路径。
      // reason 透传给注入函数；无 reason 时保持字节级旧 transitionText 与 cache。
      const transitionText = buildRewindOrResetTransitionText(instId, step as NormalStepDef, state, reason, "reset");
      engine.markPromptDelivered(step.id, instId);

      const resetOk = await executeContextReset(
        client, engine, instId, sessionId,
        transitionText, state.workflow_name, state.current_step,
      );
      if (resetOk) {
        return "已在新的干净会话中重新开始当前步骤。";
      }
      return "重置失败。请稍后重试，或使用 /ralphflow-cancel 取消后再重新启动。";
    },
  });

  // ─── Tool: ralphflow_rewind ──────────────────────────────────────────────────
  //
  // 回退到本工作流里"已通过独立 CHECK"的某个上游步骤重做。与 reset 的区别：
  // reset 重做当前步、状态机不动；rewind 倒退状态机到目标步的 DO 阶段。
  // 如同 reset 一样默认换入干净会话；reason（必填）跨会话注入首条 DO 提示
  // 前并随 idle keep-alive 保留，让新会话冷启动就带着用户给出的"为什么回退"。
  // paused 实例允许 rewind（顺便清暂停 + 归零 fail_count）——这正对应"指示
  // 改完暂停下来后，决定回退到前面更早的一步换个方向重做"的用户旅程。

  const ralphflow_rewind = tool({
    description: "回退到一个在本工作流里已通过独立 CHECK 的上游步骤，重做该步及后续。状态机倒退、fail_count 归零、清除暂停；下游已落盘产物保留（插件不删除）。reason（必填，来自用户）会跨会话注入新会话首条 DO 提示前，并随 idle keep-alive 保留。",
    args: {
      step: tool.schema.string().describe("目标步骤 id——必须是本工作流里已通过独立 CHECK 的上游步骤（用 ralphflow_status 查看）；不能是当前步骤、子工作流复合步骤或未来步骤"),
      reason: tool.schema.string().describe("回退原因（必填，来自用户）：为什么回退、重做时要注意什么。会拼到新会话首条 DO 提示前，必要时会被模型据此决定保留还是覆盖旧产出。"),
      keep_session: tool.schema.boolean().optional().describe("可选，默认 false=换入干净会话（与 /ralphflow-reset 一致）；传 true 时在当前会话继续，仅倒退状态机。"),
      instance: tool.schema.string().optional().describe("实例 id（支持唯一前缀）。仅当本会话有多个实例时需指定。"),
    },
    async execute({ step, reason, keep_session, instance }, context) {
      const sessionId = context.sessionID;

      // ── reason 校验 ────────────────────────────────────────────────────────
      // reason 必填且非空。这是用户旅程的关键：新会话冷启动时，"为什么回退"
      // 是重做方向的唯一指引——空 reason 会让模型毫无方向地重做一遍，白重置。
      if (!reason || !String(reason).trim()) {
        return `回退需要一个原因：为什么回退、重做时要注意什么。请向用户询问（"为什么回退到这一步、这次重做希望注意什么？"），拿到后作为 \`reason\` 参数传入。新会话冷启动时只能靠它知道这次重做的方向。`;
      }
      const reasonStr = String(reason).trim();

      // ── step 必传 ──────────────────────────────────────────────────────────
      if (!step || !String(step).trim()) {
        return "请指定要回退到的目标步骤 `step`。可用 `ralphflow_status` 查看当前进度，再调用本工具传入历史已通过步骤的 id。";
      }
      const targetStepId = String(step).trim();

      const resolution = engine.resolveInstance(instance, sessionId);
      if (!resolution.ok) return resolution.text;
      const instId = resolution.id;
      const attached = resolution.attached;

      const state = engine.readState(instId);
      if (!state || !state.active) return "没有活跃的工作流。使用 ralphflow_start 启动一个。";

      // ── 跨子工作流栈帧回退：第一版不支持 ─────────────────────────────────────
      // 当前若在子工作流里（state stack 非空），target 在哪一栈帧无关——本版本
      // 一律拒绝跨栈帧回退。理由：(1) 跨栈帧回退需要决定弹栈到哪一层、如何
      // 把中间栈帧的进度作废，状态变更面远大于本栈帧回退；(2) 子工作流里的
      // "下游已落盘产物"跨多个栈帧，提示哪一层的产出失效对用户更难解读；
      // (3) 想从子工作流里回到父工作流，更直接的路径是 /ralphflow-cancel +
      // 重新 start。先留白，给清晰错误指向。
      if (engine.readStateStack(instId).length > 0) {
        return `当前实例在子工作流内运行（工作流 \`${state.workflow_name}\`，步骤 \`${state.current_step}\`）。本版本不支持跨子工作流栈帧回退——请先完成或取消该子工作流（\`/ralphflow-continue\` 或 \`/ralphflow-cancel\`），再回退到父工作流的步骤。`;
      }

      // ── CHECK 进行中：拒绝（稍候）──────────────────────────────────────────
      // paused=true 时 current_phase 通常是 "do"（暂停由 max_failures 或
      // check_error 引起，但 check_error 暂停时 phase=="check"——下面分支要补充）。
      if (!state.paused && state.current_phase !== "do") {
        return `当前阶段是 \`${state.current_phase}\`（独立 CHECK 进行中）。回退只能在 DO 阶段或暂停时操作——请稍候验证完成，或运行 \`/ralphflow-cancel\` 放弃。`;
      }
      // check_error 暂停时 phase=="check"，paused==true：此时没活跃验证器，
      // 视作可回退（与 ralphflow_continue 把它视作"清暂停重试"一致）。
      if (state.paused && state.current_phase === "check") {
        // 多见于 verifier 崩溃后留下的 "check" 暂停。允许回退——先清掉所有
        // 可能挂在 check 阶段的标记。下面的状态重写会一并解决。
        if (hasActiveCheck(instId)) {
          return `步骤 \`${state.current_step}\` 的独立验证仍在运行。请稍候完成，或运行 \`/ralphflow-cancel\` 放弃后再回退。`;
        }
      }

      const workflow = engine.loadWorkflow(state.workflow_name);
      if (!workflow) return `工作流 "${state.workflow_name}" 未找到。`;

      // ── 接管/属主校验：拒绝非属主，要求先 /ralphflow-continue 接管 ──────────
      // 与 ralphflow_reset 同构：rewind 同时换干净会话 + 倒退状态机，是两次远跨
      // 的动作，"接管"应作为独立、显式的声明，避免静默侵占其他会话正在用的
      // 实例。attached 即 resolveInstance 读到的 owner !== sessionId，与后面的
      // session_id 比较语义相同——两个条件叠加是防御 resolveInstance 与
      // readState 之间状态漂移的冗余，不是两种不同的校验。
      if (attached || (state.session_id && state.session_id !== sessionId)) {
        return "该实例的属主是另一个会话。只有属主会话可以回退。在当前会话调用 `ralphflow_continue` 接管该实例，再用 `/ralphflow-rewind`。";
      }

      // ── 目标步骤合法性 ──────────────────────────────────────────────────────────
      const targetStep = engine.getStep(workflow, targetStepId);
      if (!targetStep) {
        return `步骤 \`${targetStepId}\` 不在工作流 "${state.workflow_name}" 中。`;
      }
      if (isSubWorkflowStep(targetStep)) {
        return `步骤 \`${targetStepId}\` 是子工作流（复合）步骤，没有 DO/CHECK 阶段，不能回退到它。`;
      }
      if (targetStepId === state.current_step) {
        return `\`${targetStepId}\` 就是当前步骤——重做当前步用 \`/ralphflow-reset\`（不倒退状态机）；rewind 是回退到**上游**已通过步骤。`;
      }
      const passed = engine.passedStepIds(instId, state.workflow_name);
      if (!passed.includes(targetStepId)) {
        const list = passed.length > 0
          ? passed.map((s) => `\`${s}\``).join("、")
          : "（暂无——本工作流还没有步骤通过独立 CHECK）";
        return `只能回退到**本工作流里已通过独立 CHECK**的步骤，\`${targetStepId}\` 不在此列。\n\n本工作流已通过 CHECK 的步骤：${list}\n\n可用 \`/ralphflow-status\` 查看当前进度。`;
      }

      // ── 倒退状态机 ──────────────────────────────────────────────────────────
      const fromStep = state.current_step;
      const wasPaused = state.paused;

      // fail_count 归零 + paused 清除：rewind 与 /ralphflow-continue 走"显式
      // 赦免"的语义对齐——用户主动决定回到方向更早的一步重来，没有"上次没
      // 干到这一步就气数已尽"的包袱。last_failure_reason 同步清：避免
      // buildDoPrompt 把 build 步无关的"propose 失败原因"当成 retryContext，
      // 误导模型以为是 CHECK 重试。
      const newState: RalphFlowState = {
        ...state,
        current_step: targetStepId,
        current_phase: "do",
        fail_count: 0,
        paused: false,
        pause_reason: undefined,
        last_failure_reason: undefined,
      };
      engine.writeState(newState, instId);

      // 清标记：旧 manualGate / manualStep / done 标记在那个 step 的语境下
      // 都和新位置无关；reinject 计数也要清（进入新 phase）。
      engine.clearManualGate(instId);
      engine.clearManualStepMarker(instId);
      engine.clearDoneTagDetected(instId);
      engine.clearReinjectCounter(instId);

      engine.recordStepStart(instId, targetStepId, "do");
      // 与其它所有 DO 阶段入口（start / check 转换 / continue 恢复）一致记
      // step_start——按事件类型过滤日志时，rewind 进入的新 DO 阶段不该缺席。
      engine.logEvent(instId, "info", "step_start", { step: targetStepId, phase: "do" });
      engine.logEvent(instId, "info", "rewind", {
        from: fromStep, to: targetStepId,
        keep_session: !!keep_session, was_paused: !!wasPaused,
      });

      // 目标若是 manual_step：重新布防审查门（和首次进入它一致）。
      if (workflow.manual_step && workflow.manual_step.includes(targetStepId)) {
        engine.writeManualStepMarker(instId);
      }

      // ── 注入文本（含 reason 段）──────────────────────────────────────────────
      // reason 段头里有"下游 ✓ 仅为历史、本次重做"的提示，配合新会话里
      // buildResetBriefing 仍然会画的 ✓ 标记——briefing 显示的是真实历史，
      // 头部点明本次重做，避免模型把下游当已完成不去重做。
      // fromStep 显式传入：newState.current_step 已是目标步，头里的"从哪回退"
      // 只能靠它（否则写成"已从步骤 X 回退到 X"）。
      const transitionText = buildRewindOrResetTransitionText(instId, targetStep as NormalStepDef, newState, reasonStr, "rewind", fromStep);
      engine.markPromptDelivered(targetStepId, instId);

      // ── keep_session：不换会话，工具直接返回注入文本 ───────────────────────
      if (keep_session) {
        // 上层 slash 命令会把这段文本原样投回当前会话（驱动模型开始重做）。
        return wasPaused
          ? `## 已从暂停恢复并回退到步骤 \`${targetStepId}\`\n\n---\n\n${transitionText}`
          : transitionText;
      }

      // ── 默认换会话：复用 reset 门注入路径（不加任何额外的 reason 包装）──
      // kind="rewind"：新会话标题 🔙、旧会话告别语用"回退"措辞——用户执行的
      // 是 rewind，看到的告别不该说"上下文已重置"（两个命令的心智模型不同）。
      const resetOk = await executeContextReset(
        client, engine, instId, sessionId,
        transitionText, state.workflow_name, targetStepId,
        { kind: "rewind" },
      );
      if (resetOk) {
        return wasPaused
          ? `已从暂停恢复，并在新会话回到步骤 \`${targetStepId}\` 重做（原因已随会话带入）。`
          : `已在新会话回到步骤 \`${targetStepId}\` 重做（原因已随会话带入）。`;
      }
      // executeContextReset 失败时 owner 已被锁定为旧会话——状态机已倒退，
      // 但会话没换。不让用户在旧会话空转：明确建议下一动作。
      return `状态机已倒退到步骤 \`${targetStepId}\`，但开新会话失败。建议：稍后用 \`/ralphflow-status\` 确认进度后，在本会话直接重试 \`/ralphflow-rewind\` 并传 \`keep_session: true\`（用当前会话继续），或运行 \`/ralphflow-reset\` 仅重置当前步上下文。`;
    },
  });

  // ─── Tool: ralphflow_cancel ─────────────────────────────────────────────────

  const ralphflow_cancel = tool({
    description: "取消一个工作流实例并清理其状态（可选实例 id，支持唯一前缀）。",
    args: {
      instance: tool.schema.string().optional().describe("实例 id（支持唯一前缀）。仅在取消未绑定到本会话的特定实例时需要。"),
    },
    async execute({ instance }, context) {
      const sessionId = context.sessionID;
      const resolution = engine.resolveInstance(instance, sessionId);
      if (!resolution.ok) return resolution.text;
      const instId = resolution.id;
      const state = engine.readState(instId);
      const workflowName = state ? state.workflow_name : instId;
      const ownedElsewhere = state?.session_id && state.session_id !== sessionId;
      engine.logEvent(instId, "info", "workflow_cancelled", { workflow: workflowName, instance: instId });
      const reportPath = engine.destroyInstance(instId, "cancelled");
      let text = `工作流 "${workflowName}"（实例 \`${instId}\`）已取消。`;
      if (reportPath) text += `\n执行报告：${path.relative(engine.projectDir, reportPath)}`;
      if (ownedElsewhere) text += `\n\n> ⚠️ 该实例的属主是另一个会话。它的下一次 ralphflow_continue 调用会得到"工作流已取消"。`;
      return text;
    },
  });

  // ─── Tool: ralphflow_status ─────────────────────────────────────────────────

  const ralphflow_status = tool({
    description: "显示工作流状态：本会话的实例、指定实例，或所有实例的概览。",
    args: {
      instance: tool.schema.string().optional().describe("实例 id（支持唯一前缀），用于查看特定实例。"),
    },
    async execute({ instance }, context) {
      const sessionId = context.sessionID;
      const instances = engine.listInstances();

      // Pick the instance to detail: explicit > owned by this session.
      let target = null;
      if (instance) {
        const wanted = String(instance).trim();
        const matches = instances.filter((i) => i.id === wanted);
        const prefixMatches = matches.length > 0 ? matches : instances.filter((i) => i.id.startsWith(wanted));
        if (prefixMatches.length === 1) target = prefixMatches[0];
        else if (prefixMatches.length === 0) {
          return instances.length === 0
            ? `没有找到实例 "${wanted}"。当前没有活跃的工作流实例。`
            : `没有找到匹配 "${wanted}" 的实例。\n\n${engine.formatInstanceList(instances)}`;
        } else {
          return `前缀 "${wanted}" 匹配到多个实例：\n\n${engine.formatInstanceList(prefixMatches)}`;
        }
      } else {
        const mine = instances.filter((i) => i.owner === sessionId);
        if (mine.length === 1) target = mine[0];
      }

      if (!target) {
        if (instances.length === 0) {
          return "没有活跃的工作流实例。使用 ralphflow_start 启动一个。";
        }
        return engine.formatInstanceList(instances,
          "查看某个实例详情：`ralphflow_status` 传入 `instance` 参数；接管某个实例：`ralphflow_continue` 传入 `instance` 参数（支持唯一前缀）。");
      }

      const state = target.state;
      const workflow = engine.loadWorkflow(state.workflow_name);
      const currentStep = workflow ? engine.getStep(workflow, state.current_step) : null;

      let status = `## 工作流状态

- **实例**: \`${target.id}\`
- **工作流**: ${state.workflow_name}
- **状态**: ${engine.instanceStatusLabel(target)}
- **当前步骤**: ${state.current_step}
- **当前阶段**: ${state.current_phase}
- **失败次数**: ${state.fail_count}
- **属主会话**: ${target.owner ? (target.owner === sessionId ? "🟢 本会话" : `\`${target.owner.slice(0, 8)}\``) : "无"}
- **最后活动**: ${engine.formatLastActivity(target.lastActivity)}`;

      if (state.last_failure_reason) status += `\n- **上次失败原因**: ${state.last_failure_reason}`;

      if (target.manualGate) {
        status += `\n\n> 📋 该实例正在等待手动审查。审查完成后调用 \`ralphflow_continue\` 进入验证阶段。`;
      } else if (target.owner && target.owner !== sessionId) {
        status += `\n\n> ℹ️ 该实例的属主是另一个会话。调用 \`ralphflow_continue\`（必要时带实例 ID）可在当前会话接管并继续。`;
      }

      if (currentStep) {
        if (isSubWorkflowStep(currentStep)) {
          status += `

## 当前步骤详情

- **描述**: ${currentStep.desc}
- **类型**: 子工作流
- **子工作流**: ${currentStep.workflow}
- **输入**: ${currentStep.inputs ? JSON.stringify(currentStep.inputs) : "无"}
- **最大失败次数**: ${currentStep.max_fail_count}`;
        } else {
          status += `

## 当前步骤详情

- **描述**: ${currentStep.desc}
- **任务**: ${currentStep.do}
- **输入**: ${currentStep.input || "无"}
- **输出**: ${currentStep.output || "无"}
- **检查**: ${Array.isArray(currentStep.check_voting) ? `多验证者投票（${currentStep.check_voting.length} 票）` : currentStep.check || "无"}
- **最大失败次数**: ${currentStep.max_fail_count}`;
        }
      }

      // Multi-voter progress (design §5.4): show per-vote status when in flight.
      if (state.current_phase === "check") {
        const progress = readVotingProgress(engine, target.id);
        if (progress && progress.entries.length > 0) {
          const done = progress.entries.filter((e) => e.status === "passed" || e.status === "failed").length;
          status += `\n\n## 验证进度 (${done}/${progress.entries.length})\n`;
          for (const e of progress.entries) {
            const label = voterStatusLabel(e.status);
            const summary = e.reason.split("\n").find((l) => l.trim())?.trim() ?? "";
            status += `\n- ${label} 验证者 ${e.index + 1}/${progress.entries.length} ${e.check.substring(0, 30)}${e.status === "passed" || e.status === "failed" ? `:${summary.substring(0, 120)}` : ""}`;
          }
        }
      }

      if (instances.length > 1) {
        status += `\n\n> ℹ️ 本目录共有 ${instances.length} 个活跃实例。不带参数的 ralphflow_status 只显示当前会话的实例；传入 instance 参数查看其他实例。`;
      }

      return status;
    },
  });

  // ─── Tool: ralphflow_list ───────────────────────────────────────────────────

  const ralphflow_list = tool({
    description: "列出所有可用的工作流和活跃的工作流实例。",
    args: {},
    async execute() {
      const workflows = engine.listWorkflows();
      let text = workflows.length > 0
        ? `## 可用工作流\n\n${workflows.map((w) => `- **${w.name}**: ${w.desc}`).join("\n")}`
        : "没有找到工作流。请在 .opencode/ralph-flow/workflows/ 目录创建工作流定义文件。";
      const instances = engine.listInstances();
      if (instances.length > 0) {
        text += `\n\n---\n\n${engine.formatInstanceList(instances)}`;
      }
      return text;
    },
  });

  // ─── Tool: ralphflow_doctor ─────────────────────────────────────────────────

  const ralphflow_doctor = tool({
    description: "诊断所有工作流定义（项目 + 插件）：完整的校验错误列表、被静默跳过的步骤、不可达步骤、无法解析的模板记号、损坏的子工作流引用与环、项目/插件遮蔽、被忽略的非工作流 YAML，以及损坏的实例状态。只读。",
    args: {},
    async execute() {
      return engine.buildDoctorReport();
    },
  });

  return {
    ralphflow_start,
    ralphflow_continue,
    ralphflow_reset,
    ralphflow_rewind,
    ralphflow_cancel,
    ralphflow_status,
    ralphflow_list,
    ralphflow_doctor,
  };
}
