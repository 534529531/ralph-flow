import { detectDoneTag, detectCheckTag } from "./completion.js";
import { readState, writeState, markCompleted, markPaused } from "./state.js";
import { logStepStart, logDoneDetected, logCheckResult, logFailCountIncrement, logWorkflowPaused, logWorkflowEnd, logError, logWarn } from "./logger.js";
import { createStepRecord, generateCompletionReport } from "./report.js";
import type { WorkflowDef, RalphFlowState, StepDef, StepExecutionRecord } from "./types.js";
import type { OpencodeClient } from "@opencode-ai/sdk";

// 存储当前工作流的步骤执行记录
let stepRecords: StepExecutionRecord[] = [];
// 当前步骤的开始时间
let currentStepStartTime: string | null = null;
// 防止 session.idle 并发处理
let isProcessingIdle = false;

export function getStepRecords(): StepExecutionRecord[] {
  return [...stepRecords];
}

export function resetStepRecords(): void {
  stepRecords = [];
  currentStepStartTime = new Date().toISOString();
}

export async function getLastAssistantMessage(
  client: OpencodeClient,
  sessionId: string,
  directory: string
): Promise<string> {
  try {
    const response = await client.session.messages({
      path: { id: sessionId },
    });

    // The response should have a data field with the messages
    const messages = (response as { data?: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> }).data ?? [];
    const assistantMessages = messages.filter(
      (msg) => msg.info?.role === "assistant"
    );

    if (assistantMessages.length === 0) return "";

    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const parts = lastAssistant.parts || [];

    return parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text ?? "")
      .join("\n");
  } catch (error) {
    logError(directory, "get_last_message_failed", error);
    return "";
  }
}

export function getStep(workflow: WorkflowDef, stepId: string): StepDef | null {
  return workflow.steps.find((s) => s.id === stepId) || null;
}

export function getManualPhases(workflow: WorkflowDef): Set<string> {
  return new Set(workflow.manual_phase);
}

export function isManualPhase(workflow: WorkflowDef, stepId: string, phase: "do" | "check"): boolean {
  const manualPhases = getManualPhases(workflow);
  return manualPhases.has(`${stepId}.${phase}`);
}

