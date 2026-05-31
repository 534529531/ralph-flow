import { detectDoneTag } from "./completion.js";
import { readState, writeState, markCompleted, markPaused, pushState, popState, getStackDepth } from "./state.js";
import { logStepStart, logDoneDetected, logCheckResult, logFailCountIncrement, logWorkflowPaused, logWorkflowEnd, logError, logWarn, logDebug } from "./logger.js";
import { createStepRecord, generateCompletionReport } from "./report.js";
import { loadWorkflow } from "./workflow-loader.js";
import type { WorkflowDef, RalphFlowState, StepDef, SubWorkflowStepDef, StepExecutionRecord, NormalStepDef, AdversarialCheckConfig, Result } from "./types.js";
import { isSubWorkflowStep } from "./types.js";
import type { OpencodeClient } from "@opencode-ai/sdk";

interface SessionState {
  stepRecords: StepExecutionRecord[];
  currentStepStartTime: string | null;
  isProcessingIdle: boolean;
  doReinjectCount: number;
}

const sessionStates = new Map<string, SessionState>();
const adversarialCheckRunningByDir = new Map<string, boolean>();

function isAdversarialCheckActive(directory: string): boolean {
  return adversarialCheckRunningByDir.get(directory) === true;
}

function setAdversarialCheckActive(directory: string, active: boolean): void {
  adversarialCheckRunningByDir.set(directory, active);
}

export function resetAdversarialCheckActive(directory: string): void {
  adversarialCheckRunningByDir.delete(directory);
}

function getSessionState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      stepRecords: [],
      currentStepStartTime: null,
      isProcessingIdle: false,
      doReinjectCount: 0,
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

export function getStepRecords(sessionId?: string): StepExecutionRecord[] {
  if (sessionId) {
    const state = getSessionState(sessionId);
    return [...state.stepRecords];
  }
  const allRecords: StepExecutionRecord[] = [];
  for (const state of sessionStates.values()) {
    allRecords.push(...state.stepRecords);
  }
  return allRecords;
}

export function resetStepRecords(sessionId?: string): void {
  if (sessionId) {
    const state = getSessionState(sessionId);
    state.stepRecords = [];
    state.currentStepStartTime = new Date().toISOString();
    state.doReinjectCount = 0;
    state.isProcessingIdle = false;
  } else {
    sessionStates.clear();
  }
}

export async function getLastAssistantMessage(
  client: OpencodeClient,
  sessionId: string,
  directory: string
): Promise<Result<string>> {
  try {
    const response = await client.session.messages({
      path: { id: sessionId },
    });

    // The response should have a data field with the messages
    const messages = (response as { data?: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> }).data ?? [];
    const assistantMessages = messages.filter(
      (msg) => msg.info?.role === "assistant"
    );

    if (assistantMessages.length === 0) return { success: true, data: "" };

    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const parts = lastAssistant.parts || [];

    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text ?? "")
      .join("\n");
    return { success: true, data: text };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(directory, "get_last_message_failed", error);
    return { success: false, error: errorMessage };
  }
}

export function getStep(workflow: WorkflowDef, stepId: string): StepDef | null {
  return workflow.steps.find((s) => s.id === stepId) || null;
}

export function buildDoPrompt(step: NormalStepDef, userTask?: string, retryContext?: string, retryCount?: number): string {
  const sections: string[] = [];

  if (userTask) {
    sections.push(`## 用户需求

${userTask}`);
  }

  if (retryContext) {
    sections.push(`## 上次检查失败原因

${retryContext}`);
  }

  if (retryCount && retryCount > 0) {
    sections.push(`## 重试信息

这是第 **${retryCount}** 次重试，最大重试次数为 **${step.max_fail_count}** 次。`);
  }

  if (sections.length > 0) {
    sections.push("---");
  }

  sections.push(`## 当前任务

**步骤**：${step.id}
**描述**：${step.desc}

**任务**：${step.do}

**输入说明**：${step.input}

**输出要求**：${step.output}

---

请执行上述任务。

## 完成标准

只有满足以下所有条件才能输出 \`<promise>done</promise>\` 标记：
1. 任务要求全部完成
2. 输出要求全部生成
3. 遇到问题必须解决，不能跳过

如果遇到无法解决的问题，说明具体问题，不要输出 done 标记。`);

  return sections.join("\n\n");
}

