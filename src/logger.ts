import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { RALPH_FLOW_DIR } from "./types.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

function getLogDir(directory: string): string {
  return join(directory, ".opencode", RALPH_FLOW_DIR, "logs");
}

function getExecutionLogFile(directory: string): string {
  return join(getLogDir(directory), "execution.log");
}

function getStepLogFile(directory: string, stepId: string, phase: string): string {
  return join(getLogDir(directory), `step-${stepId}-${phase}.log`);
}

function ensureLogDir(directory: string): void {
  const logDir = getLogDir(directory);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

function formatLogEntry(entry: LogEntry): string {
  return JSON.stringify(entry) + "\n";
}

export function logEvent(
  directory: string,
  level: LogLevel,
  event: string,
  extra?: Record<string, unknown>
): void {
  try {
    ensureLogDir(directory);
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...extra,
    };
    const logFile = getExecutionLogFile(directory);
    appendFileSync(logFile, formatLogEntry(entry));
  } catch {
    // Silently fail to avoid recursive errors
  }
}

export function logStepEvent(
  directory: string,
  stepId: string,
  phase: string,
  level: LogLevel,
  event: string,
  extra?: Record<string, unknown>
): void {
  try {
    ensureLogDir(directory);
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      step: stepId,
      phase,
      ...extra,
    };
    const stepLogFile = getStepLogFile(directory, stepId, phase);
    appendFileSync(stepLogFile, formatLogEntry(entry));
    // Also log to execution.log
    const executionLogFile = getExecutionLogFile(directory);
    appendFileSync(executionLogFile, formatLogEntry(entry));
  } catch {
    // Silently fail to avoid recursive errors
  }
}

export function logWorkflowStart(directory: string, workflowName: string): void {
  logEvent(directory, "info", "workflow_start", { workflow: workflowName });
}

export function logWorkflowEnd(directory: string, workflowName: string): void {
  logEvent(directory, "info", "workflow_end", { workflow: workflowName });
}

export function logStepStart(directory: string, stepId: string, phase: string): void {
  logStepEvent(directory, stepId, phase, "info", "step_start");
}

export function logDoneDetected(directory: string, stepId: string): void {
  logStepEvent(directory, stepId, "do", "info", "done_detected");
}

export function logCheckResult(directory: string, stepId: string, passed: boolean): void {
  logStepEvent(directory, stepId, "check", "info", "check_result", { passed });
}

export function logFailCountIncrement(directory: string, stepId: string, failCount: number): void {
  logStepEvent(directory, stepId, "check", "warn", "fail_count_increment", { fail_count: failCount });
}

export function logWorkflowPaused(directory: string, workflowName: string, stepId: string, failCount: number): void {
  logEvent(directory, "warn", "workflow_paused", { workflow: workflowName, step: stepId, fail_count: failCount });
}

export function logWorkflowResumed(directory: string, workflowName: string, stepId: string): void {
  logEvent(directory, "info", "workflow_resumed", { workflow: workflowName, step: stepId });
}

export function logWorkflowCancelled(directory: string, workflowName: string): void {
  logEvent(directory, "info", "workflow_cancelled", { workflow: workflowName });
}

export function logError(directory: string, event: string, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logEvent(directory, "error", event, { error: errorMessage });
}

export function logWarn(directory: string, event: string, details?: Record<string, unknown>): void {
  logEvent(directory, "warn", event, details);
}

export function logInfo(directory: string, event: string, details?: Record<string, unknown>): void {
  logEvent(directory, "info", event, details);
}

export function logDebug(directory: string, event: string, details?: Record<string, unknown>): void {
  logEvent(directory, "debug", event, details);
}
