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
        if (existsSync(src) && !existsSync(dest)) {
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
}
