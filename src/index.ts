import { tool, type Plugin, type PluginModule, type Config } from "@opencode-ai/plugin";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { RALPH_COMMANDS } from "./commands.js";
import { readState, writeState, clearState, pushState, popState } from "./state.js";
import { setup } from "./setup.js";
import { handleSessionIdle, handleContinue, getStep, buildDoPrompt, buildSubWorkflowUserTask, getStepRecords, resetStepRecords, resetAdversarialCheckActive } from "./executor.js";
import { loadWorkflow, listWorkflows } from "./workflow-loader.js";
import { isSubWorkflowStep } from "./types.js";
import { logWorkflowStart, logWorkflowCancelled, logWorkflowResumed, logStepStart, logError, logWarn } from "./logger.js";
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
  resetAdversarialCheckActive(projectDir);
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
            external_directory: "allow",
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
              return "没有找到工作流。请在 .opencode/ralph-flow/workflows/ 目录创建工作流定义文件，然后再次调用 ralphflow-start 工具。";
            }
            return `请选择工作流，当前可用的有：\n${available.map(w => `- ${w.name}: ${w.desc}`).join("\n")}`;
          }

          if (!task) {
            return `请描述你要执行的任务，工作流 "${workflow}" 将根据你的需求来执行。`;
          }

          const firstStep = workflowDef.steps[0];
          if (!firstStep) {
            return "工作流没有定义任何步骤。";
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
            return "没有活跃的工作流可以继续。";
          }

          const workflow = loadWorkflow(directory, state.workflow_name);
          if (!workflow) {
            return `工作流 "${state.workflow_name}" 未找到。`;
          }

          // 重置步骤记录和并发标记，避免与历史记录重复
          resetStepRecords(context.sessionID);
          resetAdversarialCheckActive(directory);

          const previousFailCount = state.fail_count;
          const previousFailureReason = state.last_failure_reason;

          const newState: RalphFlowState = {
            ...state,
            current_phase: "do",
            fail_count: 0,
            paused: false,
            last_failure_reason: undefined,
          };
          writeState(directory, newState);
          logWorkflowResumed(directory, state.workflow_name, state.current_step);

          let resumeMsg = "";
          if (previousFailCount > 0) {
            resumeMsg = `## 工作流已恢复\n\n之前尝试次数: ${previousFailCount}`;
            if (previousFailureReason) {
              resumeMsg += `\n\n### 上次失败原因\n${previousFailureReason}`;
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
            return "没有活跃的工作流可以取消。";
          }

          clearState(directory);
          resetAdversarialCheckActive(directory);
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
            return "没有找到工作流状态。";
          }

          if (!state.active) {
            return `工作流 "${state.workflow_name}" 未激活（状态: 已完成/已取消）。`;
          }

          const workflow = loadWorkflow(directory, state.workflow_name);
          const currentStep = workflow ? getStep(workflow, state.current_step) : null;

          let status = `## 工作流状态

- **工作流**: ${state.workflow_name}
- **状态**: ${state.paused ? "已暂停" : "运行中"}
- **当前步骤**: ${state.current_step}
- **当前阶段**: ${state.current_phase}
- **失败次数**: ${state.fail_count}`;

          if (state.last_failure_reason) {
            status += `
- **上次失败原因**: ${state.last_failure_reason}`;
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
- **输入**: ${currentStep.input}
- **输出**: ${currentStep.output}
- **检查**: ${currentStep.check}
- **最大失败次数**: ${currentStep.max_fail_count}`;
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
            return "没有找到工作流。请在 .opencode/ralph-flow/workflows/ 目录创建工作流定义文件。";
          }
          return `## 可用工作流

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

      if (event.type === "session.compacted") {
        const sessionId = event.properties.sessionID;
        if (!sessionId) return;

        const state = readState(directory);
        if (!state || !state.active || state.paused) return;

        const workflow = loadWorkflow(directory, state.workflow_name);
        if (!workflow) return;

        // 压缩完成后，自动继续工作流
        await handleSessionIdle(client, sessionId, directory, workflow);
      }

      if (event.type === "session.error") {
        const error = event.properties.error;
        if (error?.name === "MessageAbortedError") {
          const state = readState(directory);
          if (state && state.active && !state.paused) {
            logWarn(directory, "session_aborted", { step: state.current_step, phase: state.current_phase });
            const pausedState: RalphFlowState = { ...state, paused: true };
            writeState(directory, pausedState);
          }
        }
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
