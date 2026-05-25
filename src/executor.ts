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
请执行上述任务，完成后输出 \`<promise>done</promise>\` 标记。`);

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

如果未通过，请详细说明原因。`);

  return sections.join("\n\n");
}

export function buildContinuePrompt(state: RalphFlowState, step: StepDef): string {
  if (state.current_phase === "do") {
    return buildDoPrompt(step, state.user_task);
  } else {
    return buildCheckPrompt(step, state.user_task);
  }
}

export function buildIdlePrompt(step: StepDef, userTask?: string): string {
  const parts = [`请继续完成当前任务。`];
  parts.push(`当前步骤：${step.id} - ${step.desc}`);
  if (userTask) {
    parts.push(`用户需求：${userTask}`);
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

export async function injectPrompt(
  client: OpencodeClient,
  sessionId: string,
  prompt: string,
  directory: string
): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: prompt }],
      },
    });
  } catch (error) {
    logError(directory, "inject_prompt_failed", error);
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
      
      // 创建do阶段完成记录
      const doRecord = createStepRecord(state.current_step, "do", "passed", 0, undefined, currentStepStartTime || now);
      stepRecords.push(doRecord);
      
      const newState: RalphFlowState = {
        ...state,
        current_phase: "check",
        fail_count: 0,
      };
      writeState(directory, newState);
      logStepStart(directory, state.current_step, "check");
      
      // 设置check阶段开始时间
      currentStepStartTime = now;
      
      const checkPrompt = buildCheckPrompt(currentStep, state.user_task);
      await injectPrompt(client, sessionId, checkPrompt, directory);
      return;
    }
  } else {
    // 检查是否在check阶段检测到done标记
    if (detectDoneTag(responseText)) {
      // 忽略done标记，要求LLM重新输出check结果
      const checkPrompt = buildCheckPrompt(currentStep, state.user_task) + "\n\n请输出check结果，不要输出done标记。";
      await injectPrompt(client, sessionId, checkPrompt, directory);
      return;
    }
    
    const checkResult = detectCheckTag(responseText);
    if (checkResult !== null) {
      logCheckResult(directory, state.current_step, checkResult);
      
      // 创建check阶段记录
      const checkFailCount = checkResult ? state.fail_count : state.fail_count + 1;
      const checkRecord = createStepRecord(state.current_step, "check", checkResult ? "passed" : "failed", checkFailCount, undefined, currentStepStartTime || now);
      stepRecords.push(checkRecord);
      
      if (checkResult) {
        if (currentStep.on_pass === "done") {
          markCompleted(directory, state);
          logWorkflowEnd(directory, state.workflow_name);
          // 生成最终报告
          generateCompletionReport(directory, state.workflow_name, stepRecords);
          // 重置记录数组
          stepRecords = [];
          currentStepStartTime = null;
          return;
        }
        const nextStep = getStep(workflow, currentStep.on_pass);
        if (nextStep) {
          const newState: RalphFlowState = {
            ...state,
            current_step: nextStep.id,
            current_phase: "do",
            fail_count: 0,
          };
          writeState(directory, newState);
          logStepStart(directory, nextStep.id, "do");
          
          const doPrompt = buildDoPrompt(nextStep, state.user_task);
          await injectPrompt(client, sessionId, doPrompt, directory);
        }
      } else {
        const newFailCount = state.fail_count + 1;
        logFailCountIncrement(directory, state.current_step, newFailCount);
        
        if (newFailCount >= currentStep.max_fail_count) {
          const pausedState: RalphFlowState = {
            ...state,
            fail_count: newFailCount,
          };
          markPaused(directory, pausedState);
          logWorkflowPaused(directory, state.workflow_name, state.current_step, newFailCount);
          return;
        }
        const nextStep = getStep(workflow, currentStep.on_fail);
        if (nextStep) {
          const failureReason = extractFailureReason(responseText);
          const newState: RalphFlowState = {
            ...state,
            current_step: nextStep.id,
            current_phase: "do",
            fail_count: newFailCount,
          };
          writeState(directory, newState);
          logStepStart(directory, nextStep.id, "do");
          
          const doPrompt = buildDoPrompt(nextStep, state.user_task, failureReason);
          await injectPrompt(client, sessionId, doPrompt, directory);
        }
      }
      return;
    }
  }

  // 如果最后一条助手消息是工作流信息查询结果（状态/列表等），不自动注入继续提示词
  if (isWorkflowInfoMessage(responseText)) {
    return;
  }

  if (!isManualPhase(workflow, state.current_step, state.current_phase)) {
    const idlePrompt = buildIdlePrompt(currentStep, state.user_task);
    await injectPrompt(client, sessionId, idlePrompt, directory);
  }
  } finally {
    isProcessingIdle = false;
  }
}
