import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import type { RalphFlowState } from "./types.js";
import { RALPH_FLOW_DIR } from "./types.js";
import { logWarn, logError } from "./logger.js";

const STATE_FILENAME = "ralph-flow.local.md";
const STACK_FILENAME = "state-stack.json";

function encodeUserTask(task: string): string {
  return task.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function decodeUserTask(encoded: string): string {
  return encoded.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

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

  let inFailureReason = false;
  let failureReasonLines: string[] = [];

  for (const line of frontmatter.split(/\r?\n/)) {
    if (inFailureReason) {
      if (line.startsWith("  ")) {
        failureReasonLines.push(line.substring(2));
        continue;
      } else {
        state.last_failure_reason = failureReasonLines.join("\n").trim() || undefined;
        inFailureReason = false;
      }
    }

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
        state.user_task = decodeUserTask(value);
        break;
      case "paused":
        state.paused = value === "true";
        break;
      case "last_failure_reason":
        if (value === "") {
          inFailureReason = true;
          failureReasonLines = [];
        } else {
          state.last_failure_reason = value;
        }
        break;
    }
  }

  if (inFailureReason && failureReasonLines.length > 0) {
    state.last_failure_reason = failureReasonLines.join("\n").trim() || undefined;
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
    `user_task: ${encodeUserTask(state.user_task)}`,
    `paused: ${state.paused}`,
  ];

  if (state.last_failure_reason) {
    const reasonLines = state.last_failure_reason.split("\n");
    if (reasonLines.length === 1) {
      lines.push(`last_failure_reason: ${state.last_failure_reason}`);
    } else {
      lines.push("last_failure_reason:");
      for (const line of reasonLines) {
        lines.push(`  ${line}`);
      }
    }
  }

  lines.push("---");
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
  clearStack(directory);
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

function getStackFile(directory: string): string {
  return join(directory, ".opencode", RALPH_FLOW_DIR, STACK_FILENAME);
}

export function pushState(directory: string, state: RalphFlowState): void {
  try {
    const stackFile = getStackFile(directory);
    mkdirSync(dirname(stackFile), { recursive: true });
    const stack: RalphFlowState[] = existsSync(stackFile)
      ? JSON.parse(readFileSync(stackFile, "utf-8"))
      : [];
    const { parent, ...stateWithoutParent } = state;
    stack.push(stateWithoutParent);
    writeFileSync(stackFile, JSON.stringify(stack, null, 2));
  } catch (error) {
    logError(directory, "state_push_failed", error);
  }
}

export function popState(directory: string): RalphFlowState | null {
  try {
    const stackFile = getStackFile(directory);
    if (!existsSync(stackFile)) return null;
    const stack: RalphFlowState[] = JSON.parse(readFileSync(stackFile, "utf-8"));
    if (stack.length === 0) return null;
    const parentState = stack.pop()!;
    writeFileSync(stackFile, JSON.stringify(stack, null, 2));
    return parentState;
  } catch (error) {
    logError(directory, "state_pop_failed", error);
    return null;
  }
}

export function clearStack(directory: string): void {
  try {
    const stackFile = getStackFile(directory);
    if (existsSync(stackFile)) unlinkSync(stackFile);
  } catch (error) {
    logError(directory, "state_stack_clear_failed", error);
  }
}

export function getStackDepth(directory: string): number {
  try {
    const stackFile = getStackFile(directory);
    if (!existsSync(stackFile)) return 0;
    const stack: RalphFlowState[] = JSON.parse(readFileSync(stackFile, "utf-8"));
    return stack.length;
  } catch {
    return 0;
  }
}