export function buildCheckPrompt(step: NormalStepDef, userTask?: string): string {
  const sections: string[] = [];

  if (userTask) {
    sections.push(`## 用户需求

${userTask}`);
  }

  sections.push(`## Do 阶段任务

**步骤**：${step.id}
**任务描述**：${step.do}
**输入**：${step.input}
**预期输出**：${step.output}`);

  if (sections.length > 0) {
    sections.push("---");
  }

  sections.push(`## 检查依据

${step.check}

---

请基于上述信息，自主探索项目验证任务完成情况。基于你自己的探索结果判断，不要依赖任何外部提供的"实现总结"。

检查完成后输出：
- 通过：先说明通过原因，最后一行输出 \`<promise-check>true</promise-check>\`
- 不通过：先说明失败原因，最后一行输出 \`<promise-check>false</promise-check>\`

标签必须独占最后一行。`);

  return sections.join("\n\n");
}

export function buildContinuePrompt(state: RalphFlowState, step: NormalStepDef): string {
  // continue时始终返回do prompt，因为需要重新执行任务
  // check阶段由独立的对抗性检查会话处理，主会话不需要输出promise-check标签
  return buildDoPrompt(step, state.user_task, state.last_failure_reason, state.fail_count);
}

export function buildSubWorkflowUserTask(step: SubWorkflowStepDef, parentUserTask: string): string {
  const parts: string[] = [];

  if (step.inputs) {
    for (const [key, value] of Object.entries(step.inputs)) {
      parts.push(`${key}: ${value}`);
    }
  }

  if (parentUserTask) {
    if (parts.length > 0) {
      parts.push("");
    }
    parts.push(`原始需求：${parentUserTask}`);
  }

  return parts.join("\n");
}

const DEFAULT_ADVERSARIAL_CHECK_TIMEOUT = 900_000; // 15 分钟

const DEFAULT_ADVERSARIAL_SYSTEM_PROMPT = `
你是一个严格的检查者。你的职责是根据检查依据判断任务是否完成。

## 核心原则

1. 只审查，不修改
2. 严格按照"检查依据"判断，不要被其他因素干扰
3. 如果有任何疑问，判定为不通过

## 验证方法

你必须**自主探索**项目来验证任务是否完成：
- 根据任务类型，选择合适的验证方式
- 基于检查依据中的要求，逐一验证每一项
- 不要依赖任何外部提供的"实现总结"，只基于你自己的验证结果判断

## 判断逻辑

**通过条件**：检查依据中的每一项都满足
**不通过条件**：检查依据中任何一项不满足

## 输出格式

- 通过：先说明通过原因，最后一行输出 <promise-check>true</promise-check>
- 不通过：先说明失败原因，最后一行输出 <promise-check>false</promise-check>

标签必须独占最后一行。
`;

