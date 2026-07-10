/**
 * Ralph Flow tools — opencode adapter, structural mirror of the Claude Code
 * plugin's MCP tool section (server.mjs "Tool: ralphflow_*" blocks).
 *
 * Tool names use the SAME underscore names as the Claude MCP tools
 * (ralphflow_start, ralphflow_continue, …) so the behavior rules, workflow
 * texts and docs stay word-for-word portable between the two plugins.
 *
 * Differences from the Claude version (see SYNC.md):
 * - context.sessionID replaces the ppid-based getMySessionId(); the
 *   PostToolUse owner-binding hook and the "[instance: id]" response marker
 *   are unnecessary and dropped.
 * - The CHECK prompt is built inside the phase-1 lock (one plugin process
 *   serves many sessions; the implicit instance binding must not be trusted
 *   outside a lock).
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
      return engine.withLock(async () => {
        engine.beginOp(context.sessionID);
        // Refuse if this session already runs an active instance.
        const instances = engine.listInstances();
        const mySession = engine.getMySessionId();
        let mine = null;
        const boundId = engine.getBoundInstance();
        if (boundId) {
          const bound = instances.find((i) => i.id === boundId);
          if (!bound) {
            engine.setBoundInstance(null); // completed/cancelled
          } else if (bound.owner && mySession && bound.owner !== mySession && engine.isSessionAlive(bound.owner)) {
            engine.setBoundInstance(null); // explicitly taken over by another live session
          } else {
            mine = bound;
          }
        }
        if (!mine && mySession) {
          mine = instances.find((i) => i.owner === mySession) || null;
        }
        if (mine) {
          return `当前会话已有活跃工作流实例 \`${mine.id}\`（工作流: ${mine.state.workflow_name}，步骤: ${mine.state.current_step}）。\n\n使用 /ralphflow-continue 继续，或先用 /ralphflow-cancel 取消。`;
        }

        const workflowProblems: string[] = [];
        const workflowDef = engine.loadWorkflow(workflow, workflowProblems);
        if (!workflowDef) {
          // The file exists but failed validation — say WHY instead of the
          // self-contradictory "未找到 + 可用工作流列表里有它".
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

        // Validate extra_dirs before creating anything: a bad path must fail
        // loudly now, not as a mysterious CHECK failure minutes later.
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

        // Create and bind a fresh instance
        const instId = engine.generateInstanceId(workflow);
        fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
        engine.writeArtifactsDirName(instId, task);
        engine.writeExtraDirs(instId, resolvedExtraDirs);
        engine.setBoundInstance(instId);

        const othersNote = instances.length > 0
          ? `\n\n> ℹ️ 本目录下另有 ${instances.length} 个工作流实例，使用 /ralphflow-status 查看。`
          : "";
        const extraDirsNote = resolvedExtraDirs.length > 0
          ? `\n\n验证器额外可读目录：${resolvedExtraDirs.map((d) => `\`${d}\``).join("、")}`
          : "";

        if (isSubWorkflowStep(firstStep)) {
          engine.recordStepStart(firstStep.id, "do");
          engine.logEvent("info", "step_start", { step: firstStep.id, phase: "do" });
          engine.pushState({ active: true, workflow_name: workflow, current_step: firstStep.id, current_phase: "do", fail_count: 0, user_task: task, paused: false }, instId);
          const subResult = engine.resolveSubWorkflowEntry(firstStep.workflow, task, firstStep);
          if (subResult.error) {
            // Discard the never-started instance quietly (no report archive)
            try { fs.rmSync(engine.getInstanceDir(instId), { recursive: true, force: true }); } catch {}
            engine.setBoundInstance(null);
            return subResult.text;
          }
          engine.bindInstance(instId);
          engine.markPromptDelivered(engine.readState()?.current_step || firstStep.id);
          engine.logEvent("info", "workflow_start", { workflow, instance: instId });
          const stepsOverview = workflowDef.steps.map((s, i) => `  ${i + 1}. **${s.id}**: ${s.desc}${isSubWorkflowStep(s) ? ` (子工作流: ${s.workflow})` : ""}`).join("\n");
          return `工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${stepsOverview}\n\n启动子工作流：**${firstStep.id}** → ${firstStep.workflow}${extraDirsNote}${othersNote}\n\n---\n\n${subResult.text}`;
        }

        engine.writeState({ active: true, workflow_name: workflow, current_step: firstStep.id, current_phase: "do", fail_count: 0, user_task: task, paused: false }, instId);
        engine.bindInstance(instId);
        engine.logEvent("info", "workflow_start", { workflow, instance: instId });
        engine.recordStepStart(firstStep.id, "do");
        engine.logEvent("info", "step_start", { step: firstStep.id, phase: "do" });
        // Mark manual steps so the driver stops the session for user review on DO completion
        if (workflowDef.manual_step && workflowDef.manual_step.includes(firstStep.id)) {
          engine.writeManualStepMarker();
        }
        engine.markPromptDelivered(firstStep.id);
        const stepsOverview = workflowDef.steps.map((s, i) => `  ${i + 1}. **${s.id}**: ${s.desc}${isSubWorkflowStep(s) ? ` (子工作流: ${s.workflow})` : ""}`).join("\n");
        return `工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${stepsOverview}\n\n开始：**${firstStep.id}** - ${firstStep.desc}${extraDirsNote}${othersNote}\n\n---\n\n${engine.buildDoPrompt(firstStep, task)}`;
      });
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
      // Phase 1 (withLock): resolve instance, validate, handle pause resume,
      // transition to "check" phase
      const phase1: Phase1 = await engine.withLock(async () => {
        engine.beginOp(context.sessionID);
        const resolution = engine.resolveInstance(instance);
        if (!resolution.ok) {
          return { type: "early" as const, text: resolution.text };
        }
        const instId = resolution.id;
        const attached = resolution.attached;
        // One session drives at most one instance: refuse an explicit takeover
        // while this session still has a different active instance.
        if (attached) {
          const mySession = engine.getMySessionId();
          const boundId = engine.getBoundInstance();
          const other = engine.listInstances().find((i) => i.id !== instId &&
            ((boundId && i.id === boundId) || (mySession && i.owner === mySession)));
          if (other) {
            return { type: "early" as const, text: `当前会话已有活跃工作流实例 \`${other.id}\`（工作流: ${other.state.workflow_name}，步骤: ${other.state.current_step}）。一个会话同时只能驱动一个实例——请先完成或取消它，或在另一个会话中接管 \`${instId}\`。` };
          }
        }
        engine.bindInstance(instId);

        try {
          return await engine.withInstanceLock(instId, async (): Promise<Phase1> => {
            let state = engine.readState();
            if (!state || !state.active) {
              return { type: "early", text: "没有活跃的工作流。使用 ralphflow_start 启动一个。" };
            }

            const workflow = engine.loadWorkflow(state.workflow_name);
            if (!workflow) {
              return { type: "early", text: `工作流 "${state.workflow_name}" 未找到。` };
            }

            // Paused because the VERIFIER couldn't run (API error / timeout /
            // crash) — the work itself is finished and untouched, so resume by
            // re-running only the check. Falls through to the generic paused
            // handling if the state isn't actually sitting in check phase.
            if (state.paused && state.pause_reason === "check_error" && state.current_phase === "check") {
              const step = engine.getStep(workflow, state.current_step);
              if (step && !isSubWorkflowStep(step)) {
                const resumedState = { ...state, paused: false, pause_reason: undefined };
                engine.writeState(resumedState);
                engine.logEvent("info", "check_retry_after_infra_error", { workflow: state.workflow_name, step: step.id });
                engine.recordStepStart(state.current_step, "check");
                return { type: "continue", step, state: resumedState, workflow, instId, checkPrompt: engine.buildCheckPrompt(step, resumedState.user_task) };
              }
            }

            // Handle paused state (max_failures / config_error / session_*):
            // reset fail_count and retry (fresh start after manual intervention).
            // Preserve failure reason as context for the DO prompt.
            if (state.paused) {
              const previousFailCount = state.fail_count;
              const previousReason = state.last_failure_reason;
              engine.clearReinjectCounter();
              // A fresh retry starts now — done/gate markers from the failed
              // attempt are stale and would mis-route the driver.
              engine.clearDoneTagDetected();
              engine.clearManualGate();
              engine.writeState({ ...state, current_phase: "do", paused: false, pause_reason: undefined, fail_count: 0 });
              engine.logEvent("info", "workflow_resumed", { workflow: state.workflow_name, step: state.current_step });

              const step = engine.getStep(workflow, state.current_step);
              if (!step) {
                return { type: "early", text: `已恢复。当前步骤：${state.current_step}` };
              }

              // Re-enter sub-workflow step on resume
              if (isSubWorkflowStep(step)) {
                engine.recordStepStart(step.id, "do");
                engine.logEvent("info", "step_start", { step: step.id, phase: "do" });
                // The pause paths push the parent state back onto the stack so
                // the nesting survives cancel/restore. Drop that stale copy
                // before pushing a fresh one — otherwise the stack
                // double-counts the parent and a later on_pass:"done" pops the
                // stale copy and re-runs already-finished parent steps.
                const staleTop = engine.popState();
                if (staleTop && !(staleTop.workflow_name === state.workflow_name && staleTop.current_step === state.current_step)) {
                  engine.pushState(staleTop); // not the pause-time copy — put it back
                }
                engine.pushState({ ...state, current_step: step.id, current_phase: "do", fail_count: 0, paused: false, pause_reason: undefined });
                const subResult = engine.resolveSubWorkflowEntry(step.workflow, state.user_task, step, MAX_NESTING_DEPTH, previousReason, previousFailCount);
                if (subResult.error) {
                  engine.popState();
                  engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text });
                  return { type: "early", text: subResult.text };
                }
                engine.markPromptDelivered(engine.readState()?.current_step || step.id);
                let resumeMsg = `## 工作流已恢复\n\n之前尝试次数：${previousFailCount}`;
                if (previousReason) resumeMsg += `\n\n### 上次失败原因\n${previousReason}`;
                resumeMsg += "\n\n---\n\n";
                return { type: "early", text: resumeMsg + `重新进入子工作流：**${step.id}**\n\n---\n\n${subResult.text}` };
              }

              // If retrying a manual step, re-arm the marker
              if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
                engine.writeManualStepMarker();
              }
              const doPrompt = engine.buildDoPrompt(step, state.user_task, previousReason, previousFailCount);
              engine.markPromptDelivered(step.id);
              return { type: "early", text: `## 工作流已恢复\n\n---\n\n${doPrompt}` };
            }

            // Validate phase: must be in "do" phase
            if (state.current_phase !== "do") {
              // Crash recovery: if stuck in "check" phase (process crashed
              // during verification), reset to "do" and return DO prompt so
              // the work can be re-verified
              if (state.current_phase === "check") {
                // If an adversarial check is still running in this process,
                // don't reset. (A check owned by another process can't be
                // detected here — the Claude version checks the pid file.)
                if (hasActiveCheck(instId)) {
                  engine.logEvent("info", "crash_recovery_skipped", { step: state.current_step, message: "Adversarial check still running, skipping crash recovery" });
                  return { type: "early", text: `## ⏳ 验证进行中\n\n步骤 **${state.current_step}** 的对抗性检查仍在运行。\n\n请等待完成，或使用 \`/ralphflow-cancel\` 取消工作流。` };
                }
                engine.clearAdversarialSession();
                engine.logEvent("warn", "crash_recovery", { step: state.current_step, message: "State stuck in check phase, resetting to do and returning DO prompt" });
                state = { ...state, current_phase: "do" };
                engine.writeState(state);
                engine.clearReinjectCounter();
                engine.clearManualStepMarker();
                engine.clearManualGate();
                engine.clearDoneTagDetected();
                const step = engine.getStep(workflow, state.current_step);
                if (!step) {
                  return { type: "early", text: `崩溃恢复：步骤 "${state.current_step}" 在工作流中未找到。` };
                }
                if (isSubWorkflowStep(step)) {
                  return { type: "early", text: `崩溃恢复：步骤 "${step.id}" 是子工作流步骤。调用 \`ralphflow_continue\` 重新进入。` };
                }
                // Re-arm the manual marker when the recovered step is manual
                if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
                  engine.writeManualStepMarker();
                }
                const prompt = engine.buildDoPrompt(step, state.user_task, "之前的验证被中断（进程崩溃）。请重新执行任务。", state.fail_count || 0);
                engine.markPromptDelivered(step.id);
                return { type: "early", text: `## ⚠️ 崩溃恢复\n\n进程在验证期间崩溃。DO 阶段已重置。\n\n---\n\n${prompt}` };
              } else {
                return { type: "early", text: `当前阶段是 "${state.current_phase}"，不是 "do"。工作流已在处理中。` };
              }
            }

            const step = engine.getStep(workflow, state.current_step);
            if (!step) return { type: "early", text: `步骤 "${state.current_step}" 未找到。` };
            if (isSubWorkflowStep(step)) {
              return { type: "early", text: `步骤 "${step.id}" 是子工作流步骤。已自动处理。` };
            }

            // Attach semantics: taking over an instance that died MID-DO (no
            // done tag, no manual gate) means the work may be unfinished —
            // re-issue the DO prompt instead of running a check that would
            // inevitably fail.
            if (attached && !engine.markerExists(DONE_TAG_MARKER) && !engine.markerExists(MANUAL_GATE_MARKER)) {
              if (workflow.manual_step && workflow.manual_step.includes(step.id)) {
                engine.writeManualStepMarker();
              }
              const prompt = engine.buildDoPrompt(step, state.user_task, state.last_failure_reason, state.fail_count || 0);
              engine.markPromptDelivered(step.id);
              engine.logEvent("info", "instance_attached_resume_do", { instance: instId, step: step.id });
              return { type: "early", text: `## 已接管工作流实例 \`${instId}\`\n\n该实例中断于 DO 阶段，继续执行当前步骤。\n\n---\n\n${prompt}` };
            }

            // Record DO completion, transition to check.
            // For manual steps this point is only reached via the user's
            // explicit ralphflow_continue — that call IS the review approval.
            engine.logEvent("info", "done_detected", { step: state.current_step });
            engine.addStepRecord(state.current_step, "do", "passed", 0);
            engine.clearManualStepMarker();
            engine.clearManualGate();
            engine.clearReinjectCounter();
            engine.clearDoPromptCache();
            engine.clearDoneTagDetected();
            engine.writeState({ ...state, current_phase: "check" });
            engine.recordStepStart(state.current_step, "check");
            engine.logEvent("info", "step_start", { step: state.current_step, phase: "check" });

            return { type: "continue", step, state, workflow, instId, checkPrompt: engine.buildCheckPrompt(step, state.user_task) };
          });
        } catch (err: any) {
          if (err && err.code === "INSTANCE_GONE") {
            if (engine.getBoundInstance() === instId) engine.setBoundInstance(null);
            return { type: "early" as const, text: "该工作流实例已被取消或完成。" };
          }
          throw err;
        }
      });

      if (phase1.type === "early") {
        return phase1.text;
      }

      // Phase 2: run adversarial check — locks are held only for the pre-check
      // validation, then released so cancel/start can proceed during the
      // long-running verification.
      let checkResult;
      try {
        // Verify workflow is still active before starting the check session.
        // Use a short lock to prevent a concurrent ralphflow_continue from
        // resetting the state from "check" to "do" (crash recovery) between
        // our pre-check and the check start.
        const preCheckOk = await engine.withLock(async () => {
          const preCheckState = engine.readState(phase1.instId);
          if (!preCheckState || !preCheckState.active || preCheckState.current_phase !== "check"
              || preCheckState.workflow_name !== phase1.state.workflow_name
              || preCheckState.current_step !== phase1.state.current_step) {
            return false;
          }
          return true;
        });
        if (!preCheckOk) {
          return "工作流在验证开始前已被取消或更改。";
        }
        checkResult = await adversarialCheck(client, engine, phase1.instId, context.sessionID, phase1.step, phase1.checkPrompt, phase1.state.user_task, phase1.workflow.adversarial_check);
      } catch (err: any) {
        engine.logEvent("error", "adversarial_check_uncaught", { stepId: phase1.step.id, error: err.message });
        // An engine-side crash is an infrastructure failure, not a work
        // failure: pause in the check phase (no fail_count increment) so a
        // later ralphflow_continue re-runs only the verification.
        return engine.withLock(async () => {
          const failureReason = `对抗性检查崩溃：${err.message}`;
          const st = engine.readState(phase1.instId);
          if (st && st.active && st.current_phase === "check"
              && st.workflow_name === phase1.state.workflow_name && st.current_step === phase1.state.current_step) {
            engine.writeState({ ...st, paused: true, pause_reason: "check_error", last_failure_reason: failureReason }, phase1.instId);
            engine.logEvent("warn", "workflow_paused", { workflow: st.workflow_name, step: st.current_step, reason: "adversarial_check_crash" });
            return `## ⚠️ 验证未能运行\n\n${failureReason}\n\n工作流已暂停。这不计入失败次数，已完成的工作保持原样。请把此情况告知用户；问题解决后调用 \`ralphflow_continue\` 直接重新运行验证。`;
          }
          return `验证因意外错误失败：${err.message}。该实例的状态已在验证期间被更改或清除。`;
        });
      }

      // Phase 3 (withLock + instance lock): read state, update with check results
      return engine.withLock(async () => {
        engine.beginOp(context.sessionID);
        try {
          return await engine.withInstanceLock(phase1.instId, async () => {
            // handleCheckPassed/Failed mutate state through implicit-bound
            // helpers — if a parallel tool call re-bound this session to
            // another instance during the unlocked Phase 2, applying the
            // result would write into the WRONG instance. Discard instead.
            if (engine.getBoundInstance() !== phase1.instId) {
              engine.logEvent("warn", "binding_changed_during_check", { expected: phase1.instId, actual: engine.getBoundInstance() });
              return "工作流绑定在验证期间已更改。检查结果已丢弃。";
            }
            const currentState = engine.readState(phase1.instId);
            if (!currentState || !currentState.active) {
              return "工作流在验证期间已被取消。";
            }
            // Verify we're still working on the same workflow and step
            if (currentState.workflow_name !== phase1.state.workflow_name || currentState.current_step !== phase1.state.current_step) {
              engine.logEvent("warn", "workflow_changed_during_check", { old_workflow: phase1.state.workflow_name, old_step: phase1.state.current_step, new_workflow: currentState.workflow_name, new_step: currentState.current_step });
              return "工作流在验证期间已更改。检查结果已丢弃。";
            }
            // Verify we're still in check phase (another ralphflow_continue
            // may have already processed results)
            if (currentState.current_phase !== "check") {
              engine.logEvent("warn", "phase_changed_during_check", { expected: "check", actual: currentState.current_phase });
              return "阶段在验证期间已更改（已被另一个调用处理）。检查结果已丢弃。";
            }

            // Infrastructure failure (API error / timeout / session-create
            // failure): the verifier never produced a verdict, so this says
            // nothing about the quality of the work. Do NOT count it as a step
            // failure and do NOT send the DO agent back to redo finished work —
            // pause in the check phase so a later ralphflow_continue re-runs
            // ONLY the check.
            if (checkResult.infra) {
              engine.writeState({ ...currentState, paused: true, pause_reason: "check_error", last_failure_reason: checkResult.reason }, phase1.instId);
              engine.logEvent("warn", "workflow_paused", { workflow: currentState.workflow_name, step: currentState.current_step, reason: "check_infra_error", detail: checkResult.reason.substring(0, 300) });
              return `## ⚠️ 验证未能运行\n\n${checkResult.reason}\n\n---\n\n## 工作流已暂停\n\n这是验证进程自身的问题（额度限制 / API 错误 / 超时），**不是**工作成果的问题：\n- 本次不计入失败次数（当前 ${currentState.fail_count || 0}/${phase1.step.max_fail_count || "∞"}）\n- 已完成的工作保持原样，恢复后**不需要重做**\n\n请把此情况告知用户。待问题解决后（如额度恢复），调用 \`ralphflow_continue\` 将直接重新运行验证。`;
            }

            const recordFailCount = currentState.fail_count || 0;
            engine.addStepRecord(currentState.current_step, "check", checkResult.passed ? "passed" : "failed", recordFailCount, checkResult.reason);

            const result = checkResult.passed
              ? engine.handleCheckPassed(currentState, phase1.workflow, phase1.step, checkResult)
              : engine.handleCheckFailed(currentState, phase1.workflow, phase1.step, checkResult);

            // The workflow completed — instance dir is gone, nothing more to update.
            if (result.completed) return result.text;

            // After any transition that leaves the workflow running in DO
            // phase, the tool response above already contains the next DO
            // prompt — set the driver dedup markers so it doesn't inject a
            // duplicate, and arm the manual marker when the new current step
            // is manual (using the workflow that actually owns that step,
            // which may be a sub-workflow rather than phase1.workflow).
            const updatedState = engine.readState();
            if (updatedState && updatedState.active && !updatedState.paused && updatedState.current_phase === "do") {
              // A done tag emitted for the previous step is stale for the new
              // DO phase; without clearing it the driver would instruct the
              // model to skip the new step's work entirely.
              engine.clearDoneTagDetected();
              engine.clearManualGate();
              engine.markPromptDelivered(updatedState.current_step);
              const currentWorkflow = updatedState.workflow_name === phase1.workflow.name
                ? phase1.workflow
                : engine.loadWorkflow(updatedState.workflow_name);
              if (currentWorkflow && currentWorkflow.manual_step && currentWorkflow.manual_step.includes(updatedState.current_step)) {
                engine.writeManualStepMarker();
              }
            }

            return result.text;
          });
        } catch (err: any) {
          if (err && err.code === "INSTANCE_GONE") {
            if (engine.getBoundInstance() === phase1.instId) engine.setBoundInstance(null);
            return "工作流在验证期间已被取消。";
          }
          throw err;
        }
      });
    },
  });

  // ─── Tool: ralphflow_cancel ─────────────────────────────────────────────────

  const ralphflow_cancel = tool({
    description: "Cancel a workflow instance and clean up its state (optional instance id, unique prefix allowed).",
    args: {
      instance: tool.schema.string().optional().describe("Instance id (unique prefix allowed). Only needed to cancel a specific instance not bound to this session."),
    },
    async execute({ instance }, context) {
      return engine.withLock(async () => {
        engine.beginOp(context.sessionID);
        const resolution = engine.resolveInstance(instance);
        if (!resolution.ok) {
          return resolution.text;
        }
        const instId = resolution.id;
        const state = engine.readState(instId);
        const workflowName = state ? state.workflow_name : instId;
        const ownerInfo = engine.readOwnerSession(instId);
        const ownerAliveElsewhere = ownerInfo && ownerInfo !== engine.getMySessionId() && engine.isSessionAlive(ownerInfo);
        engine.logEvent("info", "workflow_cancelled", { workflow: workflowName, instance: instId });
        let reportPath: string | null = null;
        try {
          reportPath = await engine.withInstanceLock(instId, async () => engine.destroyInstance(instId, "cancelled"));
        } catch (err: any) {
          if (err && err.code === "INSTANCE_GONE") {
            if (engine.getBoundInstance() === instId) engine.setBoundInstance(null);
            return "该实例已不存在（可能已完成或被取消）。";
          }
          throw err;
        }
        let text = `工作流 "${workflowName}"（实例 \`${instId}\`）已取消。`;
        if (reportPath) text += `\n执行报告：${path.relative(engine.projectDir, reportPath)}`;
        if (ownerAliveElsewhere) text += `\n\n> ⚠️ 该实例的属主会话仍在运行。它的下一次 ralphflow_continue 调用会得到"工作流已取消"。`;
        return text;
      });
    },
  });

  // ─── Tool: ralphflow_status ─────────────────────────────────────────────────

  const ralphflow_status = tool({
    description: "Show workflow status: the current session's instance, a specific instance, or an overview of all instances.",
    args: {
      instance: tool.schema.string().optional().describe("Instance id (unique prefix allowed) to inspect a specific instance."),
    },
    async execute({ instance }, context) {
      return engine.withLock(async () => {
        engine.beginOp(context.sessionID);
        const instances = engine.listInstances();

        // Pick the instance to detail: explicit > bound > owned by this session.
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
        } else if (engine.getBoundInstance()) {
          target = instances.find((i) => i.id === engine.getBoundInstance()) || null;
          if (!target) engine.setBoundInstance(null);
        }
        if (!target) {
          const mySession = engine.getMySessionId();
          if (mySession) {
            const mine = instances.filter((i) => i.owner === mySession);
            if (mine.length === 1) target = mine[0];
          }
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
- **属主会话**: ${target.owner ? (target.ownerAlive ? "🟢 活跃" : "⚪ 已关闭") : "无"}
- **最后活动**: ${engine.formatLastActivity(target.lastActivity)}`;

        if (state.last_failure_reason) status += `\n- **上次失败原因**: ${state.last_failure_reason}`;

        if (target.manualGate) {
          status += `\n\n> 📋 该实例正在等待手动审查。审查完成后调用 \`ralphflow_continue\` 进入验证阶段。`;
        } else if (target.owner && !target.ownerAlive) {
          status += `\n\n> ⚠️ 属主会话已关闭。调用 \`ralphflow_continue\` 可在当前会话接管并继续。`;
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
      });
    },
  });

  // ─── Tool: ralphflow_list ───────────────────────────────────────────────────

  const ralphflow_list = tool({
    description: "List all available workflows and active workflow instances.",
    args: {},
    async execute(_args, context) {
      return engine.withLock(async () => {
        engine.beginOp(context.sessionID);
        const workflows = engine.listWorkflows();
        let text = workflows.length > 0
          ? `## 可用工作流\n\n${workflows.map((w) => `- **${w.name}**: ${w.desc}`).join("\n")}`
          : "没有找到工作流。请在 .opencode/ralph-flow/workflows/ 目录创建工作流定义文件。";
        const instances = engine.listInstances();
        if (instances.length > 0) {
          text += `\n\n---\n\n${engine.formatInstanceList(instances)}`;
        }
        return text;
      });
    },
  });

  // ─── Tool: ralphflow_doctor ─────────────────────────────────────────────────

  const ralphflow_doctor = tool({
    description: "Diagnose all workflow definitions (project + plugin): validation errors with full reason lists, silently-skipped steps, unreachable steps, unresolvable template tokens, broken sub-workflow references and cycles, project/plugin shadowing, ignored non-workflow YAML files, and corrupt instance state. Read-only.",
    args: {},
    async execute(_args, context) {
      return engine.withLock(async () => {
        engine.beginOp(context.sessionID);
        return engine.buildDoctorReport();
      });
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
