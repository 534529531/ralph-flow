import { tool, type Plugin, type PluginModule, type Config } from "@opencode-ai/plugin";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { RALPH_COMMANDS } from "./commands.js";
import { readState, writeState, clearState, markCancelled } from "./state.js";
import { setup } from "./setup.js";
import { handleSessionIdle, getStep, buildDoPrompt, buildContinuePrompt, getStepRecords, resetStepRecords } from "./executor.js";
import { logWorkflowStart, logWorkflowCancelled, logWorkflowResumed, logStepStart, logError } from "./logger.js";
import { generateCancellationReport } from "./report.js";
import type { WorkflowDef, RalphFlowState } from "./types.js";
import { RALPH_FLOW_DIR } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, "..");
const PLUGIN_WORKFLOWS_DIR = join(PLUGIN_ROOT, "workflows");

const setupDirs = new Set<string>();

function ensureSetup(directory: string): void {
  if (!setupDirs.has(directory)) {
    setup(directory);
    setupDirs.add(directory);
  }
}

function parseWorkflowFile(filePath: string, workflowName: string): WorkflowDef | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as any;
    return {
      name: workflowName,
      manual_phase: (parsed.manual_phase || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      steps: parsed.steps || [],
    };
  } catch {
    return null;
  }
}

function loadWorkflow(directory: string, workflowName: string): WorkflowDef | null {
  const projectPath = join(directory, ".opencode", RALPH_FLOW_DIR, "workflows", `${workflowName}.yaml`);
  if (existsSync(projectPath)) {
    const result = parseWorkflowFile(projectPath, workflowName);
    if (result) return result;
  }

  const pluginPath = join(PLUGIN_WORKFLOWS_DIR, `${workflowName}.yaml`);
  if (existsSync(pluginPath)) {
    const result = parseWorkflowFile(pluginPath, workflowName);
    if (result) return result;
  }

  return null;
}

function listWorkflows(directory: string): Array<{ name: string; desc: string }> {
  const workflows: Map<string, { name: string; desc: string }> = new Map();

  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return;
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (file.endsWith(".yaml") || file.endsWith(".yml")) {
          try {
            const content = readFileSync(join(dir, file), "utf-8");
            const parsed = yaml.load(content) as any;
            const name = file.replace(/\.(yaml|yml)$/, "");
            const firstStep = parsed.steps?.[0];
            workflows.set(name, {
              name,
              desc: firstStep?.desc || name,
            });
          } catch {}
        }
      }
    } catch {}
  };

  scanDir(PLUGIN_WORKFLOWS_DIR);
  scanDir(join(directory, ".opencode", RALPH_FLOW_DIR, "workflows"));

  return Array.from(workflows.values());
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
  return {
    config: async (input: Config) => {
      input.command = input.command ?? {};
      for (const [name, def] of Object.entries(RALPH_COMMANDS)) {
        if (!input.command[name]) {
          input.command[name] = def;
        }
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
          resetStepRecords();

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

          const doPrompt = buildDoPrompt(firstStep, task!);

          const stepsOverview = workflowDef.steps.map((s, i) =>
            `  ${i + 1}. **${s.id}**: ${s.desc}`
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

          const currentStep = getStep(workflow, state.current_step);
          if (!currentStep) {
            return `Step "${state.current_step}" not found in workflow.`;
          }

          // 重置步骤记录，避免与历史记录重复
          resetStepRecords();

          const newState: RalphFlowState = {
            ...state,
            fail_count: 0,
            paused: false,
          };
          writeState(directory, newState);
          logWorkflowResumed(directory, state.workflow_name, state.current_step);

          const prompt = buildContinuePrompt(state, currentStep);

          return `Workflow resumed at step "${state.current_step}" (${state.current_phase} phase).

---

${prompt}`;
        },
      }),

      "ralphflow-cancel": tool({
        description: "Cancel the current workflow",
        args: {},
        async execute() {
          ensureSetup(directory);
          const state = readState(directory);
          if (!state || !state.active) {
            return "No active workflow to cancel.";
          }

          markCancelled(directory, state);
          logWorkflowCancelled(directory, state.workflow_name);
          // 生成取消报告
          const stepRecords = getStepRecords();
          generateCancellationReport(directory, state.workflow_name, stepRecords);
          resetStepRecords();

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

          if (currentStep) {
            status += `

## Current Step Details

- **Description**: ${currentStep.desc}
- **Task**: ${currentStep.do}
- **Input**: ${currentStep.input}
- **Output**: ${currentStep.output}
- **Check**: ${currentStep.check}
- **Max Fail Count**: ${currentStep.max_fail_count}`;
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
        ensureSetup(directory);
        const sessionId = event.properties.sessionID;
        if (!sessionId) return;

        const state = readState(directory);
        if (!state || !state.active) return;

        const workflow = loadWorkflow(directory, state.workflow_name);
        if (!workflow) return;

        await handleSessionIdle(client, sessionId, directory, workflow);
      }

      if (event.type === "session.deleted") {
        ensureSetup(directory);
        const state = readState(directory);
        if (state && state.active && !state.paused) {
          const pausedState: RalphFlowState = { ...state, paused: true };
          writeState(directory, pausedState);
        }
      }
    },
  };
}

export const RalphFlow: PluginModule = {
  server: RalphFlowPlugin,
};
