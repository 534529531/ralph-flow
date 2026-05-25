import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { RalphFlowState } from "./types.js";
import { RALPH_FLOW_DIR } from "./types.js";
import { logWarn, logError } from "./logger.js";

const STATE_FILENAME = "ralph-flow.local.md";

export function getStateFile(directory: string): string {
  return join(directory, ".opencode", RALPH_FLOW_DIR, STATE_FILENAME);
}

export function parseState(content: string): RalphFlowState | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const state: RalphFlowState = {
    active: false,
    workflow_name: "",
    current_step: "",
    current_phase: "do",
    fail_count: 0,
    user_task: "",
    paused: false,
  };

  for (const line of frontmatter.split(/\r?\n/)) {
    const [key, ...valueParts] = line.split(":");
    const value = valueParts.join(":").trim();
    
    switch (key.trim()) {
      case "active":
        state.active = value === "true";
        break;
      case "workflow_name":
        state.workflow_name = value;
        break;
      case "current_step":
        state.current_step = value;
        break;
      case "current_phase":
        state.current_phase = value === "check" ? "check" : "do";
        break;
      case "fail_count":
        state.fail_count = parseInt(value) || 0;
        break;
      case "user_task":
        state.user_task = value;
        break;
      case "paused":
        state.paused = value === "true";
        break;
    }
  }

  return state;
}

export function serializeState(state: RalphFlowState): string {
  const lines = [
    "---",
    `active: ${state.active}`,
    `workflow_name: ${state.workflow_name}`,
    `current_step: ${state.current_step}`,
    `current_phase: ${state.current_phase}`,
    `fail_count: ${state.fail_count}`,
    `user_task: ${state.user_task}`,
    `paused: ${state.paused}`,
    "---",
  ];
  return lines.join("\n");
}

export function readState(directory: string): RalphFlowState | null {
  try {
    const stateFile = getStateFile(directory);
    if (existsSync(stateFile)) {
      const content = readFileSync(stateFile, "utf-8");
      const state = parseState(content);
      if (!state) {
        // 解析失败，删除损坏的状态文件
        logWarn(directory, "state_file_corrupted", { file: stateFile });
        try {
          unlinkSync(stateFile);
        } catch (deleteError) {
          logError(directory, "state_file_delete_failed", deleteError);
        }
      }
      return state;
    }
  } catch (error) {
    logError(directory, "state_read_failed", error);
  }
  return null;
}

export function writeState(directory: string, state: RalphFlowState): void {
  try {
    const stateFile = getStateFile(directory);
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, serializeState(state));
  } catch (error) {
    logError(directory, "state_write_failed", error);
  }
}

export function clearState(directory: string): void {
  try {
    const stateFile = getStateFile(directory);
    if (existsSync(stateFile)) unlinkSync(stateFile);
  } catch (error) {
    logError(directory, "state_clear_failed", error);
  }
}

export function markCompleted(directory: string, state: RalphFlowState): void {
  const completedState: RalphFlowState = {
    ...state,
    active: false,
  };
  writeState(directory, completedState);
}

export function markCancelled(directory: string, state: RalphFlowState): void {
  const cancelledState: RalphFlowState = {
    ...state,
    active: false,
  };
  writeState(directory, cancelledState);
}

export function markPaused(directory: string, state: RalphFlowState): void {
  writeState(directory, { ...state, paused: true });
}
