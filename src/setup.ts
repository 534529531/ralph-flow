/**
 * Project setup — opencode adapter.
 *
 * - Writes the read-only ralph-check agent definition (the opencode
 *   counterpart of the Claude version's --allowedTools whitelist).
 * - Syncs the plugin's skills into .opencode/skills/ (opencode discovers
 *   skills from files only; a managed marker keeps user-authored skills
 *   untouched while plugin-owned copies follow plugin updates).
 * - Cleans up pre-2.0 leftovers: workflows the old setup used to copy (and
 *   overwrite on every startup) into the project dir would now SHADOW the
 *   plugin's updated built-ins — they are parked as *.pre-2.0-backup.
 *
 * The Claude version needs none of this (skills/agents ship inside the plugin
 * package; built-ins were never copied), so this file is adapter-only.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, renameSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RALPH_FLOW_DIR } from "./engine.js";

function getPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return dirname(dirname(__filename));
}

const MANAGED_MARKER = ".ralph-flow-managed";

function setupCheckAgent(projectDir: string): void {
  const agentsDir = join(projectDir, ".opencode", "agents");
  const agentFile = join(agentsDir, "ralph-check.md");

  if (existsSync(agentFile)) return;
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  const agentContent = `---
description: Ralph Flow check phase agent - read-only verification
mode: all
permission:
  edit: deny
  bash: allow
  external_directory: allow
---
你是 Ralph Flow 检查阶段的专用 agent。

## 核心原则

1. **只检查，不修改** - 你只能读取和验证，不能修改任何文件
2. **执行验证命令** - 可以运行测试、检查文件、查看状态
3. **输出结论** - 根据检查结果输出通过或不通过

## 可用操作

- 运行测试/构建命令（npm test、pytest、cargo test/build/clippy 等）
- 查看文件内容（cat、head、tail）
- 搜索代码（grep、find）
- 检查 git 状态（git status、git diff）
- 其他只读验证命令

## 输出格式

检查完成后输出：
- 通过：先说明通过原因，最后一行输出 \`<promise-check>true</promise-check>\`
- 不通过：先说明失败原因，最后一行输出 \`<promise-check>false</promise-check>\`

标签必须独占最后一行。
`;

  try {
    writeFileSync(agentFile, agentContent, "utf-8");
  } catch (e) {
    console.error("[ralph-flow] check agent setup failed:", e);
  }
}

/**
 * Copy the plugin's bundled skills into the project's .opencode/skills/.
 * Only dirs carrying the managed marker (or not existing yet) are written, so
 * a user's own skill with the same name is never clobbered. Managed copies are
 * refreshed on every startup so they track the installed plugin version.
 */
function setupSkills(projectDir: string): void {
  const pluginSkillsDir = join(getPluginRoot(), "skills");
  if (!existsSync(pluginSkillsDir)) return;
  const projectSkillsDir = join(projectDir, ".opencode", "skills");

  let entries: string[];
  try { entries = readdirSync(pluginSkillsDir); } catch { return; }
  for (const name of entries) {
    const src = join(pluginSkillsDir, name);
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch { continue; }
    const dest = join(projectSkillsDir, name);
    if (existsSync(dest) && !existsSync(join(dest, MANAGED_MARKER))) continue; // user-authored — hands off
    try {
      cpSync(src, dest, { recursive: true });
      writeFileSync(join(dest, MANAGED_MARKER), "This skill is managed by the ralph-flow plugin and refreshed on startup. Remove this marker file to take ownership.\n");
    } catch (e) {
      console.error(`[ralph-flow] skill sync failed (${name}):`, e);
    }
  }
}

/**
 * Pre-2.0 setup copied every built-in workflow into
 * .opencode/ralph-flow/workflows/ and OVERWROTE it on every startup — so those
 * copies cannot hold user edits, but from 2.0 on they would shadow the
 * plugin's updated built-ins forever. Park them once, visibly.
 */
function cleanupLegacyWorkflowCopies(projectDir: string): void {
  const legacyPackageJson = join(projectDir, ".opencode", RALPH_FLOW_DIR, "package.json");
  if (!existsSync(legacyPackageJson)) return; // no pre-2.0 install in this project
  const projectWorkflowsDir = join(projectDir, ".opencode", RALPH_FLOW_DIR, "workflows");
  for (const name of ["loop.yaml", "spec.yaml"]) {
    const p = join(projectWorkflowsDir, name);
    if (existsSync(p) && !existsSync(p + ".pre-2.0-backup")) {
      try {
        renameSync(p, p + ".pre-2.0-backup");
        console.error(`[ralph-flow] Parked pre-2.0 workflow copy ${name} as ${name}.pre-2.0-backup (built-ins now resolve from the plugin)`);
      } catch {}
    }
  }
  // The old setup also wrote this dependency stub; it is dead in 2.0.
  try { renameSync(legacyPackageJson, legacyPackageJson + ".pre-2.0-backup"); } catch {}
}

export function setup(projectDir: string): void {
  cleanupLegacyWorkflowCopies(projectDir);
  setupCheckAgent(projectDir);
  setupSkills(projectDir);
}
