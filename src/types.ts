export interface StepDef {
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

export interface WorkflowDef {
  name: string;
  manual_phase: string[];
  steps: StepDef[];
}

export interface RalphFlowState {
  active: boolean;
  workflow_name: string;
  current_step: string;
  current_phase: "do" | "check";
  fail_count: number;
  user_task: string;
  paused: boolean;
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
