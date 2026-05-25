import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import type { WorkflowDef, StepDef, StepExecutionRecord } from "./types.js";
import { RALPH_FLOW_DIR } from "./types.js";

export interface WorkflowReport {
  workflowName: string;
  status: "completed" | "cancelled" | "paused";
  totalSteps: number;
  totalFailures: number;
  startTime: string;
  endTime: string;
  duration: string;
  steps: StepExecutionRecord[];
}

function getReportFile(directory: string): string {
  return join(directory, ".opencode", RALPH_FLOW_DIR, "logs", "final-report.md");
}

function ensureReportDir(directory: string): void {
  const reportDir = join(directory, ".opencode", RALPH_FLOW_DIR, "logs");
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }
}

function formatDuration(startTime: string, endTime: string): string {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const durationMs = end - start;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  
  if (minutes > 0) {
    return `${minutes}分钟${seconds}秒`;
  }
  return `${seconds}秒`;
}

function generateReportMarkdown(report: WorkflowReport): string {
  const lines: string[] = [
    "# 工作流执行报告",
    "",
    "## 执行摘要",
    "",
    `- **工作流**: ${report.workflowName}`,
    `- **状态**: ${report.status}`,
    `- **总步骤数**: ${report.totalSteps}`,
    `- **失败次数**: ${report.totalFailures}`,
    `- **总耗时**: ${report.duration}`,
    "",
    "## 步骤执行情况",
    "",
  ];

  for (let i = 0; i < report.steps.length; i++) {
    const step = report.steps[i];
    const statusIcon = step.status === "passed" ? "✓" : "✗";
    lines.push(`### ${i + 1}. ${step.stepId} (${step.phase}) ${statusIcon}`);
    lines.push(`- 状态：${step.status === "passed" ? "通过" : "失败"}`);
    
    if (step.failCount > 0) {
      lines.push(`- 失败次数：${step.failCount}`);
    }
    
    if (step.error) {
      lines.push(`- 失败原因：${step.error}`);
    }
    
    if (step.startTime && step.endTime) {
      lines.push(`- 耗时：${formatDuration(step.startTime, step.endTime)}`);
    }
    
    lines.push("");
  }

  lines.push("## 建议");
  lines.push("");
  lines.push("（由 LLM 生成）");
  lines.push("");

  return lines.join("\n");
}

export function createStepRecord(
  stepId: string,
  phase: "do" | "check",
  status: "passed" | "failed",
  failCount: number,
  error?: string,
  startTime?: string
): StepExecutionRecord {
  const now = new Date().toISOString();
  return {
    stepId,
    phase,
    status,
    failCount,
    startTime: startTime || now,
    endTime: now,
    error,
  };
}

export function generateReport(
  directory: string,
  workflowName: string,
  status: "completed" | "cancelled" | "paused",
  steps: StepExecutionRecord[]
): void {
  try {
    ensureReportDir(directory);
    
    const totalFailures = steps.reduce((sum, step) => sum + step.failCount, 0);
    const startTime = steps.length > 0 ? steps[0].startTime : new Date().toISOString();
    const endTime = steps.length > 0 ? steps[steps.length - 1].endTime || new Date().toISOString() : new Date().toISOString();
    
    const report: WorkflowReport = {
      workflowName,
      status,
      totalSteps: steps.length,
      totalFailures,
      startTime,
      endTime,
      duration: formatDuration(startTime, endTime),
      steps,
    };
    
    const markdown = generateReportMarkdown(report);
    const reportFile = getReportFile(directory);
    writeFileSync(reportFile, markdown);
  } catch {
    // Silently fail
  }
}

export function generateCompletionReport(
  directory: string,
  workflowName: string,
  steps: StepExecutionRecord[]
): void {
  generateReport(directory, workflowName, "completed", steps);
}

export function generateCancellationReport(
  directory: string,
  workflowName: string,
  steps: StepExecutionRecord[]
): void {
  generateReport(directory, workflowName, "cancelled", steps);
}

export function generatePauseReport(
  directory: string,
  workflowName: string,
  steps: StepExecutionRecord[]
): void {
  generateReport(directory, workflowName, "paused", steps);
}