export function extractResponseText(response: unknown): string {
  const data = response as { data?: { parts?: Array<{ type: string; text?: string }> } };
  const parts = data?.data?.parts ?? [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

export function parseCheckResult(responseText: string): boolean {
  const lines = responseText.trim().split("\n");
  const lastLine = lines[lines.length - 1].trim();
  const match = lastLine.match(/<promise-check>\s*(true|false)\s*<\/promise-check>/i);
  if (!match) return false;
  return match[1].toLowerCase() === "true";
}

export function getAdversarialCheckReason(responseText: string): string {
  const lines = responseText.trim().split("\n");
  const reason = lines.slice(0, -1).join("\n").trim();
  const maxLength = 1000;
  if (reason.length > maxLength) {
    return reason.substring(0, maxLength) + "...";
  }
  return reason;
}

export const getAdversarialFailureReason = getAdversarialCheckReason;

async function adversarialCheck(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  step: NormalStepDef,
  adversarialConfig?: AdversarialCheckConfig,
  userTask?: string
): Promise<{ passed: boolean; reason?: string }> {
  setAdversarialCheckActive(directory, true);

  try {
    logDebug(directory, "adversarial_check_start", { stepId: step.id });

    const checkSession = await client.session.create({
      body: {
        title: `Check: ${step.id} - ${userTask?.substring(0, 50) || "unknown"}`,
        parentID: sessionId,
      },
      query: { directory },
    });
    const checkSessionId = (checkSession as { data: { id: string } }).data.id;

    logDebug(directory, "adversarial_check_session_created", { stepId: step.id, checkSessionId });

    const checkPrompt = buildCheckPrompt(step, userTask);
    const systemPrompt = adversarialConfig?.system_prompt || DEFAULT_ADVERSARIAL_SYSTEM_PROMPT;
    const timeout = adversarialConfig?.timeout_ms || DEFAULT_ADVERSARIAL_CHECK_TIMEOUT;
    const timeoutMinutes = Math.round(timeout / 60_000);

    const notifyMsg = `## Check 阶段

正在使用**独立会话**检查 \`${step.id}\` 步骤的完成情况。

**检查会话 ID**: \`${checkSessionId}\`
**超时时间**: ${timeoutMinutes} 分钟

如需查看检查进度，可使用 \`/ralphflow-status\`。

### 任务信息

**用户需求**：${userTask || "未指定"}

**Do 阶段任务**：${step.do}

**输入**：${step.input}
**预期输出**：${step.output}

### 检查依据

${step.check}

### 独立会话指令

独立会话收到的指令：
---
${checkPrompt}
---`;

    const notifyResult = await injectPrompt(client, sessionId, notifyMsg, directory, true);
    
    if (!notifyResult.success) {
      logWarn(directory, "adversarial_check_notify_failed", { error: notifyResult.error });
    }

    try {
      const logMaxLength = 3000;
      const truncate = (text: string) => text.length > logMaxLength ? text.substring(0, logMaxLength) + "...(内容已截断)" : text;

      logDebug(directory, "adversarial_check_sending_prompt", {
        stepId: step.id,
        checkSessionId,
        systemPrompt: truncate(systemPrompt),
        userPrompt: truncate(checkPrompt),
      });

      const response = await Promise.race([
        client.session.prompt({
          path: { id: checkSessionId },
          body: {
            model: adversarialConfig?.model,
            agent: adversarialConfig?.agent || "ralph-check",
            system: systemPrompt,
            parts: [{ type: "text", text: checkPrompt }],
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Adversarial check timeout")), timeout)
        ),
      ]);

      logDebug(directory, "adversarial_check_response_received", { stepId: step.id });

      const responseText = extractResponseText(response);

      logDebug(directory, "adversarial_check_response", {
        stepId: step.id,
        responseText: responseText.substring(0, 2000),
      });

      // 空响应处理：检查会话可能卡住
      if (!responseText.trim()) {
        logWarn(directory, "adversarial_check_empty_response", { stepId: step.id });
        return { passed: false, reason: "检查会话返回空响应，可能卡住了。建议使用 /ralphflow continue 重试。" };
      }

      const passed = parseCheckResult(responseText);
      const reason = getAdversarialCheckReason(responseText);

      if (passed) {
        injectPrompt(client, sessionId,
          `## Check 结果：通过\n\n\`${step.id}\` 步骤检查通过。\n\n### 通过原因\n${reason || "检查通过"}`,
          directory, true).catch(() => {});
      } else {
        injectPrompt(client, sessionId,
          `## Check 结果：失败\n\n\`${step.id}\` 步骤检查失败。\n\n### 失败原因\n${reason || "未知原因"}`,
          directory, true).catch(() => {});
      }

      return { passed, reason };
    } finally {
      try {
        await client.session.delete({
          path: { id: checkSessionId },
          query: { directory },
        });
      } catch {
        // ignore cleanup errors
      }
    }
  } finally {
    setAdversarialCheckActive(directory, false);
  }
}

export async function enterSubWorkflow(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  parentWorkflow: WorkflowDef,
  parentState: RalphFlowState,
  parentStep: SubWorkflowStepDef
): Promise<void> {
  const MAX_NESTING_DEPTH = 5;
  const currentDepth = getStackDepth(directory);
  
  if (currentDepth >= MAX_NESTING_DEPTH) {
    logError(directory, "max_nesting_depth_exceeded", { depth: currentDepth, maxDepth: MAX_NESTING_DEPTH });
    await resumeParentWorkflow(
      client, sessionId, directory, parentState, false,
      `嵌套深度超过限制（${currentDepth}/${MAX_NESTING_DEPTH}）。可能存在循环引用。`
    );
    return;
  }

  logDebug(directory, "enter_sub_workflow", { workflow: parentStep.workflow, depth: currentDepth + 1 });

  const subUserTask = buildSubWorkflowUserTask(parentStep, parentState.user_task);

  pushState(directory, parentState);

  const subWorkflow = loadWorkflow(directory, parentStep.workflow);
  if (!subWorkflow) {
    popState(directory);
    await resumeParentWorkflow(client, sessionId, directory, parentState, false, `子工作流 "${parentStep.workflow}" 未找到`);
    return;
  }

  const firstStep = subWorkflow.steps[0];
  if (!firstStep) {
    popState(directory);
    await resumeParentWorkflow(client, sessionId, directory, parentState, false, `子工作流 "${parentStep.workflow}" 没有步骤`);
    return;
  }

  const subState: RalphFlowState = {
    active: true,
    workflow_name: parentStep.workflow,
    current_step: firstStep.id,
    current_phase: "do",
    fail_count: 0,
    user_task: subUserTask,
    paused: false,
  };
  writeState(directory, subState);

  logStepStart(directory, firstStep.id, "do");

  if (isSubWorkflowStep(firstStep)) {
    await enterSubWorkflow(client, sessionId, directory, subWorkflow, subState, firstStep);
  } else {
    await processDoCheckCycle(client, sessionId, directory, subWorkflow, subState, firstStep, 0);
  }
}

async function resumeParentWorkflow(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  parentState: RalphFlowState,
  subWorkflowPassed: boolean,
  failureReason?: string
): Promise<void> {
  const parentWorkflow = loadWorkflow(directory, parentState.workflow_name);
  if (!parentWorkflow) return;

  const parentStep = getStep(parentWorkflow, parentState.current_step);
  if (!parentStep) return;

  if (subWorkflowPassed) {
    if (parentStep.on_pass === "done") {
        markCompleted(directory, { ...parentState, current_step: parentStep.id, current_phase: "check" });
        logWorkflowEnd(directory, parentState.workflow_name);
        resetAdversarialCheckActive(directory);
        const sessionState = getSessionState(sessionId);
        generateCompletionReport(directory, parentState.workflow_name, sessionState.stepRecords);
        sessionStates.delete(sessionId);
        const result = await injectPrompt(client, sessionId, "## 工作流完成\n\n所有步骤已通过验证，工作流已完成。", directory, true);
      if (!result.success) {
        logWarn(directory, "workflow_completed_notify_failed", { error: result.error });
      }
      return;
    }

    const nextStep = getStep(parentWorkflow, parentStep.on_pass);
    if (nextStep) {
      const updatedState = { ...parentState, current_step: nextStep.id, current_phase: "do" as const, fail_count: 0 };
      writeState(directory, updatedState);
      logStepStart(directory, nextStep.id, "do");

      if (isSubWorkflowStep(nextStep)) {
        await enterSubWorkflow(client, sessionId, directory, parentWorkflow, updatedState, nextStep);
      } else {
        await processDoCheckCycle(client, sessionId, directory, parentWorkflow, updatedState, nextStep, 0);
      }
    }
  } else {
    const newFailCount = parentState.fail_count + 1;

    if (newFailCount >= parentStep.max_fail_count) {
      markPaused(directory, { ...parentState, fail_count: newFailCount, last_failure_reason: failureReason });
      logWorkflowPaused(directory, parentState.workflow_name, parentStep.id, newFailCount);
      const pauseMsg = `## 工作流暂停

步骤 \`${parentStep.id}\` - ${parentStep.desc} 已失败 ${newFailCount}/${parentStep.max_fail_count} 次。

### 后续操作
1. 查看上面的失败原因并修复问题
2. 运行 \`/ralphflow continue\` 从当前步骤重试
3. 运行 \`/ralphflow cancel\` 取消工作流`;
      const result = await injectPrompt(client, sessionId, pauseMsg, directory, true);
      if (!result.success) {
        logWarn(directory, "workflow_paused_notify_failed", { error: result.error });
      }
      return;
    }

    const nextStep = getStep(parentWorkflow, parentStep.on_fail);
    if (nextStep) {
      const updatedState = { ...parentState, current_step: nextStep.id, current_phase: "do" as const, fail_count: newFailCount };
      writeState(directory, updatedState);
      logStepStart(directory, nextStep.id, "do");

      if (isSubWorkflowStep(nextStep)) {
        await enterSubWorkflow(client, sessionId, directory, parentWorkflow, updatedState, nextStep);
      } else {
        await processDoCheckCycle(client, sessionId, directory, parentWorkflow, updatedState, nextStep, newFailCount, failureReason);
      }
    }
  }
}

async function routeCheckResult(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  workflow: WorkflowDef,
  state: RalphFlowState,
  step: StepDef,
  currentFailCount: number
): Promise<boolean> {
  if (isSubWorkflowStep(step)) return false;

  if (isAdversarialCheckActive(directory)) {
    logDebug(directory, "adversarial_check_skipped_concurrent", { stepId: step.id });
    return false;
  }

  const sessionState = getSessionState(sessionId);
  let passed = false;
  let reason: string | undefined;

  try {
    const result = await adversarialCheck(
      client, sessionId, directory, step, workflow.adversarial_check, state.user_task
    );
    passed = result.passed;
    reason = result.reason;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(directory, "adversarial_check_failed", error);
    passed = false;
    
    if (errorMessage.includes("timeout")) {
      reason = `Check 阶段超时。

可能原因：
- 检查会话响应过慢
- 检查会话卡住
- 任务过于复杂，需要更长的检查时间

建议：
1. 使用 \`/ralphflow-status\` 查看当前状态
2. 使用 \`/ralphflow-continue\` 重试
3. 或使用 \`/ralphflow-cancel\` 取消工作流
4. 如果任务确实需要更长时间，可以在工作流配置中增加 \`timeout_ms\`（单位：毫秒）`;
    } else {
      reason = `Check 阶段执行失败: ${errorMessage}`;
    }
  }

  logCheckResult(directory, step.id, passed);

  const checkFailCount = passed ? currentFailCount : currentFailCount + 1;
  const checkRecord = createStepRecord(step.id, "check", passed ? "passed" : "failed", checkFailCount, reason);
  sessionState.stepRecords.push(checkRecord);

  if (passed) {
    if (step.on_pass === "done") {
      const parentState = popState(directory);
      if (parentState) {
        await resumeParentWorkflow(client, sessionId, directory, parentState, true);
      } else {
        markCompleted(directory, { ...state, current_step: step.id, current_phase: "check", fail_count: currentFailCount });
        logWorkflowEnd(directory, state.workflow_name);
        resetAdversarialCheckActive(directory);
        generateCompletionReport(directory, state.workflow_name, sessionState.stepRecords);
        sessionStates.delete(sessionId);
        const result = await injectPrompt(client, sessionId, "## 工作流完成\n\n所有步骤已通过验证，工作流已完成。", directory, true);
        if (!result.success) {
          logWarn(directory, "workflow_completed_notify_failed", { error: result.error });
        }
      }
    } else {
      const nextStep = getStep(workflow, step.on_pass);
      if (nextStep) {
        const nextState = { ...state, current_step: nextStep.id, current_phase: "do" as const, fail_count: 0 };
        writeState(directory, nextState);
        logStepStart(directory, nextStep.id, "do");

        if (isSubWorkflowStep(nextStep)) {
          await enterSubWorkflow(client, sessionId, directory, workflow, nextState, nextStep);
        } else {
          await processDoCheckCycle(client, sessionId, directory, workflow, nextState, nextStep, 0);
        }
      }
    }
  } else {
    const newFailCount = currentFailCount + 1;
    logFailCountIncrement(directory, step.id, newFailCount);

    if (newFailCount >= step.max_fail_count) {
      const parentState = popState(directory);
      if (parentState) {
        await resumeParentWorkflow(client, sessionId, directory, parentState, false, reason);
      } else {
        markPaused(directory, { ...state, fail_count: newFailCount, last_failure_reason: reason });
        logWorkflowPaused(directory, state.workflow_name, step.id, newFailCount);
        const pauseMsg = `## 工作流暂停

步骤 \`${step.id}\` - ${step.desc} 检查失败，已失败 ${newFailCount}/${step.max_fail_count} 次。

### 失败原因
${reason || "未知"}

### 后续操作
1. 查看上面的失败原因并修复问题
2. 运行 \`/ralphflow continue\` 从当前步骤重试
3. 运行 \`/ralphflow cancel\` 取消工作流`;
        const result = await injectPrompt(client, sessionId, pauseMsg, directory, true);
        if (!result.success) {
          logWarn(directory, "workflow_paused_notify_failed", { error: result.error });
        }
      }
    } else {
      const nextStep = getStep(workflow, step.on_fail);
      if (nextStep) {
        const nextState = { ...state, current_step: nextStep.id, current_phase: "do" as const, fail_count: newFailCount };
        writeState(directory, nextState);
        logStepStart(directory, nextStep.id, "do");

        if (isSubWorkflowStep(nextStep)) {
          await enterSubWorkflow(client, sessionId, directory, workflow, nextState, nextStep);
        } else {
          await processDoCheckCycle(client, sessionId, directory, workflow, nextState, nextStep, newFailCount, reason);
        }
      }
    }
  }
  return true;
}

const MAX_DO_REINJECT = 5;

async function processDoCheckCycle(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  workflow: WorkflowDef,
  state: RalphFlowState,
  step: StepDef,
  failCount: number,
  retryContext?: string
): Promise<void> {
  if (isSubWorkflowStep(step)) return;

  const sessionState = getSessionState(sessionId);
  const cycleStart = new Date().toISOString();

  // 重新注入循环：不再依赖 session.idle 事件（会被 isProcessingIdle 阻塞）
  while (true) {
    const doPrompt = buildDoPrompt(step, state.user_task, retryContext, failCount);
    const doResult = await injectPrompt(client, sessionId, doPrompt, directory);

    if (doResult.success && doResult.data !== null && detectDoneTag(doResult.data)) {
      // 检查状态是否已经被 handleSessionIdle 更新到 check 阶段
      const currentState = readState(directory);
      if (currentState && currentState.current_phase === "check" && currentState.current_step === step.id) {
        logDebug(directory, "processDoCheckCycle_skip_already_in_check", { stepId: step.id });
        return;
      }

      const doRecord = createStepRecord(step.id, "do", "passed", 0, undefined, cycleStart);
      sessionState.stepRecords.push(doRecord);
      sessionState.doReinjectCount = 0;

      const checkState: RalphFlowState = {
        ...state,
        current_step: step.id,
        current_phase: "check",
        fail_count: failCount,
      };
      writeState(directory, checkState);
      logStepStart(directory, step.id, "check");

      await routeCheckResult(client, sessionId, directory, workflow, checkState, step, failCount);
      return;
    }

    // 未检测到 done 标记 → 重新注入
    sessionState.doReinjectCount++;
    if (sessionState.doReinjectCount > MAX_DO_REINJECT) {
      logWarn(directory, "do_reinject_limit_reached", { step: step.id, count: sessionState.doReinjectCount });
      const pausedState: RalphFlowState = { ...state, paused: true, last_failure_reason: `do 阶段重试次数已达上限（${MAX_DO_REINJECT}次），AI 未在响应中输出 <promise>done</promise> 标记` };
      writeState(directory, pausedState);
      logWorkflowPaused(directory, state.workflow_name, step.id, sessionState.doReinjectCount);
      const pauseMsg = `## 工作流暂停

步骤 \`${step.id}\` do 阶段已重试 ${sessionState.doReinjectCount} 次，仍未输出完成标记。

### 后续操作
1. 检查 AI 输出，确认任务是否已完成但缺少标记
2. 运行 \`/ralphflow continue\` 重试
3. 运行 \`/ralphflow cancel\` 取消工作流`;
      await injectPrompt(client, sessionId, pauseMsg, directory, true).catch(() => {});
      return;
    }

    logDebug(directory, "do_reinject_cycle", { step: step.id, count: sessionState.doReinjectCount });
    // 继续循环重新注入
  }
}

export async function injectPrompt(
  client: OpencodeClient,
  sessionId: string,
  prompt: string,
  directory: string,
  noReply: boolean = false
): Promise<Result<string | null>> {
  try {
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: prompt }],
        noReply,
      },
    });
    if (!noReply) {
      const data = result as { data?: { parts?: Array<{ type: string; text?: string }> } };
      const parts = data?.data?.parts ?? [];
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n") || null;
      return { success: true, data: text };
    }
    return { success: true, data: null };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logError(directory, "inject_prompt_failed", error);
    return { success: false, error: errorMessage };
  }
}

