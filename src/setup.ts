import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RALPH_FLOW_DIR } from "./types.js";
import { logWarn, logError } from "./logger.js";

function getPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return dirname(dirname(__filename));
}

function setupWorkflows(projectDir: string): void {
  const pluginRoot = getPluginRoot();
  const pluginWorkflowsDir = join(pluginRoot, "workflows");
  const projectWorkflowsDir = join(projectDir, ".opencode", RALPH_FLOW_DIR, "workflows");

  if (!existsSync(projectWorkflowsDir)) {
    mkdirSync(projectWorkflowsDir, { recursive: true });
  }

  if (!existsSync(pluginWorkflowsDir)) return;

  try {
    const files = readdirSync(pluginWorkflowsDir);
    for (const file of files) {
      if (file.endsWith(".yaml") || file.endsWith(".yml")) {
        const src = join(pluginWorkflowsDir, file);
        const dest = join(projectWorkflowsDir, file);
        if (existsSync(src)) {
          try {
            cpSync(src, dest);
          } catch (copyError) {
            logWarn(projectDir, "workflow_copy_failed", { file, error: String(copyError) });
          }
        }
      }
    }
  } catch (error) {
    logWarn(projectDir, "workflow_scan_failed", { dir: pluginWorkflowsDir, error: String(error) });
  }
}

function setupCheckAgent(projectDir: string): void {
  const agentsDir = join(projectDir, ".opencode", "agents");
  const agentFile = join(agentsDir, "ralph-check.md");

  if (existsSync(agentFile)) {
    return;
  }

  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
  }

  const agentContent = `---
description: Ralph Flow check phase agent - read-only verification
mode: all
permission:
  edit: deny
  bash: allow
---
你是 Ralph Flow 检查阶段的专用 agent。

## 核心原则

1. **只检查，不修改** - 你只能读取和验证，不能修改任何文件
2. **执行验证命令** - 可以运行测试、检查文件、查看状态
3. **输出结论** - 根据检查结果输出通过或不通过

## 可用操作

- 运行测试命令（npm test、pytest 等）
- 查看文件内容（cat、head、tail）
- 搜索代码（grep、find）
- 检查 git 状态（git status、git diff）
- 其他验证命令

## 输出格式

检查完成后输出：
- \`<promise-check>true</promise-check>\` - 通过
- \`<promise-check>false</promise-check>\` - 不通过（附原因）
`;

  try {
    writeFileSync(agentFile, agentContent, "utf-8");
  } catch (error) {
    logWarn(projectDir, "check_agent_setup_failed", { error: String(error) });
  }
}

function setupPackageJson(projectDir: string): void {
  const packageJsonPath = join(projectDir, ".opencode", RALPH_FLOW_DIR, "package.json");
  const requiredDeps = { "js-yaml": "^4.1.0" };

  if (!existsSync(dirname(packageJsonPath))) {
    mkdirSync(dirname(packageJsonPath), { recursive: true });
  }

  if (existsSync(packageJsonPath)) {
    try {
      const existing = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      const mergedDeps = { ...existing.dependencies, ...requiredDeps };
      const merged = { ...existing, dependencies: mergedDeps };
      writeFileSync(packageJsonPath, JSON.stringify(merged, null, 2));
    } catch (error) {
      logWarn(projectDir, "package_json_merge_failed", { error: String(error) });
      const newPackageJson = { dependencies: requiredDeps };
      writeFileSync(packageJsonPath, JSON.stringify(newPackageJson, null, 2));
    }
  } else {
    const newPackageJson = { dependencies: requiredDeps };
    writeFileSync(packageJsonPath, JSON.stringify(newPackageJson, null, 2));
  }
}

export function setup(projectDir: string): void {
  setupWorkflows(projectDir);
  setupPackageJson(projectDir);
  setupCheckAgent(projectDir);
}
