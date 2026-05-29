export interface NormalStepDef {
  id: string;
  desc: string;
  do: string;
  input: string;
  output: string;
  check: string;
  on_pass: string;
  on_fail: string;
  max_fail_count: number;
}

export interface SubWorkflowStepDef {
  id: string;
  desc: string;
  workflow: string;
  inputs?: Record<string, string>;
  on_pass: string;
  on_fail: string;
  max_fail_count: number;
}

export type StepDef = NormalStepDef | SubWorkflowStepDef;

export function isSubWorkflowStep(step: StepDef): step is SubWorkflowStepDef {
  return "workflow" in step && typeof (step as SubWorkflowStepDef).workflow === "string";
}

export interface AdversarialCheckConfig {
  model?: {
    providerID: string;
    modelID: string;
  };
  agent?: string;
  system_prompt?: string;
}

export interface WorkflowDef {
  name: string;
  manual_step: string[];
  steps: StepDef[];
  adversarial_check?: AdversarialCheckConfig;
}

export interface RalphFlowState {
  active: boolean;
  workflow_name: string;
  current_step: string;
  current_phase: "do" | "check";
  fail_count: number;
  user_task: string;
  paused: boolean;
  last_failure_reason?: string;
  parent?: RalphFlowState;
}

export interface PluginConfig {
  default_max_fail_count: number;
  auto_cleanup_on_start: boolean;
}

export const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  default_max_fail_count: 5,
  auto_cleanup_on_start: true,
};

export interface StepExecutionRecord {
  stepId: string;
  phase: "do" | "check";
  status: "passed" | "failed";
  failCount: number;
  startTime: string;
  endTime?: string;
  error?: string;
}

export const RALPH_FLOW_DIR = "ralph-flow" as const;

export type Result<T> = 
  | { success: true; data: T }
  | { success: false; error: string };
