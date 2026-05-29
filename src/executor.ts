import { detectDoneTag } from "./completion.js";
import { readState, writeState, markCompleted, markPaused, pushState, popState } from "./state.js";
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
}

const sessionStates = new Map<string, SessionState>();

function getSessionState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      stepRecords: [],
      currentStepStartTime: null,
      isProcessingIdle: false,
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
1. 任务描述中的所有要求都已完成
2. 输出要求中的所有内容都已生成
3. 遇到问题时必须解决，不能因为问题而跳过或放弃
4. 不能只完成部分任务就标记完成

如果遇到无法解决的问题，说明具体问题，不要输出 done 标记。`);

  return sections.join("\n\n");
}

export function buildCheckPrompt(step: NormalStepDef, userTask?: string, implementationContext?: string): string {
  const sections: string[] = [];

  if (userTask) {
    sections.push(`## 用户需求

${userTask}`);
  }

  if (implementationContext) {
    sections.push(`## 实现内容

以下是 Do 阶段的输出，请基于此检查任务是否完成：

${implementationContext}`);
  }

  if (sections.length > 0) {
    sections.push("---");
  }

  sections.push(`## 任务检查

**步骤**：${step.id}
**检查依据**：${step.check}

**输入**：${step.input}
**预期输出**：${step.output}

---

请基于上述依据（及用户需求和实现内容）检查任务完成情况，检查完成后输出：
- \`<promise-check>true</promise-check>\` 表示通过
- \`<promise-check>false</promise-check>\` 表示未通过

## 检查标准

**必须严格按依据检查，不接受以下理由作为通过条件：**
- 存量代码/历史代码导致的问题
- 环境配置问题
- 依赖缺失或版本问题
- 外部服务不可用
- "这是预期行为"（与依据矛盾时）
- 任何未在依据中明确豁免的问题

如果存在上述问题，必须判定为未通过，并说明具体原因。`);

  return sections.join("\n\n");
}

