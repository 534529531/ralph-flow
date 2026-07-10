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
 * ralphflow_continue is still three phases — validate/transition, run the check
 * (no lock held, so it can't block other tool calls), apply the result — with
 * state existence + workflow/step/phase re-checks guarding races instead of a
 * lock.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { tool } from "@opencode-ai/plugin";
import type { Engine, NormalStepDef, RalphFlowState, WorkflowDef } from "./engine.js";
import { isSubWorkflowStep, MAX_NESTING_DEPTH, MANUAL_GATE_MARKER, DONE_TAG_MARKER } from "./engine.js";
import { adversarialCheck, hasActiveCheck } from "./check.js";

type Client = any;

export function createTools(engine: Engine, client: Client) {
  // ─── Tool: ralphflow_start ──────────────────────────────────────────────────

  const ralphflow_start = tool({
    description: "Start a workflow instance. Provide workflow name and task description. Multiple sessions can each run their own instance in the same project.",
    args: {
      workflow: tool.schema.string().describe("Workflow name (use ralphflow_list to see available workflows)"),
      task: tool.schema.string().describe("Task description - what should be accomplished"),
      extra_dirs: tool.schema.array(tool.schema.string()).optional().describe("Directories OUTSIDE the project that the task's source material lives in (absolute paths or ~/...). The independent CHECK verifier gets read access to them; each must exist or the start is refused."),
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
        return `工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${stepsOverview}\n\n启动子工作流：**${firstStep.id}** → ${firstStep.workflow}${extraDirsNote}${othersNote}\n\n---\n\n${subResult.text}`;
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
      return `工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${stepsOverview}\n\n开始：**${firstStep.id}** - ${firstStep.desc}${extraDirsNote}${othersNote}\n\n---\n\n${engine.buildDoPrompt(instId, firstStep, task)}`;
    },
  });

  // ─── Tool: ralphflow_continue ───────────────────────────────────────────────

  type Phase1 =
    | { type: "early"; text: string }
    | { type: "continue"; step: NormalStepDef; state: RalphFlowState; workflow: WorkflowDef; instId: string; checkPrompt: string };

  const ralphflow_continue = tool({
    description: "Signal DO phase complete. Runs independent verification via a separate session and advances the workflow. Also resumes paused workflows and attaches to interrupted instances (optional instance id, unique prefix allowed).",
    args: {
      instance: tool.schema.string().optional().describe("Instance id (unique prefix allowed). Only needed to attach to a specific instance from a new session."),
    },
    async execute({ instance }, context) {
      const sessionId = context.sessionID;

      // Phase 1: resolve instance, validate, handle pause resume, transition to check.
      const phase1: Phase1 = (() => {
        const resolution = engine.resolveInstance(instance, sessionId);
        if (!resolution.ok) return { type: "early", text: resolution.text };
        const instId = resolution.id;
        const attached = resolution.attached;
        // One session drives at most one instance: refuse a takeover while this
        // session still owns a different active instance.
        if (attached) {
          const other = engine.listInstances().find((i) => i.id !== instId && i.owner === sessionId);
          if (other) {
            return { type: "early", text: `当前会话已有活跃工作流实例 \`${other.id}\`（工作流: ${other.state.workflow_name}，步骤: ${other.state.current_step}）。一个会话同时只能驱动一个实例——请先完成或取消它，或在另一个会话中接管 \`${instId}\`。` };
          }
        }
        // Claim ownership for this session (updates state.session_id).
        engine.bindInstance(instId, sessionId);

        let state = engine.readState(instId);
        if (!state || !state.active) {
          return { type: "early", text: "没有活跃的工作流。使用 ralphflow_start 启动一个。" };
        }

        const workflow = engine.loadWorkflow(state.workflow_name);
        if (!workflow) {
          return { type: "early", text: `工作流 "${state.workflow_name}" 未找到。` };
        }

        // Paused because the VERIFIER couldn't run — resume by re-running only
        // the check (the work is finished and untouched).
        if (state.paused && state.pause_reason === "check_error" && state.current_phase === "check") {
          const step = engine.getStep(workflow, state.current_step);
          if (step && !isSubWorkflowStep(step)) {
            const resumedState = { ...state, paused: false, pause_reason: undefined };
            engine.writeState(resumedState, instId);
            engine.logEvent(instId, "info", "check_retry_after_infra_error", { workflow: state.workflow_name, step: step.id });
            engine.recordStepStart(instId, state.current_step, "check");
            return { type: "continue", step, state: resumedState, workflow, instId, checkPrompt: engine.buildCheckPrompt(instId, step, resumedState.user_task) };
          }
        }

        // Handle paused state (max_failures / config_error / session_*): reset
        // fail_count and retry, keeping the failure reason as DO-prompt context.
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
            return { type: "early", text: `已恢复。当前步骤：${state.current_step}` };
          }

          if (isSubWorkflowStep(step)) {
            engine.recordStepStart(instId, step.id, "do");
            engine.logEvent(instId, "info", "step_start", { step: step.id, phase: "do" });
            const staleTop = engine.popState(instId);
            if (staleTop && !(staleTop.workflow_name === state.workflow_name && staleTop.current_step === state.current_step)) {
              engine.pushState(staleTop, instId);
            }
            engine.pushState({ ...state, current_step: step.id, current_phase: "do", fail_count: 0, paused: false, pause_reason: undefined }, instId);
            const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step, MAX_NESTING_DEPTH, previousReason, previousFailCount);
            if (subResult.error) {
              engine.popState(instId);
              engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
              return { type: "early", text: subResult.text };
            }
            engine.markPromptDelivered(engine.readState(instId)?.current_step || step.id, instId);
            let resumeMsg = `## 工作流已恢复\n\n之前尝试次数：${previousFailCount}`;
            if (previousReason) resumeMsg += `\n\n### 上次失败原因\n${previousReason}`;
            resumeMsg += "\n\n---\n\n";
            return { type: "early", text: resumeMsg + `重新进入子工作流：**${step.id}**\n\n---\n\n${subResult.text}` };
          }

          if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
            engine.writeManualStepMarker(instId);
          }
          const doPrompt = engine.buildDoPrompt(instId, step, state.user_task, previousReason, previousFailCount);
          engine.markPromptDelivered(step.id, instId);
          return { type: "early", text: `## 工作流已恢复\n\n---\n\n${doPrompt}` };
        }

        // Must be in "do" phase.
        if (state.current_phase !== "do") {
          if (state.current_phase === "check") {
            if (hasActiveCheck(instId)) {
              engine.logEvent(instId, "info", "crash_recovery_skipped", { step: state.current_step, message: "Adversarial check still running, skipping crash recovery" });
              return { type: "early", text: `## ⏳ 验证进行中\n\n步骤 **${state.current_step}** 的对抗性检查仍在运行。\n\n请等待完成，或使用 \`/ralphflow-cancel\` 取消工作流。` };
            }
            engine.clearAdversarialSession(instId);
            engine.logEvent(instId, "warn", "crash_recovery", { step: state.current_step, message: "State stuck in check phase, resetting to do and returning DO prompt" });
            state = { ...state, current_phase: "do" };
            engine.writeState(state, instId);
            engine.clearReinjectCounter(instId);
            engine.clearManualStepMarker(instId);
            engine.clearManualGate(instId);
            engine.clearDoneTagDetected(instId);
            const step = engine.getStep(workflow, state.current_step);
            if (!step) {
              return { type: "early", text: `崩溃恢复：步骤 "${state.current_step}" 在工作流中未找到。` };
            }
            if (isSubWorkflowStep(step)) {
              return { type: "early", text: `崩溃恢复：步骤 "${step.id}" 是子工作流步骤。调用 \`ralphflow_continue\` 重新进入。` };
            }
            if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
              engine.writeManualStepMarker(instId);
            }
            const prompt = engine.buildDoPrompt(instId, step, state.user_task, "之前的验证被中断（进程崩溃）。请重新执行任务。", state.fail_count || 0);
            engine.markPromptDelivered(step.id, instId);
            return { type: "early", text: `## ⚠️ 崩溃恢复\n\n进程在验证期间崩溃。DO 阶段已重置。\n\n---\n\n${prompt}` };
          }
          return { type: "early", text: `当前阶段是 "${state.current_phase}"，不是 "do"。工作流已在处理中。` };
        }

        const step = engine.getStep(workflow, state.current_step);
        if (!step) return { type: "early", text: `步骤 "${state.current_step}" 未找到。` };
        if (isSubWorkflowStep(step)) {
          return { type: "early", text: `步骤 "${step.id}" 是子工作流步骤。已自动处理。` };
        }

        // Attach semantics: taking over an instance that died MID-DO (no done
        // tag, no manual gate) means the work may be unfinished — re-issue the
        // DO prompt instead of running a doomed check.
        if (attached && !engine.markerExists(DONE_TAG_MARKER, instId) && !engine.markerExists(MANUAL_GATE_MARKER, instId)) {
          if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
            engine.writeManualStepMarker(instId);
          }
          const prompt = engine.buildDoPrompt(instId, step, state.user_task, state.last_failure_reason, state.fail_count || 0);
          engine.markPromptDelivered(step.id, instId);
          engine.logEvent(instId, "info", "instance_attached_resume_do", { instance: instId, step: step.id });
          return { type: "early", text: `## 已接管工作流实例 \`${instId}\`\n\n该实例中断于 DO 阶段，继续执行当前步骤。\n\n---\n\n${prompt}` };
        }

        // Record DO completion, transition to check. For manual steps this
        // point is only reached via the user's explicit ralphflow_continue.
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

        return { type: "continue", step, state, workflow, instId, checkPrompt: engine.buildCheckPrompt(instId, step, state.user_task) };
      })();

      if (phase1.type === "early") return phase1.text;

      // Phase 2: run the independent check. NO lock is held here — the check
      // drives a whole verifier session and must never block other tool calls.
      // Surface live progress on the tool call itself (opencode's native
      // mechanism) so the user isn't staring at a silent spinner for ~1 min.
      const setTitle = (t: string) => { try { context.metadata?.({ title: t }); } catch {} };
      let checkResult;
      try {
        // Re-verify the instance is still in the same check state (a concurrent
        // continue crash-recovery or a cancel may have moved on).
        const preCheckState = engine.readState(phase1.instId);
        if (!preCheckState || !preCheckState.active || preCheckState.current_phase !== "check"
            || preCheckState.workflow_name !== phase1.state.workflow_name
            || preCheckState.current_step !== phase1.state.current_step) {
          return "工作流在验证开始前已被取消或更改。";
        }
        setTitle(`🔍 独立验证中：${phase1.step.id}（只读会话）`);
        checkResult = await adversarialCheck(client, engine, phase1.instId, sessionId, phase1.step, phase1.checkPrompt, phase1.state.user_task, phase1.workflow.adversarial_check);
        setTitle(checkResult.infra ? `⚠️ 验证未能运行：${phase1.step.id}` : (checkResult.passed ? `✓ 验证通过：${phase1.step.id}` : `✗ 验证未过：${phase1.step.id}`));
      } catch (err: any) {
        setTitle(`⚠️ 验证异常：${phase1.step.id}`);
        engine.logEvent(phase1.instId, "error", "adversarial_check_uncaught", { stepId: phase1.step.id, error: err.message });
        const failureReason = `对抗性检查崩溃：${err.message}`;
        const st = engine.readState(phase1.instId);
        if (st && st.active && st.current_phase === "check"
            && st.workflow_name === phase1.state.workflow_name && st.current_step === phase1.state.current_step) {
          engine.writeState({ ...st, paused: true, pause_reason: "check_error", last_failure_reason: failureReason }, phase1.instId);
          engine.logEvent(phase1.instId, "warn", "workflow_paused", { workflow: st.workflow_name, step: st.current_step, reason: "adversarial_check_crash" });
          return `## ⚠️ 验证未能运行\n\n${failureReason}\n\n工作流已暂停。这不计入失败次数，已完成的工作保持原样。请把此情况告知用户；问题解决后调用 \`ralphflow_continue\` 直接重新运行验证。`;
        }
        return `验证因意外错误失败：${err.message}。该实例的状态已在验证期间被更改或清除。`;
      }

      // Phase 3: apply the check result. Re-check state to guard against a
      // concurrent cancel/continue during the unlocked Phase 2.
      const currentState = engine.readState(phase1.instId);
      if (!currentState || !currentState.active) {
        return "工作流在验证期间已被取消。";
      }
      if (currentState.workflow_name !== phase1.state.workflow_name || currentState.current_step !== phase1.state.current_step) {
        engine.logEvent(phase1.instId, "warn", "workflow_changed_during_check", { old_workflow: phase1.state.workflow_name, old_step: phase1.state.current_step, new_workflow: currentState.workflow_name, new_step: currentState.current_step });
        return "工作流在验证期间已更改。检查结果已丢弃。";
      }
      if (currentState.current_phase !== "check") {
        engine.logEvent(phase1.instId, "warn", "phase_changed_during_check", { expected: "check", actual: currentState.current_phase });
        return "阶段在验证期间已更改（已被另一个调用处理）。检查结果已丢弃。";
      }

      // Infrastructure failure: the verifier never produced a verdict. Do NOT
      // count it as a step failure and do NOT redo finished work — pause in the
      // check phase so a later ralphflow_continue re-runs ONLY the check.
      if (checkResult.infra) {
        engine.writeState({ ...currentState, paused: true, pause_reason: "check_error", last_failure_reason: checkResult.reason }, phase1.instId);
        engine.logEvent(phase1.instId, "warn", "workflow_paused", { workflow: currentState.workflow_name, step: currentState.current_step, reason: "check_infra_error", detail: checkResult.reason.substring(0, 300) });
        return `## ⚠️ 验证未能运行\n\n${checkResult.reason}\n\n---\n\n## 工作流已暂停\n\n这是验证进程自身的问题（额度限制 / API 错误 / 超时），**不是**工作成果的问题：\n- 本次不计入失败次数（当前 ${currentState.fail_count || 0}/${phase1.step.max_fail_count || "∞"}）\n- 已完成的工作保持原样，恢复后**不需要重做**\n\n请把此情况告知用户。待问题解决后（如额度恢复），调用 \`ralphflow_continue\` 将直接重新运行验证。`;
      }

      const recordFailCount = currentState.fail_count || 0;
      engine.addStepRecord(phase1.instId, currentState.current_step, "check", checkResult.passed ? "passed" : "failed", recordFailCount, checkResult.reason);

      const result = checkResult.passed
        ? engine.handleCheckPassed(phase1.instId, currentState, phase1.workflow, phase1.step, checkResult)
        : engine.handleCheckFailed(phase1.instId, currentState, phase1.workflow, phase1.step, checkResult);

      // The workflow completed — instance dir is gone, nothing more to update.
      if (result.completed) return result.text;

      // After a transition that leaves the workflow in DO phase, the response
      // already contains the next DO prompt — set the driver dedup markers and
      // arm the manual marker when the new current step is manual.
      const updatedState = engine.readState(phase1.instId);
      if (updatedState && updatedState.active && !updatedState.paused && updatedState.current_phase === "do") {
        engine.clearDoneTagDetected(phase1.instId);
        engine.clearManualGate(phase1.instId);
        engine.markPromptDelivered(updatedState.current_step, phase1.instId);
        const currentWorkflow = updatedState.workflow_name === phase1.workflow.name
          ? phase1.workflow
          : engine.loadWorkflow(updatedState.workflow_name);
        if (currentWorkflow && currentWorkflow.manual_step && currentWorkflow.manual_step.includes(updatedState.current_step)) {
          engine.writeManualStepMarker(phase1.instId);
        }
      }

      return result.text;
    },
  });

  // ─── Tool: ralphflow_cancel ─────────────────────────────────────────────────

  const ralphflow_cancel = tool({
    description: "Cancel a workflow instance and clean up its state (optional instance id, unique prefix allowed).",
    args: {
      instance: tool.schema.string().optional().describe("Instance id (unique prefix allowed). Only needed to cancel a specific instance not bound to this session."),
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
    description: "Show workflow status: the current session's instance, a specific instance, or an overview of all instances.",
    args: {
      instance: tool.schema.string().optional().describe("Instance id (unique prefix allowed) to inspect a specific instance."),
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
- **检查**: ${currentStep.check}
- **最大失败次数**: ${currentStep.max_fail_count}`;
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
    description: "List all available workflows and active workflow instances.",
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
    description: "Diagnose all workflow definitions (project + plugin): validation errors with full reason lists, silently-skipped steps, unreachable steps, unresolvable template tokens, broken sub-workflow references and cycles, project/plugin shadowing, ignored non-workflow YAML files, and corrupt instance state. Read-only.",
    args: {},
    async execute() {
      return engine.buildDoctorReport();
    },
  });

  return {
    ralphflow_start,
    ralphflow_continue,
    ralphflow_cancel,
    ralphflow_status,
    ralphflow_list,
    ralphflow_doctor,
  };
}
