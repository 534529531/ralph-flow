import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import type { WorkflowDef, AdversarialCheckConfig, StepDef, NormalStepDef, SubWorkflowStepDef } from "./types.js";
import { RALPH_FLOW_DIR, isSubWorkflowStep } from "./types.js";
import { logWarn } from "./logger.js";

function getPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return dirname(dirname(__filename));
}

const PLUGIN_WORKFLOWS_DIR = join(getPluginRoot(), "workflows");

function validateStep(step: any, index: number, filePath: string): step is StepDef {
  if (!step || typeof step !== "object") {
    logWarn("", "invalid_step", { file: filePath, index, error: "Step is not an object" });
    return false;
  }

  if (!step.id || typeof step.id !== "string") {
    logWarn("", "invalid_step", { file: filePath, index, error: "Missing or invalid 'id' field" });
    return false;
  }

  if (!step.desc || typeof step.desc !== "string") {
    logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Missing or invalid 'desc' field" });
    return false;
  }

  if (!step.on_pass || typeof step.on_pass !== "string") {
    logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Missing or invalid 'on_pass' field" });
    return false;
  }

  if (!step.on_fail || typeof step.on_fail !== "string") {
    logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Missing or invalid 'on_fail' field" });
    return false;
  }

  if (typeof step.max_fail_count !== "number" || step.max_fail_count < 1) {
    logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Missing or invalid 'max_fail_count' field" });
    return false;
  }

  // Sub-workflow step
  if (step.workflow) {
    if (typeof step.workflow !== "string") {
      logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Invalid 'workflow' field" });
      return false;
    }
    return true;
  }

  // Normal step
  if (!step.do || typeof step.do !== "string") {
    logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Missing or invalid 'do' field" });
    return false;
  }

  if (!step.input || typeof step.input !== "string") {
    logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Missing or invalid 'input' field" });
    return false;
  }

  if (!step.output || typeof step.output !== "string") {
    logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Missing or invalid 'output' field" });
    return false;
  }

  if (!step.check || typeof step.check !== "string") {
    logWarn("", "invalid_step", { file: filePath, index, stepId: step.id, error: "Missing or invalid 'check' field" });
    return false;
  }

  return true;
}

export function parseWorkflowFile(filePath: string, workflowName: string): WorkflowDef | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as any;

    if (!parsed || typeof parsed !== "object") {
      logWarn("", "invalid_workflow", { file: filePath, error: "Invalid YAML content" });
      return null;
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      logWarn("", "invalid_workflow", { file: filePath, error: "Missing or empty 'steps' array" });
      return null;
    }

    const validSteps: StepDef[] = [];
    for (let i = 0; i < parsed.steps.length; i++) {
      if (validateStep(parsed.steps[i], i, filePath)) {
        validSteps.push(parsed.steps[i]);
      }
    }

    if (validSteps.length === 0) {
      logWarn("", "invalid_workflow", { file: filePath, error: "No valid steps found" });
      return null;
    }

    const adv = parsed.adversarial_check;
    let adversarial_check: AdversarialCheckConfig | undefined;
    if (adv && typeof adv === "object") {
      adversarial_check = {
        model: adv.model,
        agent: adv.agent,
        system_prompt: adv.system_prompt,
      };
    }

    return {
      name: workflowName,
      manual_phase: (parsed.manual_phase || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      steps: validSteps,
      adversarial_check,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarn("", "workflow_parse_failed", { file: filePath, error: errorMessage });
    return null;
  }
}

export function loadWorkflow(directory: string, workflowName: string): WorkflowDef | null {
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

export function listWorkflows(directory: string): Array<{ name: string; desc: string }> {
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