export function buildContinuePrompt(state: RalphFlowState, step: NormalStepDef): string {
  if (state.current_phase === "do") {
    return buildDoPrompt(step, state.user_task, state.last_failure_reason, state.fail_count);
  } else {
    return buildCheckPrompt(step, state.user_task);
  }
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

const ADVERSARIAL_CHECK_TIMEOUT = 600_000;

const DEFAULT_ADVERSARIAL_SYSTEM_PROMPT = `
你是一个严格的检查者。你的职责是根据检查标准判断任务是否完成。

## 核心原则

1. 只审查，不修改
2. 严格按照"检查依据"判断，不要被其他因素干扰
3. 如果有任何疑问，判定为不通过

## 判断逻辑

**通过条件**：检查依据中的每一项都满足
**不通过条件**：检查依据中任何一项不满足

## 以下情况不影响判定

这些是执行过程中的障碍，不是检查标准的一部分，不能作为通过/不通过的理由：

- 环境配置问题（缺少依赖、版本不匹配等）
- 外部服务不可用
- 存量代码/历史代码导致的问题
- "这是预期行为"（与检查依据矛盾时）

**正确做法**：如果存在这些问题导致任务无法完成，判定为不通过，并在原因中说明具体是哪个检查依据项未满足。

## 输出格式

- 通过：最后一行输出 <promise-check>true</promise-check>
- 不通过：说明原因，最后一行输出 <promise-check>false</promise-check>

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

export function getAdversarialFailureReason(responseText: string): string {
  const lines = responseText.trim().split("\n");
  const reason = lines.slice(0, -1).join("\n").trim();
  const maxLength = 1000;
  if (reason.length > maxLength) {
    return reason.substring(0, maxLength) + "...";
  }
  return reason;
}

async function adversarialCheck(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  step: NormalStepDef,
  adversarialConfig?: AdversarialCheckConfig,
  userTask?: string
): Promise<{ passed: boolean; reason?: string }> {
  logDebug(directory, "adversarial_check_start", { stepId: step.id });

  const checkSession = await client.session.create({
    body: { title: `Check: ${step.id} - ${userTask?.substring(0, 50) || "unknown"}` },
    query: { directory },
  });
  const checkSessionId = (checkSession as { data: { id: string } }).data.id;

  logDebug(directory, "adversarial_check_session_created", { stepId: step.id, checkSessionId });

  const notifyMsg = `## Check 阶段

正在使用**独立会话**检查 \`${step.id}\` 步骤的完成情况。

**检查会话 ID**: \`${checkSessionId}\`
**超时时间**: 10 分钟

如需查看检查进度，可使用 \`/ralphflow-status\`。

### 检查标准

**检查依据**：${step.check}

**输入**：${step.input}
**预期输出**：${step.output}`;

  const notifyResult = await injectPrompt(client, sessionId, notifyMsg, directory, true);
  
  if (!notifyResult.success) {
    logWarn(directory, "adversarial_check_notify_failed", { error: notifyResult.error });
  }

  try {
    // 获取主会话的最后一个 assistant 消息作为实现上下文
    let implementationContext = "";
    const lastMessageResult = await getLastAssistantMessage(client, sessionId, directory);
    if (lastMessageResult.success && lastMessageResult.data) {
      // 截取合理长度，避免上下文过长
      const maxLength = 5000;
      const message = lastMessageResult.data;
      implementationContext = message.length > maxLength 
        ? message.substring(0, maxLength) + "\n\n...(内容已截断)"
        : message;
    }

    const checkPrompt = buildCheckPrompt(step, userTask, implementationContext);

    logDebug(directory, "adversarial_check_sending_prompt", { stepId: step.id, checkSessionId });

    const response = await Promise.race([
      client.session.prompt({
        path: { id: checkSessionId },
        body: {
          model: adversarialConfig?.model,
          agent: adversarialConfig?.agent || "ralph-check",
          system: adversarialConfig?.system_prompt || DEFAULT_ADVERSARIAL_SYSTEM_PROMPT,
          parts: [{ type: "text", text: checkPrompt }],
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Adversarial check timeout")), ADVERSARIAL_CHECK_TIMEOUT)
      ),
    ]);

    logDebug(directory, "adversarial_check_response_received", { stepId: step.id });

    const responseText = extractResponseText(response);

    logDebug(directory, "adversarial_check_response", {
      stepId: step.id,
      responseText: responseText.substring(0, 2000),
    });

    const passed = parseCheckResult(responseText);
    const reason = passed ? undefined : getAdversarialFailureReason(responseText);

    if (passed) {
      await injectPrompt(client, sessionId,
        `## Check 结果：通过\n\n\`${step.id}\` 步骤检查通过。`,
        directory, true);
    } else {
      await injectPrompt(client, sessionId,
        `## Check 结果：失败\n\n\`${step.id}\` 步骤检查失败。\n\n### 失败原因\n${reason || "未知原因"}`,
        directory, true);
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
}

export async function enterSubWorkflow(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  parentWorkflow: WorkflowDef,
  parentState: RalphFlowState,
  parentStep: SubWorkflowStepDef
): Promise<void> {
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
      const sessionState = getSessionState(sessionId);
      generateCompletionReport(directory, parentState.workflow_name, sessionState.stepRecords);
      sessionStates.delete(sessionId);
      const result = await injectPrompt(client, sessionId, "## Workflow Completed\n\nAll steps have passed verification. The workflow has been marked as completed.", directory, true);
      if (!result.success) {
        logWarn(directory, "workflow_completed_notify_failed", { error: result.error });
      }
      return;
    }

    const nextStep = getStep(parentWorkflow, parentStep.on_pass);
    if (nextStep) {
      writeState(directory, { ...parentState, current_step: nextStep.id, current_phase: "do", fail_count: 0 });
      logStepStart(directory, nextStep.id, "do");

      if (isSubWorkflowStep(nextStep)) {
        await enterSubWorkflow(client, sessionId, directory, parentWorkflow, parentState, nextStep);
      } else {
        await processDoCheckCycle(client, sessionId, directory, parentWorkflow, parentState, nextStep, 0);
      }
    }
  } else {
    const newFailCount = parentState.fail_count + 1;

    if (newFailCount >= parentStep.max_fail_count) {
      markPaused(directory, { ...parentState, fail_count: newFailCount, last_failure_reason: failureReason });
      logWorkflowPaused(directory, parentState.workflow_name, parentStep.id, newFailCount);
      const pauseMsg = `## Workflow Paused

**Step** \`${parentStep.id}\` - ${parentStep.desc} failed after ${newFailCount}/${parentStep.max_fail_count} attempts.

### Next Steps
1. Review the failure reason above and fix the issues
2. Run \`/ralphflow continue\` to retry from the current step
3. Or run \`/ralphflow cancel\` to stop the workflow`;
      const result = await injectPrompt(client, sessionId, pauseMsg, directory, true);
      if (!result.success) {
        logWarn(directory, "workflow_paused_notify_failed", { error: result.error });
      }
      return;
    }

    const nextStep = getStep(parentWorkflow, parentStep.on_fail);
    if (nextStep) {
      writeState(directory, { ...parentState, current_step: nextStep.id, current_phase: "do", fail_count: newFailCount });
      logStepStart(directory, nextStep.id, "do");

      if (isSubWorkflowStep(nextStep)) {
        await enterSubWorkflow(client, sessionId, directory, parentWorkflow, parentState, nextStep);
      } else {
        await processDoCheckCycle(client, sessionId, directory, parentWorkflow, { ...parentState, fail_count: newFailCount }, nextStep, newFailCount, failureReason);
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
      reason = `Check 阶段超时（超过 10 分钟）。

可能原因：
- 检查会话响应过慢
- 检查会话卡住

建议：
1. 使用 \`/ralphflow-status\` 查看当前状态
2. 使用 \`/ralphflow-continue\` 重试
3. 或使用 \`/ralphflow-cancel\` 取消工作流`;
    } else {
      reason = `Check 阶段执行失败: ${errorMessage}`;
    }
  }

  logCheckResult(directory, step.id, passed);

  const sessionState = getSessionState(sessionId);
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
        generateCompletionReport(directory, state.workflow_name, sessionState.stepRecords);
        sessionStates.delete(sessionId);
        const result = await injectPrompt(client, sessionId, "## Workflow Completed\n\nAll steps have passed verification. The workflow has been marked as completed.", directory, true);
        if (!result.success) {
          logWarn(directory, "workflow_completed_notify_failed", { error: result.error });
        }
      }
    } else {
      const nextStep = getStep(workflow, step.on_pass);
      if (nextStep) {
        writeState(directory, { ...state, current_step: nextStep.id, current_phase: "do", fail_count: 0 });
        logStepStart(directory, nextStep.id, "do");

        if (isSubWorkflowStep(nextStep)) {
          await enterSubWorkflow(client, sessionId, directory, workflow, state, nextStep);
        } else {
          await processDoCheckCycle(client, sessionId, directory, workflow, state, nextStep, 0);
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
        const pauseMsg = `## Workflow Paused

**Step** \`${step.id}\` - ${step.desc} failed check after ${newFailCount}/${step.max_fail_count} attempts.

### Failure Reason
${reason || "Unknown"}

### Next Steps
1. Review the failure reason above and fix the issues
2. Run \`/ralphflow continue\` to retry from the current step
3. Or run \`/ralphflow cancel\` to stop the workflow`;
        const result = await injectPrompt(client, sessionId, pauseMsg, directory, true);
        if (!result.success) {
          logWarn(directory, "workflow_paused_notify_failed", { error: result.error });
        }
      }
    } else {
      const nextStep = getStep(workflow, step.on_fail);
      if (nextStep) {
        writeState(directory, { ...state, current_step: nextStep.id, current_phase: "do", fail_count: newFailCount });
        logStepStart(directory, nextStep.id, "do");

        if (isSubWorkflowStep(nextStep)) {
          await enterSubWorkflow(client, sessionId, directory, workflow, state, nextStep);
        } else {
          await processDoCheckCycle(client, sessionId, directory, workflow, state, nextStep, newFailCount, reason);
        }
      }
    }
  }
  return true;
}

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

  const cycleStart = new Date().toISOString();

  const doPrompt = buildDoPrompt(step, state.user_task, retryContext, failCount);
  const doResult = await injectPrompt(client, sessionId, doPrompt, directory);

  if (!doResult.success || doResult.data === null || !detectDoneTag(doResult.data)) return;

  const sessionState = getSessionState(sessionId);
  const doRecord = createStepRecord(step.id, "do", "passed", 0, undefined, cycleStart);
  sessionState.stepRecords.push(doRecord);

  const checkState: RalphFlowState = {
    ...state,
    current_step: step.id,
    current_phase: "check",
    fail_count: failCount,
  };
  writeState(directory, checkState);
  logStepStart(directory, step.id, "check");

  await routeCheckResult(client, sessionId, directory, workflow, state, step, failCount);
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
        logDoneDetected(directory, state.current_step);

        const doRecord = createStepRecord(state.current_step, "do", "passed", 0, undefined, sessionState.currentStepStartTime || now);
        sessionState.stepRecords.push(doRecord);

        const newState: RalphFlowState = {
          ...state,
          current_phase: "check",
          fail_count: 0,
        };
        writeState(directory, newState);
        logStepStart(directory, state.current_step, "check");

        sessionState.currentStepStartTime = now;

        const handled = await routeCheckResult(client, sessionId, directory, workflow, state, currentStep, state.fail_count);
        if (handled) return;
      }

      // 手动步骤：AI 停下来问问题时，不自动注入提示词
      if (workflow.manual_step.includes(state.current_step)) {
        logDebug(directory, "manual_step_skip", { step: state.current_step });
        return;
      }

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

export function handleContinue(
  directory: string,
  workflow: WorkflowDef
): string {
  const state = readState(directory);
  if (!state || !state.active) return "No active workflow to continue.";

  const step = getStep(workflow, state.current_step);
  if (!step) return `Step "${state.current_step}" not found.`;

  if (isSubWorkflowStep(step)) {
    const subWorkflow = loadWorkflow(directory, step.workflow);
    if (!subWorkflow) {
      return `子工作流 "${step.workflow}" 未找到。请检查工作流定义。`;
    }
    
    const subState = readState(directory);
    if (subState && subState.workflow_name === step.workflow) {
      const subStep = getStep(subWorkflow, subState.current_step);
      if (subStep && !isSubWorkflowStep(subStep)) {
        return buildContinuePrompt(subState, subStep as NormalStepDef);
      }
    }
    
    return `子工作流 "${step.workflow}" 状态异常，请使用 /ralphflow cancel 取消后重新开始。`;
  }

  return buildContinuePrompt(state, step as NormalStepDef);
}
