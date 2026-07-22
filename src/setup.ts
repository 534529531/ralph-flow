/**
 * Project setup — opencode adapter.
 *
 * - Writes the read-only ralph-check agent into the GLOBAL
 *   ~/.config/opencode/agent/ (the plugin also registers it in-memory via the
 *   config hook, so the file is only a belt-and-suspenders discovery path) —
 *   never the project.
 * - Syncs the plugin's skills into the GLOBAL ~/.config/opencode/skills/
 *   (opencode discovers skills from fixed filesystem locations only; the
 *   global one keeps the user's project tree clean). A managed marker keeps
 *   user-authored skills untouched while plugin-owned copies follow updates.
 * - Cleans up leftovers: pre-2.0 workflow copies that would SHADOW the
 *   plugin's updated built-ins (parked as *.pre-2.0-backup), and the
 *   per-project skill copies a 2.0.x–2.1.x setup used to write.
 *
 * The Claude version needs none of this (skills/agents ship inside the plugin
 * package; built-ins were never copied), so this file is adapter-only.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, renameSync, rmSync, statSync, appendFileSync } from "fs";
import { join, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { RALPH_FLOW_DIR, RALPH_CHECK_AGENT_PERMISSION } from "./engine.js";

function getPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return dirname(dirname(__filename));
}

// File-only diagnostics: the plugin shares the opencode TUI process, so console
// output would corrupt the display. Mirror of engine.ts's diag (see there).
// Setup deals with global agent/skills, so its log lives under the global home.
function diag(...args: unknown[]): void {
  try {
    const cfg = getGlobalConfigHome();
    const base = cfg ? join(cfg, RALPH_FLOW_DIR) : undefined;
    if (!base) return;
    const dir = join(base, "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "plugin-diag.log"),
      `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}\n`
    );
  } catch {}
}

/** opencode's global config home (honors XDG_CONFIG_HOME), or null. */
function getGlobalConfigHome(): string | null {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "opencode");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return null;
  return join(home, ".config", "opencode");
}

const MANAGED_MARKER = ".ralph-flow-managed";

// The permission block is generated from the single source of truth
// (RALPH_CHECK_AGENT_PERMISSION) so the on-disk agent file and the in-memory
// agent registered in index.ts can never drift apart.
const AGENT_FRONTMATTER = yaml.dump(
  { description: "Ralph Flow 检查阶段 agent —— 只读验证", mode: "all", permission: RALPH_CHECK_AGENT_PERMISSION },
  { lineWidth: -1, quotingType: '"' }
).trimEnd();

const AGENT_CONTENT = `---
${AGENT_FRONTMATTER}
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

/**
 * Write the read-only ralph-check agent into opencode's GLOBAL agent dir
 * (~/.config/opencode/agent/, which opencode discovers), NOT the project — the
 * plugin also registers this agent in-memory via the `config` hook (see
 * index.ts), so this file is a belt-and-suspenders discovery path that keeps
 * the user's project tree clean. opencode reads both `agent/` and `agents/`;
 * we use the singular to match its `command/` convention.
 */
function setupCheckAgent(): void {
  const cfgHome = getGlobalConfigHome();
  if (!cfgHome) return;
  const agentFile = join(cfgHome, "agent", "ralph-check.md");
  // Refresh only our own managed file; never clobber a user's ralph-check.md.
  if (existsSync(agentFile) && !existsSync(agentFile + MANAGED_MARKER)) return;
  try {
    mkdirSync(dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, AGENT_CONTENT, "utf-8");
    writeFileSync(agentFile + MANAGED_MARKER, "由 ralph-flow 托管；删除此文件即可自行接管\n");
  } catch (e) {
    diag("[ralph-flow] check agent setup failed:", e);
  }
}

/**
 * Remove the per-project agent copy a 2.0.x–2.1.x setup wrote into
 * .opencode/agents/, which polluted the user's tree. Only removes our exact
 * file (and the dir if it's then empty); leaves any other agents alone.
 */
function cleanupProjectAgentCopy(projectDir: string): void {
  const agentsDir = join(projectDir, ".opencode", "agents");
  const agentFile = join(agentsDir, "ralph-check.md");
  if (!existsSync(agentFile)) return;
  try {
    rmSync(agentFile, { force: true });
    if (readdirSync(agentsDir).length === 0) rmSync(agentsDir, { recursive: false });
  } catch {}
}

/**
 * Sync the plugin's bundled skills into opencode's GLOBAL skills dir
 * (~/.config/opencode/skills/), NOT the project — opencode's `skill` tool only
 * discovers skills from fixed filesystem locations, and the global one keeps
 * the user's project tree clean while making any bundled skills available in
 * every project (the closest analogue to the Claude Code plugin, which loads
 * its skills straight from the plugin package).
 *
 * Only dirs carrying the managed marker (or not existing yet) are written, so a
 * user's own skill with the same name is never clobbered. Managed copies are
 * refreshed on every startup so they track the installed plugin version.
 */
function setupSkills(): void {
  const pluginSkillsDir = join(getPluginRoot(), "skills");
  if (!existsSync(pluginSkillsDir)) return;
  const cfgHome = getGlobalConfigHome();
  if (!cfgHome) return;
  const globalSkillsDir = join(cfgHome, "skills");

  let entries: string[];
  try { entries = readdirSync(pluginSkillsDir); } catch { return; }
  for (const name of entries) {
    const src = join(pluginSkillsDir, name);
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch { continue; }
    const dest = join(globalSkillsDir, name);
    if (existsSync(dest) && !existsSync(join(dest, MANAGED_MARKER))) continue; // user-authored — hands off
    try {
      cpSync(src, dest, { recursive: true, force: true });
      writeFileSync(join(dest, MANAGED_MARKER), "This skill is managed by the ralph-flow plugin and refreshed on startup. Remove this marker file to take ownership.\n");
    } catch (e) {
      diag(`[ralph-flow] skill sync failed (${name}):`, e);
    }
  }
}

/**
 * Remove skill copies a previous 2.0.x–2.1.x wrote into the PROJECT
 * (.opencode/skills/), which polluted the user's tree. Only our own managed
 * copies are removed; user-authored skills are left untouched.
 */
function cleanupProjectSkillCopies(projectDir: string): void {
  const projectSkillsDir = join(projectDir, ".opencode", "skills");
  if (!existsSync(projectSkillsDir)) return;
  let entries: string[];
  try { entries = readdirSync(projectSkillsDir); } catch { return; }
  for (const name of entries) {
    const dir = join(projectSkillsDir, name);
    if (existsSync(join(dir, MANAGED_MARKER))) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  // Drop the skills dir if it is now empty (never remove a non-empty one).
  try { readdirSync(projectSkillsDir).length === 0 && rmSync(projectSkillsDir, { recursive: false }); } catch {}
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
        diag(`[ralph-flow] Parked pre-2.0 workflow copy ${name} as ${name}.pre-2.0-backup (built-ins now resolve from the plugin)`);
      } catch {}
    }
  }
  // The old setup also wrote this dependency stub; it is dead in 2.0.
  try { renameSync(legacyPackageJson, legacyPackageJson + ".pre-2.0-backup"); } catch {}
}

export function setup(projectDir: string): void {
  cleanupLegacyWorkflowCopies(projectDir);
  cleanupProjectSkillCopies(projectDir);
  cleanupProjectAgentCopy(projectDir);
  setupCheckAgent();
  setupSkills();
}