async function handleDoPhaseDone(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  workflow: WorkflowDef,
  state: RalphFlowState,
  step: NormalStepDef,
  sessionState: SessionState,
  cycleStart: string
): Promise<void> {
  logDoneDetected(directory, state.current_step);

  const doRecord = createStepRecord(state.current_step, "do", "passed", 0, undefined, cycleStart);
  sessionState.stepRecords.push(doRecord);
  sessionState.doReinjectCount = 0;

  const newState: RalphFlowState = {
    ...state,
    current_phase: "check",
  };
  writeState(directory, newState);
  logStepStart(directory, state.current_step, "check");

  sessionState.currentStepStartTime = new Date().toISOString();

  await routeCheckResult(client, sessionId, directory, workflow, newState, step, newState.fail_count);
}

export async function handleSessionIdle(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  workflow: WorkflowDef
): Promise<void> {
  const sessionState = getSessionState(sessionId);
  if (sessionState.isProcessingIdle) return;
  sessionState.isProcessingIdle = true;
  try {
    const state = readState(directory);
    if (!state || !state.active) return;

    // 暂停状态（会话关闭或超过最大失败次数）不自动继续
    if (state.paused) return;

    const currentStep = getStep(workflow, state.current_step);
    if (!currentStep || isSubWorkflowStep(currentStep)) return;

    const messageResult = await getLastAssistantMessage(client, sessionId, directory);
    if (!messageResult.success) {
      logWarn(directory, "get_last_message_failed", { error: messageResult.error });
      return;
    }
    
    const responseText = messageResult.data;
    const now = new Date().toISOString();

    if (state.current_phase === "do") {
      if (detectDoneTag(responseText)) {
        await handleDoPhaseDone(client, sessionId, directory, workflow, state, currentStep, sessionState, sessionState.currentStepStartTime || now);
        return;
      }

      // 手动步骤：AI 停下来问问题时，不自动注入提示词
      if (workflow.manual_step.includes(state.current_step)) {
        logDebug(directory, "manual_step_skip", { step: state.current_step });
        return;
      }

      // 未检测到 done 标记且非手动步骤 → 调用 processDoCheckCycle（内部有重注入循环）
      await processDoCheckCycle(client, sessionId, directory, workflow, state, currentStep, state.fail_count);
      return;
    }

    // check 阶段 - 触发对抗性检查
    if (state.current_phase === "check") {
      const handled = await routeCheckResult(client, sessionId, directory, workflow, state, currentStep, state.fail_count);
      if (handled) return;
    }
  } finally {
    sessionState.isProcessingIdle = false;
  }
}

