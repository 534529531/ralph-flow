import { tool, type Plugin, type PluginModule, type Config } from "@opencode-ai/plugin";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { RALPH_COMMANDS } from "./commands.js";
import { readState, writeState, clearState, markCancelled, pushState, popState } from "./state.js";
import { setup } from "./setup.js";
import { handleSessionIdle, handleContinue, getStep, buildDoPrompt, buildSubWorkflowUserTask, getStepRecords, resetStepRecords } from "./executor.js";
import { loadWorkflow, listWorkflows } from "./workflow-loader.js";
import { isSubWorkflowStep } from "./types.js";
import { logWorkflowStart, logWorkflowCancelled, logWorkflowResumed, logStepStart, logError } from "./logger.js";
import { generateCancellationReport } from "./report.js";
import type { WorkflowDef, RalphFlowState, StepDef, NormalStepDef } from "./types.js";
import { RALPH_FLOW_DIR } from "./types.js";

const setupDirs = new Set<string>();

function ensureSetup(directory: string): void {
  if (!setupDirs.has(directory)) {
    setup(directory);
    setupDirs.add(directory);
  }
}

const autoCleanup = (projectDir: string) => {
  const logsDir = join(projectDir, ".opencode", RALPH_FLOW_DIR, "logs");
  if (existsSync(logsDir)) {
    try {
      rmSync(logsDir, { recursive: true, force: true });
    } catch {}
  }
  clearState(projectDir);
};

const RalphFlowPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  // 插件初始化时立即执行 setup，确保 agent 配置文件在会话创建前就存在
  ensureSetup(directory);

  return {
    config: async (input: Config) => {
      input.command = input.command ?? {};
      for (const [name, def] of Object.entries(RALPH_COMMANDS)) {
        if (!input.command[name]) {
          input.command[name] = def;
        }
      }

      // 动态注册 ralph-check agent，确保第一次会话就能识别
      input.agent = input.agent ?? {};
      if (!input.agent["ralph-check"]) {
        input.agent["ralph-check"] = {
          description: "Ralph Flow check phase agent - read-only verification",
          mode: "all",
          permission: {
            edit: "deny",
            bash: "allow",
          },
        };
      }
    },

    tool: {
      "ralphflow-start": tool({
        description: "Start a workflow",
        args: {
          workflow: tool.schema.string().optional().describe("Workflow name"),
          task: tool.schema.string().optional().describe("Task description"),
        },
        async execute({ workflow, task }, context) {
          ensureSetup(directory);
          const state = readState(directory);
          if (state && state.active) {
            return `There is an active workflow "${state.workflow_name}" (step: ${state.current_step}, phase: ${state.current_phase}).

Use /ralphflow continue to resume, or /ralphflow cancel to cancel it first.`;
          }

          const workflowDef = workflow ? loadWorkflow(directory, workflow) : null;
          if (!workflowDef) {
            if (workflow) {
              const available = listWorkflows(directory);
              if (available.length > 0) {
                return `Workflow "${workflow}" not found. Available workflows:\n${available.map(w => `- ${w.name}: ${w.desc}`).join("\n")}`;
              }
            }
            const available = listWorkflows(directory);
            if (available.length === 0) {
              return "No workflows found. Please create a workflow definition in .opencode/ralph-flow/workflows/\n\nCall the ralphflow-start tool again with a workflow name once one is created.";
            }
            return `请选择工作流，当前可用的有：\n${available.map(w => `- ${w.name}: ${w.desc}`).join("\n")}`;
          }

          if (!task) {
            return `请描述你要执行的任务，工作流 "${workflow}" 将根据你的需求来执行。`;
          }

          const firstStep = workflowDef.steps[0];
          if (!firstStep) {
            return "Workflow has no steps defined.";
          }

          // 自动清理旧产物
          autoCleanup(directory);

          // 重置步骤记录
          resetStepRecords(context.sessionID);

          const newState: RalphFlowState = {
            active: true,
            workflow_name: workflow!,
            current_step: firstStep.id,
            current_phase: "do",
            fail_count: 0,
            user_task: task!,
            paused: false,
          };
          writeState(directory, newState);
          logWorkflowStart(directory, workflow!);
          logStepStart(directory, firstStep.id, "do");

          if (isSubWorkflowStep(firstStep)) {
            const subUserTask = buildSubWorkflowUserTask(firstStep, task!);
            pushState(directory, newState);

            const subWorkflow = loadWorkflow(directory, firstStep.workflow);
            if (!subWorkflow) {
              popState(directory);
              return `子工作流 "${firstStep.workflow}" 未找到。`;
            }

            const subFirstStep = subWorkflow.steps[0];
            if (!subFirstStep) {
              popState(directory);
              return `子工作流 "${firstStep.workflow}" 没有步骤。`;
            }

            const subState: RalphFlowState = {
              active: true,
              workflow_name: firstStep.workflow,
              current_step: subFirstStep.id,
              current_phase: "do",
              fail_count: 0,
              user_task: subUserTask,
              paused: false,
            };
            writeState(directory, subState);
            logStepStart(directory, subFirstStep.id, "do");

            const stepsOverview = workflowDef.steps.map((s, i) =>
              `  ${i + 1}. **${s.id}**: ${s.desc}${isSubWorkflowStep(s) ? ` (子工作流: ${s.workflow})` : ""}`
            ).join("\n");

            if (isSubWorkflowStep(subFirstStep)) {
              return `Workflow "${workflow!}" started.

Task: ${task!}

## Steps Overview
${stepsOverview}

Starting with sub-workflow: **${firstStep.id}** - ${firstStep.desc} → ${firstStep.workflow}

Sub-workflow "${firstStep.workflow}" first step is also a sub-workflow. Please run the task manually.`;
            }

            const doPrompt = buildDoPrompt(subFirstStep as NormalStepDef, subUserTask);
            return `Workflow "${workflow!}" started.

Task: ${task!}

## Steps Overview
${stepsOverview}

Starting with sub-workflow: **${firstStep.id}** - ${firstStep.desc} → ${firstStep.workflow}

---

${doPrompt}`;
          }

          const doPrompt = buildDoPrompt(firstStep, task!);

          const stepsOverview = workflowDef.steps.map((s, i) =>
            `  ${i + 1}. **${s.id}**: ${s.desc}${isSubWorkflowStep(s) ? ` (子工作流: ${s.workflow})` : ""}`
          ).join("\n");

          return `Workflow "${workflow!}" started.

Task: ${task!}

## Steps Overview
${stepsOverview}

Starting with step: **${firstStep.id}** - ${firstStep.desc}

---

${doPrompt}`;
        },
      }),

      "ralphflow-continue": tool({
        description: "Continue a paused workflow",
        args: {},
        async execute(_, context) {
          ensureSetup(directory);
          const state = readState(directory);
          if (!state || !state.active) {
            return "No active workflow to continue.";
          }

          const workflow = loadWorkflow(directory, state.workflow_name);
          if (!workflow) {
            return `Workflow "${state.workflow_name}" not found.`;
          }

          // 重置步骤记录，避免与历史记录重复
          resetStepRecords(context.sessionID);

          const previousFailCount = state.fail_count;
          const previousFailureReason = state.last_failure_reason;

          const newState: RalphFlowState = {
            ...state,
            fail_count: 0,
            paused: false,
            last_failure_reason: undefined,
          };
          writeState(directory, newState);
          logWorkflowResumed(directory, state.workflow_name, state.current_step);

          let resumeMsg = "";
          if (previousFailCount > 0) {
            resumeMsg = `## Workflow Resumed\n\nPrevious attempts: ${previousFailCount}`;
            if (previousFailureReason) {
              resumeMsg += `\n\n### Last Failure Reason\n${previousFailureReason}`;
            }
            resumeMsg += "\n\n---\n\n";
          }

          return resumeMsg + handleContinue(directory, workflow);
        },
      }),

      "ralphflow-cancel": tool({
        description: "Cancel the current workflow",
        args: {},
        async execute(_, context) {
          ensureSetup(directory);
          const state = readState(directory);
          if (!state || !state.active) {
            return "No active workflow to cancel.";
          }

          markCancelled(directory, state);
          logWorkflowCancelled(directory, state.workflow_name);
          // 生成取消报告
          const stepRecords = getStepRecords(context.sessionID);
          generateCancellationReport(directory, state.workflow_name, stepRecords);
          resetStepRecords(context.sessionID);

          return `Workflow "${state.workflow_name}" cancelled.`;
        },
      }),

      "ralphflow-status": tool({
        description: "Show workflow status",
        args: {},
        async execute() {
          ensureSetup(directory);
          const state = readState(directory);
          if (!state) {
            return "No workflow state found.";
          }

          if (!state.active) {
            return `Workflow "${state.workflow_name}" is not active (status: completed/cancelled).`;
          }

          const workflow = loadWorkflow(directory, state.workflow_name);
          const currentStep = workflow ? getStep(workflow, state.current_step) : null;

          let status = `## Workflow Status

- **Workflow**: ${state.workflow_name}
- **Status**: ${state.paused ? "paused" : "running"}
- **Current Step**: ${state.current_step}
- **Current Phase**: ${state.current_phase}
- **Fail Count**: ${state.fail_count}`;

          if (state.last_failure_reason) {
            status += `
- **Last Failure Reason**: ${state.last_failure_reason}`;
          }

          if (currentStep) {
            if (isSubWorkflowStep(currentStep)) {
              status += `

## Current Step Details

- **Description**: ${currentStep.desc}
- **Type**: Sub-workflow
- **Sub-workflow**: ${currentStep.workflow}
- **Inputs**: ${currentStep.inputs ? JSON.stringify(currentStep.inputs) : "none"}
- **Max Fail Count**: ${currentStep.max_fail_count}`;
            } else {
              status += `

## Current Step Details

- **Description**: ${currentStep.desc}
- **Task**: ${currentStep.do}
- **Input**: ${currentStep.input}
- **Output**: ${currentStep.output}
- **Check**: ${currentStep.check}
- **Max Fail Count**: ${currentStep.max_fail_count}`;
            }
          }

          return status;
        },
      }),

      "ralphflow-list": tool({
        description: "List available workflows",
        args: {},
        async execute() {
          ensureSetup(directory);
          const workflows = listWorkflows(directory);
          if (workflows.length === 0) {
            return "No workflows found. Create workflow definitions in .opencode/ralph-flow/workflows/";
          }
          return `## Available Workflows

${workflows.map(w => `- **${w.name}**: ${w.desc}`).join("\n")}`;
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId = event.properties.sessionID;
        if (!sessionId) return;

        const state = readState(directory);
        if (!state || !state.active) return;

        const workflow = loadWorkflow(directory, state.workflow_name);
        if (!workflow) return;

        await handleSessionIdle(client, sessionId, directory, workflow);
      }

      if (event.type === "session.deleted") {
        const state = readState(directory);
        if (state && state.active && !state.paused) {
          const pausedState: RalphFlowState = { ...state, paused: true };
          writeState(directory, pausedState);
        }
      }
    },
  };
}

// V1 PluginModule format (opencode >= 1.3.x)
// Loader detects isRecord(mod.default) with server property
export default {
  id: "ralph-flow",
  server: RalphFlowPlugin,
} satisfies PluginModule;

// Legacy format for older opencode versions
// Loader iterates Object.entries(mod) and calls function exports
export { RalphFlowPlugin as RalphFlow };