export function buildDoPrompt(step: StepDef, userTask?: string, retryContext?: string): string {
  const sections: string[] = [];

  if (userTask) {
    sections.push(`## 用户需求

${userTask}`);
  }

  if (retryContext) {
    sections.push(`## 上次检查失败原因

${retryContext}`);
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

export function buildCheckPrompt(step: StepDef, userTask?: string): string {
  const sections: string[] = [];

  if (userTask) {
    sections.push(`## 用户需求

${userTask}`);
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

请基于上述依据（及用户需求）检查任务完成情况，检查完成后输出：
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

export function buildContinuePrompt(state: RalphFlowState, step: StepDef): string {
  if (state.current_phase === "do") {
    return buildDoPrompt(step, state.user_task);
  } else {
    return buildCheckPrompt(step, state.user_task);
  }
}

export function buildIdlePrompt(step: StepDef, userTask?: string, phase?: "do" | "check"): string {
  const parts = [`请继续完成当前任务。`];
  parts.push(`当前步骤：${step.id} - ${step.desc}`);
  if (userTask) {
    parts.push(`用户需求：${userTask}`);
  }
  if (phase === "check") {
    parts.push(`\n检查完成后请输出 \`<promise-check>true</promise-check>\`（通过）或 \`<promise-check>false</promise-check>\`（不通过）。`);
  } else {
    parts.push(`\n完成后请输出 \`<promise>done</promise>\` 标记。`);
  }
  return parts.join("\n");
}

const WORKFLOW_INFO_PATTERNS = [
  "## Workflow Status",
  "## Available Workflows",
  "请选择工作流",
  "请描述你要执行的任务",
  "No active workflow",
  "No workflows found",
  "There is an active workflow",
  "Workflow resumed at step",
  "Workflow cancelled",
];

export function isWorkflowInfoMessage(text: string): boolean {
  const trimmed = text.trim();
  return WORKFLOW_INFO_PATTERNS.some(pattern => trimmed.startsWith(pattern));
}

export function extractFailureReason(text: string): string {
  return text
    .replace(/<promise-check>\s*false\s*<\/promise-check>/gi, "")
    .replace(/<promise-check>\s*true\s*<\/promise-check>/gi, "")
    .trim();
}

async function routeCheckResult(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  workflow: WorkflowDef,
  state: RalphFlowState,
  step: StepDef,
  checkResponse: string,
  currentFailCount: number,
  responseTimestamp: string
): Promise<boolean> {
  const checkResult = detectCheckTag(checkResponse);
  if (checkResult === null) return false;

  logCheckResult(directory, step.id, checkResult);

  const checkFailCount = checkResult ? currentFailCount : currentFailCount + 1;
  const checkRecord = createStepRecord(step.id, "check", checkResult ? "passed" : "failed", checkFailCount, undefined, responseTimestamp);
  stepRecords.push(checkRecord);

  if (checkResult) {
    if (step.on_pass === "done") {
      markCompleted(directory, { ...state, current_step: step.id, current_phase: "check", fail_count: currentFailCount });
      logWorkflowEnd(directory, state.workflow_name);
      generateCompletionReport(directory, state.workflow_name, stepRecords);
      stepRecords = [];
      currentStepStartTime = null;
      await injectPrompt(client, sessionId, "## Workflow Completed\n\nAll steps have passed verification. The workflow has been marked as completed.", directory, true);
    } else {
      const nextStep = getStep(workflow, step.on_pass);
      if (nextStep) {
        writeState(directory, { ...state, current_step: nextStep.id, current_phase: "do", fail_count: 0 });
        logStepStart(directory, nextStep.id, "do");
        await processDoCheckCycle(client, sessionId, directory, workflow, state, nextStep, 0);
      }
    }
  } else {
    const newFailCount = currentFailCount + 1;
    logFailCountIncrement(directory, step.id, newFailCount);

    if (newFailCount >= step.max_fail_count) {
      markPaused(directory, { ...state, fail_count: newFailCount });
      logWorkflowPaused(directory, state.workflow_name, step.id, newFailCount);
      const pauseMsg = `## Workflow Paused

**Step** \`${step.id}\` - ${step.desc} failed check after ${newFailCount}/${step.max_fail_count} attempts.

### Next Steps
1. Review the failure reason above and fix the issues
2. Run \`/ralphflow continue\` to retry from the current step
3. Or run \`/ralphflow cancel\` to stop the workflow`;
      await injectPrompt(client, sessionId, pauseMsg, directory, true);
    } else {
      const nextStep = getStep(workflow, step.on_fail);
      if (nextStep) {
        const failureReason = extractFailureReason(checkResponse);
        writeState(directory, { ...state, current_step: nextStep.id, current_phase: "do", fail_count: newFailCount });
        logStepStart(directory, nextStep.id, "do");
        await processDoCheckCycle(client, sessionId, directory, workflow, state, nextStep, newFailCount, failureReason);
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
  const cycleStart = new Date().toISOString();

  const doPrompt = buildDoPrompt(step, state.user_task, retryContext);
  const doResponse = await injectPrompt(client, sessionId, doPrompt, directory);

  if (doResponse === null || !detectDoneTag(doResponse)) return;

  const doRecord = createStepRecord(step.id, "do", "passed", 0, undefined, cycleStart);
  stepRecords.push(doRecord);

  const checkState: RalphFlowState = {
    ...state,
    current_step: step.id,
    current_phase: "check",
    fail_count: failCount,
  };
  writeState(directory, checkState);
  logStepStart(directory, step.id, "check");

  const checkPrompt = buildCheckPrompt(step, state.user_task);
  const checkResponse = await injectPrompt(client, sessionId, checkPrompt, directory);

  if (checkResponse === null) return;

  await routeCheckResult(client, sessionId, directory, workflow, state, step, checkResponse, failCount, cycleStart);
}

export async function injectPrompt(
  client: OpencodeClient,
  sessionId: string,
  prompt: string,
  directory: string,
  noReply: boolean = false
): Promise<string | null> {
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
      return parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n") || null;
    }
    return null;
  } catch (error) {
    logError(directory, "inject_prompt_failed", error);
    return null;
  }
}

export async function handleSessionIdle(
  client: OpencodeClient,
  sessionId: string,
  directory: string,
  workflow: WorkflowDef
): Promise<void> {
  if (isProcessingIdle) return;
  isProcessingIdle = true;
  try {
    const state = readState(directory);
    if (!state || !state.active) return;

    // 暂停状态（会话关闭或超过最大失败次数）不自动继续
    if (state.paused) return;

    const currentStep = getStep(workflow, state.current_step);
    if (!currentStep) return;

    const responseText = await getLastAssistantMessage(client, sessionId, directory);
    const now = new Date().toISOString();

    if (state.current_phase === "do") {
      if (detectDoneTag(responseText)) {
        logDoneDetected(directory, state.current_step);

        const doRecord = createStepRecord(state.current_step, "do", "passed", 0, undefined, currentStepStartTime || now);
        stepRecords.push(doRecord);

        const newState: RalphFlowState = {
          ...state,
          current_phase: "check",
          fail_count: 0,
        };
        writeState(directory, newState);
        logStepStart(directory, state.current_step, "check");

        currentStepStartTime = now;

        const checkPrompt = buildCheckPrompt(currentStep, state.user_task);
        const checkResponse = await injectPrompt(client, sessionId, checkPrompt, directory);

        if (checkResponse !== null) {
          const handled = await routeCheckResult(client, sessionId, directory, workflow, state, currentStep, checkResponse, state.fail_count, currentStepStartTime || now);
          if (handled) return;
        }
      }
      return;
    }

    // check 阶段
    const checkResult = detectCheckTag(responseText);
    if (checkResult !== null) {
      const handled = await routeCheckResult(client, sessionId, directory, workflow, state, currentStep, responseText, state.fail_count, currentStepStartTime || now);
      if (handled) return;
    }

    if (detectDoneTag(responseText)) {
      const checkPrompt = buildCheckPrompt(currentStep, state.user_task) + "\n\n请输出check结果，不要输出done标记。";
      const reCheckResponse = await injectPrompt(client, sessionId, checkPrompt, directory);
      if (reCheckResponse !== null) {
        const handled = await routeCheckResult(client, sessionId, directory, workflow, state, currentStep, reCheckResponse, state.fail_count, now);
        if (handled) return;
      }
      return;
    }

    if (isWorkflowInfoMessage(responseText)) {
      return;
    }

    if (!isManualPhase(workflow, state.current_step, state.current_phase)) {
      const idlePrompt = buildIdlePrompt(currentStep, state.user_task, state.current_phase);
      const idleResponse = await injectPrompt(client, sessionId, idlePrompt, directory);
      // 立即处理AI响应中的标记，避免session.idle被丢弃后丢失
      if (idleResponse !== null) {
        await routeCheckResult(client, sessionId, directory, workflow, state, currentStep, idleResponse, state.fail_count, currentStepStartTime || now);
      }
    }
  } finally {
    isProcessingIdle = false;
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

  return buildContinuePrompt(state, step);
}