function setupSubWorkflowChain(
  directory: string,
  step: SubWorkflowStepDef,
  userTask: string
): string {
  if (getStackDepth(directory) > 5) {
    return `嵌套深度超过限制（5 层）。可能存在循环引用，请检查工作流定义。`;
  }

  const subWorkflow = loadWorkflow(directory, step.workflow);
  if (!subWorkflow) {
    return `子工作流 "${step.workflow}" 未找到。`;
  }

  const firstStep = subWorkflow.steps[0];
  if (!firstStep) {
    return `子工作流 "${step.workflow}" 没有步骤。`;
  }

  const subUserTask = buildSubWorkflowUserTask(step, userTask);

  if (isSubWorkflowStep(firstStep)) {
    const intermediateState: RalphFlowState = {
      active: true,
      workflow_name: step.workflow,
      current_step: firstStep.id,
      current_phase: "do",
      fail_count: 0,
      user_task: subUserTask,
      paused: false,
    };
    pushState(directory, intermediateState);
    return setupSubWorkflowChain(directory, firstStep, subUserTask);
  }

  const subState: RalphFlowState = {
    active: true,
    workflow_name: step.workflow,
    current_step: firstStep.id,
    current_phase: "do",
    fail_count: 0,
    user_task: subUserTask,
    paused: false,
  };
  writeState(directory, subState);

  return buildDoPrompt(firstStep as NormalStepDef, subUserTask);
}

export function handleContinue(
  directory: string,
  workflow: WorkflowDef
): string {
  const state = readState(directory);
  if (!state || !state.active) return "没有活跃的工作流可以继续。";

  const step = getStep(workflow, state.current_step);
  if (!step) return `Step "${state.current_step}" not found.`;

  if (isSubWorkflowStep(step)) {
    const subWorkflow = loadWorkflow(directory, step.workflow);
    if (!subWorkflow) {
      return `子工作流 "${step.workflow}" 未找到。请检查工作流定义。`;
    }

    // Case 1: 状态已经是子工作流状态（子工作流正在运行时被暂停）
    if (state.workflow_name === step.workflow) {
      const subStep = getStep(subWorkflow, state.current_step);
      if (!subStep) {
        return `子工作流 "${step.workflow}" 中步骤 "${state.current_step}" 未找到。`;
      }
      if (isSubWorkflowStep(subStep)) {
        pushState(directory, state);
        const result = setupSubWorkflowChain(directory, subStep, state.user_task);
        if (result.startsWith("子工作流") || result.startsWith("嵌套深度")) {
          while (getStackDepth(directory) > 0) popState(directory);
        }
        return result;
      }
      return buildContinuePrompt(state, subStep as NormalStepDef);
    }

    // Case 2: 父工作流因子工作流失败而暂停，需要重新启动子工作流
    pushState(directory, state);
    const result = setupSubWorkflowChain(directory, step, state.user_task);
    if (result.startsWith("子工作流") || result.startsWith("嵌套深度")) {
      while (getStackDepth(directory) > 0) popState(directory);
    }
    return result;
  }

  return buildContinuePrompt(state, step as NormalStepDef);
}
