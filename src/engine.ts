/**
 * Ralph Flow Engine for opencode — structural mirror of the Claude Code
 * plugin's mcp-server/server.mjs (sections, function names and bodies are kept
 * 1:1 wherever the platform allows; see SYNC.md for the mapping and the
 * deliberate divergences).
 *
 * Multi-instance architecture:
 * One opencode plugin instance serves ALL sessions of a project directory, so
 * "one workflow per session" maps to "one bound instance per sessionID"
 * (sessionBindings). All instance state lives under
 * .opencode/ralph-flow/instances/<instance-id>/ so multiple sessions can run
 * workflows in the same project directory in parallel.
 *
 * Session <-> instance binding:
 * - Tool calls and events carry the sessionID directly (no ppid inference
 *   needed — this replaces the Claude version's ~/.claude/sessions lookup and
 *   the PostToolUse owner-binding hook).
 * - owner-session files keep the same cross-process takeover semantics.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  input: string;
  output: string;
  on_pass: string;
  on_fail: string;
  max_fail_count: number;
}

export type StepDef = NormalStepDef | SubWorkflowStepDef;

export interface AdversarialCheckConfig {
  model?: string | { providerID?: string; modelID?: string };
  agent?: string;
  system_prompt?: string;
  timeout_ms?: number;
}

export interface WorkflowDef {
  name: string;
  description: string;
  manual_step: string[];
  steps: StepDef[];
  adversarial_check?: AdversarialCheckConfig;
}

export interface RalphFlowState {
  active: boolean;
  workflow_name: string;
  current_step: string;
  current_phase: string;
  fail_count: number;
  user_task: string;
  paused: boolean;
  pause_reason?: string;
  last_failure_reason?: string;
  instance_id?: string;
}

export interface StepExecutionRecord {
  stepId: string;
  phase: string;
  status: "passed" | "failed";
  failCount: number;
  startTime: string;
  endTime?: string;
  reason?: string;
}

export interface CheckResult {
  passed: boolean;
  infra?: boolean;
  reason: string;
}

export interface InstanceInfo {
  id: string;
  state: RalphFlowState;
  owner: string | null;
  ownerAlive: boolean;
  manualGate: boolean;
  doneTag: boolean;
  lastActivity: Date | null;
}

export interface TransitionResult {
  text: string;
  paused?: boolean;
  completed?: boolean;
}

/**
 * Platform seam — everything the engine needs from the host that differs
 * between Claude Code (ppid/pid liveness, spawned check process) and opencode
 * (sessionIDs from events, SDK check session).
 */
export interface Platform {
  /** Whether the session that owns an instance is still able to drive it. */
  isSessionAlive(sessionId: string | null): boolean;
  /** Abort a still-running adversarial check (in-process handle). */
  abortActiveCheck?(instId: string): void;
}

/**
 * Strip UTF-8 BOM (Byte Order Mark) from file content.
 * Windows Notepad and some editors add BOM to UTF-8 files.
 * js-yaml and JSON.parse don't handle BOM, causing parse failures.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const RALPH_FLOW_DIR = "ralph-flow";
const INSTANCES_DIRNAME = "instances";
const REPORTS_DIRNAME = "reports";
const STATE_FILENAME = "state.json";
const STACK_FILENAME = "state-stack.json";
const OWNER_FILENAME = "owner-session";
const LOCK_FILENAME = ".lock";
// Mirrors the Claude version's .adversarial-pid: holds the CHECK session id
// instead of a child-process pid (the opencode check runs as an SDK session,
// not a subprocess).
const ADVERSARIAL_SESSION_FILENAME = ".adversarial-session";
export const MANUAL_STEP_MARKER = ".manual-step-active";
export const MANUAL_GATE_MARKER = ".manual-gate";
export const DONE_TAG_MARKER = ".done-tag-detected";
const MAX_STEP_RECORDS = 1000;
export const MAX_NESTING_DEPTH = 5;
const MAX_WORKFLOW_FILE_SIZE = 1024 * 1024; // 1 MB

const isWin = process.platform === "win32";

export interface Engine extends ReturnType<typeof createEngine> {}

export function createEngine(projectDir: string, platform: Platform) {
  // ─── In-memory mutex for state mutations (serializes this engine's ops) ────

  let stateLock = false;
  function acquireLock(): boolean {
    if (stateLock) return false;
    stateLock = true;
    return true;
  }
  function releaseLock(): void {
    stateLock = false;
  }

  // Async lock wrapper: waits up to 30s for lock, then rejects
  async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const deadline = Date.now() + 30000;
    while (!acquireLock()) {
      if (Date.now() > deadline) throw new Error("State lock timeout");
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  }

  // ─── Atomic File I/O ────────────────────────────────────────────────────────

  function atomicWriteJson(filePath: string, data: unknown): void {
    atomicWriteText(filePath, JSON.stringify(data, null, 2));
  }

  function atomicWriteText(filePath: string, text: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = filePath + ".tmp." + process.pid;
    fs.writeFileSync(tmp, text);
    try {
      fs.renameSync(tmp, filePath);
    } catch (e: any) {
      // Windows can throw EPERM/EEXIST when renaming over an existing file that
      // is momentarily open (antivirus, indexer). Retry once after a short spin.
      if (isWin && (e.code === "EPERM" || e.code === "EEXIST" || e.code === "EACCES")) {
        try { fs.unlinkSync(filePath); } catch {}
        fs.renameSync(tmp, filePath);
      } else {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
    }
  }

  // ─── Instance Infrastructure ────────────────────────────────────────────────

  function getRalphFlowDir(): string {
    return path.join(projectDir, ".opencode", RALPH_FLOW_DIR);
  }

  function getInstancesRoot(): string {
    return path.join(getRalphFlowDir(), INSTANCES_DIRNAME);
  }

  function getReportsDir(): string {
    return path.join(getRalphFlowDir(), REPORTS_DIRNAME);
  }

  // Per-instance artifacts directory. Lives OUTSIDE instances/<id>/ because the
  // instance dir is deleted on completion/cancel (destroyInstance) — artifacts
  // are workflow deliverables that must survive the workflow and stay isolated
  // between parallel instances.
  const ARTIFACTS_DIRNAME = "artifacts";
  const ARTIFACTS_NAME_FILENAME = "artifacts-dir";

  // OpenSpec-style human-readable dir name: short task summary + instance-id
  // suffix so parallel instances of the same task never collide.
  function makeArtifactsDirName(task: string, instId: string): string {
    // Truncate by code point (Array.from), not UTF-16 unit: a plain slice() can
    // cut an emoji in half, leaving a lone surrogate that round-trips through
    // the utf-8 name file as U+FFFD — the prompt and the file would then name
    // two different directories. Dash-trim runs after the cut for the same
    // reason (the cut itself can expose a trailing dash).
    const slug = Array.from(
      String(task || "").trim()
        .replace(/\s+/g, "-")
        .replace(/[\\/:*?"'`<>|.$&(){}[\];!#~^]/g, "")
    ).slice(0, 30).join("").replace(/^-+|-+$/g, "");
    const suffix = String(instId).split("-").pop() || "0";
    return slug ? `${slug}-${suffix}` : String(instId);
  }

  // The name is fixed at workflow start and read back from the instance dir —
  // sub-workflow pushes rewrite state.json (including user_task), so the name
  // cannot be re-derived from state later.
  function writeArtifactsDirName(instId: string, task: string): void {
    atomicWriteText(instPath(ARTIFACTS_NAME_FILENAME, instId), makeArtifactsDirName(task, instId));
  }

  function getArtifactsDirName(instId?: string): string {
    try {
      const v = stripBom(fs.readFileSync(instPath(ARTIFACTS_NAME_FILENAME, instId), "utf-8")).trim();
      // A hand-edited name file must not be able to walk out of the artifacts
      // root (this path is joined and later mkdir'd/rmdir'd).
      if (v && !v.includes("/") && !v.includes("\\") && !v.includes("..")) return v;
    } catch {}
    return reqInst(instId);
  }

  function getArtifactsDir(instId?: string): string {
    return path.join(getRalphFlowDir(), ARTIFACTS_DIRNAME, getArtifactsDirName(instId));
  }

  // Project-relative form with forward slashes, embeddable in DO/CHECK prompts
  // (both the session and the adversarial checker run with cwd = projectDir).
  function getArtifactsRelDir(instId?: string): string {
    return `.opencode/${RALPH_FLOW_DIR}/${ARTIFACTS_DIRNAME}/${getArtifactsDirName(instId)}`;
  }

  // Internal escape hatch only: {{artifacts_dir}} in step text still resolves,
  // but workflow authors never need it — every DO/CHECK prompt carries a 产出目录
  // section pointing at the same path.
  const ARTIFACTS_TOKEN = "{{artifacts_dir}}";

  function renderStepText(text: string): string {
    if (typeof text !== "string" || !text.includes(ARTIFACTS_TOKEN)) return text;
    return text.split(ARTIFACTS_TOKEN).join(getArtifactsRelDir());
  }

  // Extra read-access dirs for the adversarial checker, declared explicitly at
  // ralphflow_start for tasks whose source material lives outside the project
  // dir. Stored as an instance file so sub-workflow state pushes can't drop them.
  const EXTRA_DIRS_FILENAME = "extra-dirs";

  function writeExtraDirs(instId: string, dirs: string[]): void {
    if (Array.isArray(dirs) && dirs.length > 0) {
      atomicWriteJson(instPath(EXTRA_DIRS_FILENAME, instId), dirs);
    }
  }

  function readExtraDirs(instId?: string): string[] {
    try {
      const v = JSON.parse(stripBom(fs.readFileSync(instPath(EXTRA_DIRS_FILENAME, instId), "utf-8")));
      if (Array.isArray(v)) return v.filter((d) => typeof d === "string");
    } catch {}
    return [];
  }

  function getInstanceDir(instId: string): string {
    return path.join(getInstancesRoot(), instId);
  }

  // The instance the CURRENT operation is working on. Every public op (tool
  // call / driver event) runs inside withLock and sets this first, so implicit
  // helpers (buildDoPrompt's cache write, logEvent, …) resolve exactly like the
  // Claude version's per-server boundInstanceId. Cross-op persistence lives in
  // sessionBindings instead (one plugin process serves many sessions).
  let boundInstanceId: string | null = null;
  // Per-session persistent binding: sessionID -> instance id.
  const sessionBindings = new Map<string, string>();
  // The session driving the current operation (replaces getMySessionId()).
  let currentSessionId: string | null = null;

  /** Enter an operation scope: which session is calling. Must hold withLock. */
  function beginOp(sessionId: string | null): void {
    currentSessionId = sessionId;
    boundInstanceId = sessionId ? sessionBindings.get(sessionId) || null : null;
    if (boundInstanceId) stepRecords = loadStepRecords(boundInstanceId);
  }

  /** The Claude version reads ~/.claude/sessions/<ppid>.json; here the host
   * hands us the sessionID directly. */
  function getMySessionId(): string | null {
    return currentSessionId;
  }

  function isSessionAlive(sessionId: string | null): boolean {
    return platform.isSessionAlive(sessionId);
  }

  /** Resolve the implicit instance id, failing loudly if nothing is bound. */
  function reqInst(instId?: string | null): string {
    const id = instId || boundInstanceId;
    if (!id) throw new Error("No workflow instance bound to this operation");
    return id;
  }

  function instPath(name: string, instId?: string | null): string {
    return path.join(getInstanceDir(reqInst(instId)), name);
  }

  function isValidInstanceId(id: unknown): id is string {
    return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
  }

  function generateInstanceId(workflowName: string): string {
    const base = String(workflowName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "wf";
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    return `${base}-${ts}-${rand}`;
  }

  function readOwnerSession(instId?: string | null): string | null {
    try {
      return stripBom(fs.readFileSync(instPath(OWNER_FILENAME, instId), "utf-8")).trim() || null;
    } catch {
      return null;
    }
  }

  function writeOwnerSession(instId: string, sessionId: string | null): void {
    if (!sessionId) return;
    try {
      // Never resurrect a completed/cancelled instance directory
      if (!fs.existsSync(instPath(STATE_FILENAME, instId))) return;
      atomicWriteText(instPath(OWNER_FILENAME, instId), sessionId);
    } catch (e: any) {
      console.error("[ralph-flow] Error writing owner-session:", e.message);
    }
  }

  /** Check whether a pid refers to a live process. EPERM means "exists but not ours". */
  function isPidAlive(pid: number): boolean {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (e: any) { return e && e.code === "EPERM"; }
  }

  /**
   * Cross-process advisory lock for one instance. The in-memory withLock only
   * serializes this engine's own ops; this lock guards against a second
   * opencode process mutating the same instance (e.g. cross-session cancel
   * racing a check-result commit). Lock file holds the owner pid; a dead pid is
   * stale.
   */
  async function withInstanceLock<T>(instId: string, fn: () => Promise<T> | T): Promise<T> {
    const instDir = getInstanceDir(instId);
    const lockPath = path.join(instDir, LOCK_FILENAME);
    const tmpPath = path.join(instDir, `${LOCK_FILENAME}.${process.pid}`);
    const deadline = Date.now() + 30000;

    // Write the pid to a temp file first, then atomically link it into place —
    // the lock file is never observable in a half-written (empty) state, so a
    // concurrent reader can't misclassify an in-flight acquisition as stale.
    const tryAcquire = () => {
      fs.writeFileSync(tmpPath, String(process.pid));
      try {
        try {
          fs.linkSync(tmpPath, lockPath);
          return true;
        } catch (e: any) {
          if (e.code === "EEXIST") return false;
          if (e.code === "EPERM" || e.code === "EACCES" || e.code === "ENOSYS" || e.code === "EXDEV") {
            // Filesystem without hard-link support — fall back to exclusive create
            const fd = fs.openSync(lockPath, "wx");
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            return true;
          }
          throw e;
        }
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    };

    for (;;) {
      try {
        if (tryAcquire()) break;
      } catch (e: any) {
        if (e.code === "ENOENT") {
          // Instance directory disappeared (cancelled/completed by another process)
          const err: any = new Error("instance-gone");
          err.code = "INSTANCE_GONE";
          throw err;
        }
        if (e.code !== "EEXIST") throw e; // EEXIST from the wx fallback: lock held
      }
      // Lock held by someone — stale only if its recorded pid is dead
      let staleContent: string | null = null;
      try {
        const content = stripBom(fs.readFileSync(lockPath, "utf-8")).trim();
        const pid = parseInt(content, 10);
        if (pid && !isPidAlive(pid)) staleContent = content;
      } catch (e: any) {
        if (e && e.code === "ENOENT") continue; // released between attempts — retry
      }
      if (staleContent !== null) {
        // Re-read right before unlinking so we never delete a lock that was
        // released and re-acquired by a live process in the meantime.
        try {
          const again = stripBom(fs.readFileSync(lockPath, "utf-8")).trim();
          if (again === staleContent) fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error("Instance lock timeout");
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      return await fn();
    } finally {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  // ─── State Management (per instance) ────────────────────────────────────────

  function getStateFile(instId?: string | null): string {
    return instPath(STATE_FILENAME, instId);
  }

  /**
   * A live instance is one whose state.json still exists. Writers below check
   * this before writing so no code path can resurrect a destroyed instance
   * directory (e.g. a cross-session cancel racing an in-flight check).
   */
  function instanceExists(instId?: string | null): boolean {
    try {
      return fs.existsSync(getStateFile(instId));
    } catch {
      return false;
    }
  }

  function isValidState(s: any): s is RalphFlowState {
    return s && typeof s === "object"
      && typeof s.active === "boolean"
      && typeof s.workflow_name === "string" && s.workflow_name.length > 0
      && typeof s.current_step === "string" && s.current_step.length > 0
      && typeof s.current_phase === "string"
      && typeof s.fail_count === "number" && s.fail_count >= 0
      && typeof s.paused === "boolean"
      && (s.pause_reason === undefined || s.pause_reason === null || typeof s.pause_reason === "string");
  }

  function readState(instId?: string | null): RalphFlowState | null {
    try {
      const stateFile = getStateFile(instId);
      if (fs.existsSync(stateFile)) {
        try {
          const parsed = JSON.parse(stripBom(fs.readFileSync(stateFile, "utf-8")));
          if (!isValidState(parsed)) {
            console.error("[ralph-flow] State file has invalid schema, backing up");
            try { fs.renameSync(stateFile, stateFile + ".invalid." + Date.now()); } catch {}
            return null;
          }
          return parsed;
        } catch (parseErr: any) {
          console.error("[ralph-flow] State file corrupted, backing up:", parseErr.message);
          try { fs.renameSync(stateFile, stateFile + ".corrupted." + Date.now()); } catch {}
          return null;
        }
      }
    } catch (e: any) {
      console.error("[ralph-flow] Error reading state:", e.message);
    }
    return null;
  }

  function writeState(state: RalphFlowState, instId?: string | null): void {
    try {
      const id = reqInst(instId);
      atomicWriteJson(getStateFile(id), { ...state, instance_id: id });
    } catch (e: any) {
      console.error("[ralph-flow] Error writing state:", e.message);
    }
  }

  function writeMarker(name: string, content: string, instId?: string | null): void {
    try {
      const id = reqInst(instId);
      if (!instanceExists(id)) return; // never resurrect a destroyed instance
      fs.writeFileSync(path.join(getInstanceDir(id), name), content);
    } catch {}
  }

  function clearMarker(name: string, instId?: string | null): void {
    try {
      const marker = instPath(name, instId);
      if (fs.existsSync(marker)) fs.unlinkSync(marker);
    } catch {}
  }

  function markerExists(name: string, instId?: string | null): boolean {
    try {
      return fs.existsSync(instPath(name, instId));
    } catch {
      return false;
    }
  }

  function writeManualStepMarker(instId?: string | null): void { writeMarker(MANUAL_STEP_MARKER, "active", instId); }
  function clearManualStepMarker(instId?: string | null): void { clearMarker(MANUAL_STEP_MARKER, instId); }
  function clearManualGate(instId?: string | null): void { clearMarker(MANUAL_GATE_MARKER, instId); }
  function clearReinjectCounter(instId?: string | null): void { clearMarker(".do-reinject-count", instId); }
  function clearDoPromptCache(instId?: string | null): void { clearMarker(".do-prompt-cache", instId); }
  function clearDoneTagDetected(instId?: string | null): void { clearMarker(DONE_TAG_MARKER, instId); }

  function writeDoPromptCache(prompt: string, instId?: string | null): void {
    try {
      const id = reqInst(instId);
      if (!instanceExists(id)) return;
      atomicWriteText(instPath(".do-prompt-cache", id), prompt);
    } catch {}
  }

  /**
   * Set the driver dedup markers after a tool response that already contains
   * the current DO prompt: .last-phase-report suppresses a duplicate full phase
   * report, .post-tool-active suppresses the immediate keep-alive for this turn.
   * Later idles still keep-alive normally.
   */
  function markPromptDelivered(stepId: string, instId?: string | null): void {
    try {
      const id = reqInst(instId);
      if (!instanceExists(id)) return;
      atomicWriteText(instPath(".last-phase-report", id), `do:${stepId}`);
      atomicWriteText(instPath(".post-tool-active", id), Date.now().toString());
    } catch {}
  }

  // ─── Adversarial-check session file (cross-session cancel support) ──────────

  function writeAdversarialSession(checkSessionId: string, instId?: string | null): void {
    try {
      const id = reqInst(instId);
      if (!instanceExists(id)) return;
      atomicWriteText(instPath(ADVERSARIAL_SESSION_FILENAME, id), String(checkSessionId));
    } catch {}
  }

  function clearAdversarialSession(instId?: string | null): void {
    clearMarker(ADVERSARIAL_SESSION_FILENAME, instId);
  }

  function readAdversarialSession(instId?: string | null): string | null {
    try {
      const v = stripBom(fs.readFileSync(instPath(ADVERSARIAL_SESSION_FILENAME, instId), "utf-8")).trim();
      return v || null;
    } catch {
      return null;
    }
  }

  // ─── Instance listing / resolution ──────────────────────────────────────────

  function listInstances(): InstanceInfo[] {
    const result: InstanceInfo[] = [];
    const root = getInstancesRoot();
    if (!fs.existsSync(root)) return result;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!isValidInstanceId(id)) continue;
      const state = readState(id);
      if (!state || !state.active) continue;
      let lastActivity: Date | null = null;
      try { lastActivity = fs.statSync(getStateFile(id)).mtime; } catch {}
      const owner = readOwnerSession(id);
      result.push({
        id,
        state,
        owner,
        ownerAlive: owner ? isSessionAlive(owner) : false,
        manualGate: markerExists(MANUAL_GATE_MARKER, id),
        doneTag: markerExists(DONE_TAG_MARKER, id),
        lastActivity,
      });
    }
    return result;
  }

  function instanceStatusLabel(info: InstanceInfo): string {
    const s = info.state;
    if (s.paused) {
      if (s.pause_reason === "max_failures") return "⏸ 已暂停（达到最大失败次数）";
      if (s.pause_reason === "config_error") return "⏸ 已暂停（工作流配置错误）";
      if (s.pause_reason === "check_error") return "⏸ 已暂停（验证未能运行，continue 重新验证）";
      return `⏸ 已暂停（${s.pause_reason || "未知原因"}）`;
    }
    if (s.current_phase === "check") return "🔍 验证中";
    if (info.manualGate) return "⏸ 等待手动审查";
    if (info.doneTag) return "✅ DO 完成，待验证";
    return "🔨 执行中";
  }

  function formatLastActivity(date: Date | null): string {
    if (!date) return "未知";
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  function formatInstanceList(instances: InstanceInfo[], actionHint?: string): string {
    const lines = [`## 工作流实例（${instances.length} 个）`, ""];
    for (const info of instances) {
      const task = (info.state.user_task || "").replace(/\s+/g, " ").slice(0, 60);
      lines.push(`### \`${info.id}\``);
      lines.push(`- **工作流**: ${info.state.workflow_name}`);
      if (task) lines.push(`- **任务**: ${task}${(info.state.user_task || "").length > 60 ? "…" : ""}`);
      lines.push(`- **步骤**: ${info.state.current_step}（${info.state.current_phase}）`);
      lines.push(`- **状态**: ${instanceStatusLabel(info)}`);
      lines.push(`- **属主会话**: ${info.owner ? (info.ownerAlive ? "🟢 活跃" : "⚪ 已关闭") : "无"}`);
      lines.push(`- **最后活动**: ${formatLastActivity(info.lastActivity)}`);
      lines.push("");
    }
    if (actionHint) lines.push(actionHint);
    return lines.join("\n");
  }

  type Resolution = { ok: true; id: string; attached: boolean } | { ok: false; text: string };

  /**
   * Resolve which instance a tool call targets.
   * `attached` is true when this call takes over an instance this session was
   * not already bound to (dead-owner takeover, explicit id, or my-session
   * rebind after a plugin restart). Callers use it to pick attach semantics.
   */
  function resolveInstance(explicitId?: string | null): Resolution {
    const instances = listInstances();

    // 1. Explicit id (unique prefix allowed) — the only way to take over an
    //    instance whose owning session is still alive.
    if (explicitId) {
      const wanted = String(explicitId).trim();
      const matches = instances.filter((i) => i.id === wanted);
      const prefixMatches = matches.length > 0 ? matches : instances.filter((i) => i.id.startsWith(wanted));
      if (prefixMatches.length === 1) {
        const id = prefixMatches[0].id;
        return { ok: true, id, attached: id !== boundInstanceId };
      }
      if (prefixMatches.length === 0) {
        return {
          ok: false,
          text: instances.length === 0
            ? `没有找到实例 "${wanted}"。当前没有活跃的工作流实例。`
            : `没有找到匹配 "${wanted}" 的实例。\n\n${formatInstanceList(instances)}`,
        };
      }
      return { ok: false, text: `前缀 "${wanted}" 匹配到 ${prefixMatches.length} 个实例，请提供更长的前缀：\n\n${formatInstanceList(prefixMatches)}` };
    }

    const mySession = getMySessionId();

    // 2. Already bound and still alive — unless the instance was explicitly
    //    taken over by another session that is still running (an alive foreign
    //    owner outranks our stale binding).
    if (boundInstanceId) {
      const bound = instances.find((i) => i.id === boundInstanceId);
      if (bound && !(bound.owner && mySession && bound.owner !== mySession && isSessionAlive(bound.owner))) {
        return { ok: true, id: boundInstanceId, attached: false };
      }
      boundInstanceId = null; // completed/cancelled/taken over — fall through
      if (mySession) sessionBindings.delete(mySession);
    }

    // 3. An instance owned by this very session (plugin restarted mid-workflow)
    if (mySession) {
      const mine = instances.filter((i) => i.owner === mySession);
      if (mine.length >= 1) {
        // More than one can only arise from degraded-identity modes; pick the
        // most recently active.
        mine.sort((a, b) => (b.lastActivity?.getTime() || 0) - (a.lastActivity?.getTime() || 0));
        return { ok: true, id: mine[0].id, attached: true };
      }
    }

    // 4. Unbound resolution
    if (instances.length === 0) {
      return { ok: false, text: "没有活跃的工作流。使用 ralphflow_start 启动一个。" };
    }
    if (instances.length === 1 && !instances[0].ownerAlive) {
      return { ok: true, id: instances[0].id, attached: true };
    }
    const hint = instances.length === 1
      ? `该实例的属主会话仍然活跃（可能正在另一个窗口执行）。如果确定要在当前会话接管，请显式指定实例：调用工具时传入 \`instance: "${instances[0].id}"\`（支持唯一前缀）。`
      : `存在多个实例，请显式指定要操作的实例：调用工具时传入 \`instance: "<实例ID>"\`（支持唯一前缀）。`;
    return { ok: false, text: formatInstanceList(instances, hint) };
  }

  /** Bind the current session to an instance: in-memory + owner-session + step records. */
  function bindInstance(instId: string): void {
    if (boundInstanceId !== instId) {
      boundInstanceId = instId;
      stepRecords = loadStepRecords(instId);
    }
    if (currentSessionId) sessionBindings.set(currentSessionId, instId);
    writeOwnerSession(instId, getMySessionId());
    // The instance has a driver again — allow future orphan notifications afresh
    clearMarker(".orphan-notified", instId);
  }

  // ─── Instance destruction (complete / cancel) ───────────────────────────────

  function archiveReport(instId: string, workflowName: string, status: string, records: StepExecutionRecord[]): string | null {
    try {
      const reportsDir = getReportsDir();
      if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
      const reportPath = path.join(reportsDir, `${instId}-final-report.md`);
      let artifactsNote = "";
      try {
        const artifactsDir = getArtifactsDir(instId);
        if (fs.readdirSync(artifactsDir).length > 0) {
          artifactsNote = `\n\n产出目录：\`${getArtifactsRelDir(instId)}/\`\n`;
        }
      } catch {}
      atomicWriteText(reportPath, buildReportText(workflowName, status, records || []) + artifactsNote);
      return reportPath;
    } catch (e: any) {
      console.error("[ralph-flow] Report generation failed:", e.message);
      return null;
    }
  }

  /**
   * Destroy an instance: abort any running adversarial check, archive the final
   * report, remove the instance directory. Returns the archived report path.
   */
  function destroyInstance(instId: string, status: string): string | null {
    let records: StepExecutionRecord[] = [];
    let workflowName = instId;
    const state = readState(instId);
    if (state) workflowName = state.workflow_name;
    if (instId === boundInstanceId) {
      records = stepRecords;
    } else {
      records = loadStepRecords(instId);
    }
    // Abort a check running in this process. A check running under ANOTHER
    // opencode process can't be reached from here (the Claude version kills by
    // pid file); its result is discarded by the state checks in phase 3.
    try { platform.abortActiveCheck?.(instId); } catch {}
    const reportPath = archiveReport(instId, workflowName, status, records);
    // Resolve before the instance dir goes away — the artifacts-dir name file
    // lives inside it.
    const artifactsDir = getArtifactsDir(instId);
    // Delete state.json first: even if the recursive removal partially fails
    // (Windows EBUSY on files still held open), the instance is de-listed and
    // can't act as a ghost.
    try { fs.unlinkSync(getStateFile(instId)); } catch {}
    try {
      fs.rmSync(getInstanceDir(instId), { recursive: true, force: true });
    } catch (e: any) {
      console.error("[ralph-flow] Error removing instance dir:", e.message);
    }
    // A workflow that produced nothing leaves no folder behind — rmdir refuses
    // non-empty dirs, so real deliverables always outlive the instance.
    try { fs.rmdirSync(artifactsDir); } catch {}
    if (instId === boundInstanceId) {
      boundInstanceId = null;
      stepRecords = [];
    }
    for (const [sess, id] of sessionBindings) {
      if (id === instId) sessionBindings.delete(sess);
    }
    return reportPath;
  }

  // ─── Workflow Loader ────────────────────────────────────────────────────────

  function getPluginWorkflowsDir(): string {
    const __filename = fileURLToPath(import.meta.url);
    return path.join(path.dirname(__filename), "..", "workflows");
  }

  function getProjectWorkflowsDir(): string {
    return path.join(getRalphFlowDir(), "workflows");
  }

  // Global user workflows, available across ALL projects and surviving plugin
  // updates (built-ins live inside the managed npm package, which is
  // overwritten on update and not user-editable when installed online). Lives
  // under opencode's own global config home so users find it next to their
  // other opencode config. Honors XDG_CONFIG_HOME.
  function getGlobalConfigHome(): string | null {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "opencode");
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (!home) return null;
    return path.join(home, ".config", "opencode");
  }

  function getGlobalWorkflowsDir(): string | null {
    const cfg = getGlobalConfigHome();
    return cfg ? path.join(cfg, RALPH_FLOW_DIR, "workflows") : null;
  }

  function parseWorkflowFile(filePath: string, workflowName: string, problems?: string[]): WorkflowDef | null {
    // Validation failures are collected into `problems` (when provided) so tool
    // responses can tell the user WHY a workflow is unusable.
    const problem = (msg: string) => { if (Array.isArray(problems)) problems.push(msg); };
    const skipStep = (msg: string) => { console.warn(`[ralph-flow] ${msg}`); problem(msg); };
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > MAX_WORKFLOW_FILE_SIZE) {
        console.error(`[ralph-flow] Workflow file ${filePath} exceeds ${MAX_WORKFLOW_FILE_SIZE} bytes, skipped`);
        problem(`工作流文件超过 ${MAX_WORKFLOW_FILE_SIZE} 字节上限`);
        return null;
      }
      const content = stripBom(fs.readFileSync(filePath, "utf-8"));
      const parsed: any = yaml.load(content);

      if (!parsed || typeof parsed !== "object") { problem("YAML 内容不是对象"); return null; }
      if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) { problem("缺少非空的 steps 数组"); return null; }

      const validSteps: StepDef[] = [];
      for (let i = 0; i < parsed.steps.length; i++) {
        const step = parsed.steps[i];
        if (!step || typeof step !== "object") { skipStep(`Step ${i} in ${workflowName}: not an object, skipped`); continue; }
        if (!step.id || typeof step.id !== "string") { skipStep(`Step ${i} in ${workflowName}: missing/invalid 'id', skipped`); continue; }
        if (!step.desc || typeof step.desc !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'desc', skipped`); continue; }
        if (!step.on_pass || typeof step.on_pass !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'on_pass', skipped`); continue; }
        if (!step.on_fail || typeof step.on_fail !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'on_fail', skipped`); continue; }
        if (typeof step.max_fail_count !== "number" || step.max_fail_count < 1) { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'max_fail_count', skipped`); continue; }

        // Validate input/output fields (they become the 输入说明/输出要求 sections of the DO/CHECK prompts)
        if (!step.input || typeof step.input !== "string") {
          skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'input' field, skipped`);
          continue;
        }
        if (!step.output || typeof step.output !== "string") {
          skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'output' field, skipped`);
          continue;
        }

        if (step.workflow) {
          if (typeof step.workflow !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: invalid 'workflow', skipped`); continue; }
          validSteps.push(step);
          continue;
        }

        if (!step.do || typeof step.do !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'do', skipped`); continue; }
        if (!step.check || typeof step.check !== "string") { skipStep(`Step "${step.id}" in ${workflowName}: missing/invalid 'check', skipped`); continue; }
        validSteps.push(step);
      }

      if (validSteps.length === 0) { problem("没有任何有效步骤"); return null; }

      // Validate on_pass/on_fail references
      const stepIds = new Set(validSteps.map((s) => s.id));
      for (const step of validSteps) {
        if (step.on_pass !== "done" && !stepIds.has(step.on_pass)) {
          console.error(`[ralph-flow] Step "${step.id}" on_pass references unknown step "${step.on_pass}"`);
          problem(`步骤 "${step.id}" 的 on_pass 引用了不存在的步骤 "${step.on_pass}"`);
          return null;
        }
        if (!stepIds.has(step.on_fail)) {
          console.error(`[ralph-flow] Step "${step.id}" on_fail references unknown step "${step.on_fail}"`);
          problem(`步骤 "${step.id}" 的 on_fail 引用了不存在的步骤 "${step.on_fail}"`);
          return null;
        }
      }

      const manual_step: string[] = Array.isArray(parsed.manual_step)
        ? parsed.manual_step.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim())
        : typeof parsed.manual_step === "string"
          ? parsed.manual_step.split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];
      // A typo'd manual_step entry would silently drop a human review gate the
      // user is counting on — the workflow would run fully automated past the
      // point that was supposed to stop for review. Hard error, not a warning.
      const unknownManual = manual_step.filter((id) => !stepIds.has(id));
      if (unknownManual.length > 0) {
        console.error(`[ralph-flow] manual_step in ${workflowName} references unknown step(s): ${unknownManual.join(", ")}`);
        problem(`manual_step 引用了不存在的步骤：${unknownManual.map((s) => `"${s}"`).join("、")}`);
        return null;
      }

      const adv = parsed.adversarial_check;
      let adversarial_check: AdversarialCheckConfig | undefined = undefined;
      if (adv && typeof adv === "object") {
        // Both formats are native here: string model (Claude Code style) is
        // passed through and resolved by the host; object {providerID, modelID}
        // is the opencode SDK's own shape.
        let model: AdversarialCheckConfig["model"] = undefined;
        if (typeof adv.model === "string" && adv.model.trim()) {
          model = adv.model.trim();
        } else if (adv.model && typeof adv.model === "object") {
          if (adv.model.modelID && typeof adv.model.modelID === "string") {
            model = { providerID: adv.model.providerID, modelID: adv.model.modelID.trim() };
          }
        }

        const system_prompt = typeof adv.system_prompt === "string" && adv.system_prompt.trim() ? adv.system_prompt.trim() : undefined;
        const agent = typeof adv.agent === "string" && adv.agent.trim() ? adv.agent.trim() : undefined;

        let timeout_ms: number | undefined = undefined;
        if (typeof adv.timeout_ms === "number" && adv.timeout_ms > 0) {
          timeout_ms = Math.min(adv.timeout_ms, 3600000); // Cap at 1 hour
        }
        adversarial_check = { model, agent, system_prompt, timeout_ms };
      }

      return {
        name: workflowName,
        description: parsed.description || validSteps[0].desc || workflowName,
        manual_step,
        steps: validSteps,
        adversarial_check,
      };
    } catch (e: any) {
      console.error(`[ralph-flow] Error parsing workflow ${filePath}:`, e.message);
      problem(`解析失败：${e.message}`);
      return null;
    }
  }

  function isValidWorkflowName(name: unknown): name is string {
    // Reject names with path separators, traversal sequences, or special chars
    return typeof name === "string" && name.length > 0 && name.length < 100
      && !/[\/\\]/.test(name) && !name.includes("..") && !name.startsWith(".");
  }

  function loadWorkflow(workflowName: string, problems?: string[]): WorkflowDef | null {
    if (!isValidWorkflowName(workflowName)) return null;
    const globalDir = getGlobalWorkflowsDir();
    // Resolution order: project > global user > plugin built-in. A same-named
    // workflow at an earlier tier shadows the later ones.
    const searchPaths = [
      path.join(getProjectWorkflowsDir(), `${workflowName}.yaml`),
      path.join(getProjectWorkflowsDir(), `${workflowName}.yml`),
      ...(globalDir ? [
        path.join(globalDir, `${workflowName}.yaml`),
        path.join(globalDir, `${workflowName}.yml`),
      ] : []),
      path.join(getPluginWorkflowsDir(), `${workflowName}.yaml`),
      path.join(getPluginWorkflowsDir(), `${workflowName}.yml`),
    ];
    for (const p of searchPaths) {
      if (fs.existsSync(p)) {
        const result = parseWorkflowFile(p, workflowName, problems);
        if (result) return result;
      }
    }
    return null;
  }

  function listWorkflows(): Array<{ name: string; desc: string; invalid?: boolean }> {
    const workflows = new Map<string, { name: string; desc: string; invalid?: boolean }>();
    const scanDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      try {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith(".yaml") || file.endsWith(".yml")) {
            try {
              const filePath = path.join(dir, file);
              const stats = fs.statSync(filePath);
              if (stats.size > MAX_WORKFLOW_FILE_SIZE) {
                console.error(`[ralph-flow] Workflow file ${filePath} exceeds ${MAX_WORKFLOW_FILE_SIZE} bytes, skipped`);
                continue;
              }
              const content = stripBom(fs.readFileSync(filePath, "utf-8"));
              const parsed: any = yaml.load(content);
              // Not workflow-shaped at all (stray yaml) — skip silently, as before.
              if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.steps) || parsed.steps.length === 0) continue;
              const name = file.replace(/\.(yaml|yml)$/, "");
              // Run the FULL validation so the list agrees with what
              // ralphflow_start will accept — a file that fails loadWorkflow must
              // not be listed as launchable, it gets flagged instead.
              const problems: string[] = [];
              const wf = parseWorkflowFile(filePath, name, problems);
              const existing = workflows.get(name);
              if (wf) {
                // First valid candidate in resolution order wins; a valid later
                // candidate replaces an invalid earlier one — loadWorkflow falls
                // through invalid files the same way.
                if (!existing || existing.invalid) {
                  workflows.set(name, { name, desc: wf.description });
                }
              } else if (!existing) {
                workflows.set(name, {
                  name,
                  desc: `⚠️ 定义无效，无法启动：${problems[0] || "解析失败"}`,
                  invalid: true,
                });
              }
            } catch (e: any) {
              console.error(`[ralph-flow] Error reading workflow ${file}:`, e.message);
            }
          }
        }
      } catch (e: any) {
        console.error(`[ralph-flow] Error scanning dir ${dir}:`, e.message);
      }
    };
    // Scan project → global → plugin — the first VALID writer wins, so a valid
    // project workflow shadows a same-named global one which shadows a built-in,
    // while an invalid one falls through. Matches loadWorkflow's resolution
    // order exactly, so list and execution agree.
    scanDir(getProjectWorkflowsDir());
    const globalDir = getGlobalWorkflowsDir();
    if (globalDir) scanDir(globalDir);
    scanDir(getPluginWorkflowsDir());
    return Array.from(workflows.values());
  }

  // ─── Workflow Doctor ────────────────────────────────────────────────────────
  //
  // Deep diagnosis behind the ralphflow_doctor tool. Reuses parseWorkflowFile so
  // its verdicts always agree with what ralphflow_start actually accepts, then
  // layers lints for problems the engine only surfaces at runtime (or never).

  /**
   * Lint a workflow that already passed full validation. Returns human-readable
   * warning strings — things that won't stop ralphflow_start but will bite later.
   * `rawParsed` is the untouched yaml.load result (parseWorkflowFile drops fields
   * the lints need to see).
   */
  function lintWorkflow(wf: WorkflowDef, rawParsed: any): string[] {
    const warnings: string[] = [];

    // Unreachable steps: execution enters at steps[0] and only moves along
    // on_pass/on_fail edges, so anything outside that closure never runs.
    const byId = new Map(wf.steps.map((s) => [s.id, s]));
    const reachable = new Set<string>();
    const queue = [wf.steps[0].id];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const s = byId.get(id);
      if (!s) continue;
      if (s.on_pass !== "done") queue.push(s.on_pass);
      queue.push(s.on_fail);
    }
    const unreachable = wf.steps.filter((s) => !reachable.has(s.id)).map((s) => s.id);
    if (unreachable.length > 0) {
      warnings.push(`步骤 ${unreachable.map((s) => `"${s}"`).join("、")} 从入口（steps 的第一项）沿 on_pass/on_fail 不可达，永远不会执行`);
    }

    // A workflow none of whose reachable steps can reach "done" never finishes.
    if (!wf.steps.some((s) => reachable.has(s.id) && s.on_pass === "done")) {
      warnings.push(`没有任何可达步骤的 on_pass 为 "done"，工作流永远无法正常完成`);
    }

    // Template tokens: the engine resolves exactly one token, {{artifacts_dir}}
    // (byte-exact — even extra spaces inside the braces break it). Anything else
    // reaches the DO/CHECK prompt unresolved.
    for (const s of wf.steps) {
      for (const field of ["desc", "do", "check", "input", "output"] as const) {
        const text = (s as any)[field];
        if (typeof text !== "string") continue;
        for (const m of text.matchAll(/\{\{[^{}]*\}\}/g)) {
          if (m[0] !== ARTIFACTS_TOKEN) {
            warnings.push(`步骤 "${s.id}" 的 ${field} 含模板变量 ${m[0]}，引擎不会解析（唯一支持的记号是 ${ARTIFACTS_TOKEN}，花括号内不能有空格；产出目录本就会自动注入到提示词，通常不需要任何记号）`);
          }
        }
      }
    }

    // Sub-workflow references resolve lazily at runtime — a broken one passes
    // validation and then fails the workflow mid-run.
    for (const s of wf.steps) {
      if (!isSubWorkflowStep(s)) continue;
      const subProblems: string[] = [];
      if (!loadWorkflow(s.workflow, subProblems)) {
        warnings.push(`步骤 "${s.id}" 引用的子工作流 "${s.workflow}" 无法加载（${subProblems[0] || "未找到定义文件"}）— 校验能通过，但运行到该步时工作流会失败`);
      }
    }
    const cycle = findSubWorkflowCycle(wf.name);
    if (cycle) {
      warnings.push(`子工作流引用成环：${cycle.join(" → ")}。运行时会在嵌套深度 ${MAX_NESTING_DEPTH} 处报错暂停`);
    }

    // adversarial_check fields the opencode engine clamps.
    const adv = rawParsed && typeof rawParsed === "object" ? rawParsed.adversarial_check : undefined;
    if (adv && typeof adv === "object") {
      if (typeof adv.timeout_ms === "number" && adv.timeout_ms > 3600000) {
        warnings.push(`adversarial_check.timeout_ms（${adv.timeout_ms}）超过 1 小时上限，会被截断为 3600000`);
      }
      if (typeof adv.model === "string" && adv.model.includes("/") === false && adv.model.trim()) {
        warnings.push(`adversarial_check.model 是字符串（"${adv.model}"）——opencode 需要能被解析的模型标识（如 "anthropic/claude-sonnet-4-5" 或对象 {providerID, modelID}），无法解析时将回退到 ralph-check agent 的默认模型`);
      }
    }

    return warnings;
  }

  /**
   * DFS through sub-workflow references looking for a cycle starting at `name`.
   * Returns the cycle path (["a", "b", "a"]) or null. `clean` memoizes names
   * proven cycle-free so shared sub-workflows aren't re-walked.
   */
  function findSubWorkflowCycle(name: string, stack: string[] = [], clean = new Set<string>()): string[] | null {
    if (clean.has(name)) return null;
    const idx = stack.indexOf(name);
    if (idx >= 0) return [...stack.slice(idx), name];
    const wf = loadWorkflow(name);
    if (wf) {
      for (const s of wf.steps) {
        if (!isSubWorkflowStep(s)) continue;
        const cycle = findSubWorkflowCycle(s.workflow, [...stack, name], clean);
        if (cycle) return cycle;
      }
    }
    clean.add(name);
    return null;
  }

  interface WorkflowCandidate {
    source: "project" | "global" | "plugin";
    sourceLabel: string;
    file: string;
    filePath: string;
    relPath: string;
    name: string;
    verdict?: "valid" | "invalid" | "stray";
    desc?: string;
    warnings?: string[];
    problems?: string[];
  }

  /**
   * Diagnose every workflow file in all search dirs. Returns per-name entries
   * in loadWorkflow's exact resolution order (project, global user, plugin
   * built-in) so "which file actually runs" is derivable, plus yaml files that
   * aren't workflow-shaped at all.
   */
  function diagnoseWorkflowFiles(): { byName: Map<string, WorkflowCandidate[]>; strays: WorkflowCandidate[] } {
    const globalDir = getGlobalWorkflowsDir();
    const sources = [
      { source: "project" as const, label: "项目自定义", dir: getProjectWorkflowsDir() },
      ...(globalDir ? [{ source: "global" as const, label: "全局用户", dir: globalDir }] : []),
      { source: "plugin" as const, label: "插件内置", dir: getPluginWorkflowsDir() },
    ];
    const byName = new Map<string, WorkflowCandidate[]>(); // name -> candidate[] in resolution order
    const strays: WorkflowCandidate[] = [];                // yaml files that aren't workflow definitions

    for (const { source, label, dir } of sources) {
      if (!fs.existsSync(dir)) continue;
      let files: string[];
      try { files = fs.readdirSync(dir); } catch { continue; }
      // .yaml before .yml within a dir, matching loadWorkflow's searchPaths.
      files = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .sort((a, b) => (a.endsWith(".yaml") ? 0 : 1) - (b.endsWith(".yaml") ? 0 : 1) || a.localeCompare(b));
      for (const file of files) {
        const filePath = path.join(dir, file);
        const name = file.replace(/\.(yaml|yml)$/, "");
        const relPath = source === "project"
          ? `.opencode/${RALPH_FLOW_DIR}/workflows/${file}`
          : source === "global"
            ? `~/.config/opencode/${RALPH_FLOW_DIR}/workflows/${file}`
            : `<插件目录>/workflows/${file}`;
        const candidate: WorkflowCandidate = { source, sourceLabel: label, file, filePath, relPath, name };

        try {
          if (fs.statSync(filePath).size > MAX_WORKFLOW_FILE_SIZE) {
            candidate.verdict = "invalid";
            candidate.problems = [`工作流文件超过 ${MAX_WORKFLOW_FILE_SIZE} 字节上限`];
            pushCandidate(byName, candidate);
            continue;
          }
          let rawParsed: any;
          try {
            rawParsed = yaml.load(stripBom(fs.readFileSync(filePath, "utf-8")));
          } catch (e: any) {
            candidate.verdict = "invalid";
            candidate.problems = [`YAML 解析失败：${e.message.split("\n")[0]}`];
            pushCandidate(byName, candidate);
            continue;
          }
          if (!rawParsed || typeof rawParsed !== "object" || !("steps" in rawParsed)) {
            // Not workflow-shaped: probably a stray yaml, but the user may have
            // MEANT it as a workflow — surface it instead of skipping silently.
            candidate.verdict = "stray";
            strays.push(candidate);
            continue;
          }
          const problems: string[] = [];
          const wf = parseWorkflowFile(filePath, name, problems);
          if (wf) {
            candidate.verdict = "valid";
            candidate.desc = wf.description;
            // Soft problems (skipped steps) that didn't invalidate the file are
            // exactly the silent-drop trap — merge them with the lints.
            candidate.warnings = [
              ...problems.map((p) => `${p}（该步骤已被静默丢弃，工作流其余部分照常运行）`),
              ...lintWorkflow(wf, rawParsed),
            ];
          } else {
            candidate.verdict = "invalid";
            candidate.problems = problems.length > 0 ? problems : ["解析失败"];
          }
          pushCandidate(byName, candidate);
        } catch (e: any) {
          candidate.verdict = "invalid";
          candidate.problems = [`读取失败：${e.message}`];
          pushCandidate(byName, candidate);
        }
      }
    }
    return { byName, strays };
  }

  function pushCandidate(byName: Map<string, WorkflowCandidate[]>, candidate: WorkflowCandidate): void {
    if (!byName.has(candidate.name)) byName.set(candidate.name, []);
    byName.get(candidate.name)!.push(candidate);
  }

  /** Instance-dir health: state.json missing or corrupt makes an instance invisible to every tool. */
  function diagnoseInstances(): string[] {
    const issues: string[] = [];
    const root = getInstancesRoot();
    if (!fs.existsSync(root)) return issues;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return issues; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateFile = path.join(root, entry.name, "state.json");
      if (!fs.existsSync(stateFile)) {
        issues.push(`实例目录 \`instances/${entry.name}/\` 缺少 state.json — 所有工具都看不到它。若是残留目录可直接删除`);
        continue;
      }
      try {
        const parsed = JSON.parse(stripBom(fs.readFileSync(stateFile, "utf-8")));
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      } catch (e: any) {
        issues.push(`实例 \`${entry.name}\` 的 state.json 损坏（${e.message.split("\n")[0]}）— 该实例无法恢复，确认无需保留后可删除整个目录`);
      }
    }
    return issues;
  }

  function buildDoctorReport(): string {
    const { byName, strays } = diagnoseWorkflowFiles();
    const instanceIssues = diagnoseInstances();

    const sections: string[] = [];
    let launchable = 0, withWarnings = 0, broken = 0;
    const detailLines: string[] = [];

    const names = Array.from(byName.keys()).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const candidates = byName.get(name)!;
      const effective = candidates.find((c) => c.verdict === "valid") || null;
      const lines = [`### ${name}`];

      if (effective) {
        launchable++;
        const shadowed = candidates.filter((c) => c !== effective);
        let sourceNote = `${effective.relPath}（${effective.sourceLabel}`;
        // A valid candidate LATER in resolution order is shadowed by this one.
        const shadowedValid = shadowed.find((c) => c.verdict === "valid" && candidates.indexOf(c) > candidates.indexOf(effective));
        if (shadowedValid) {
          sourceNote += `，遮蔽了同名${shadowedValid.sourceLabel} ${shadowedValid.relPath}`;
        }
        sourceNote += "）";
        lines.push(`- 生效文件：${sourceNote}`);
        // An invalid candidate EARLIER in resolution order means the user's file
        // is being silently skipped in favor of this one — worth shouting about.
        const brokenBefore = candidates.slice(0, candidates.indexOf(effective)).filter((c) => c.verdict === "invalid");
        for (const b of brokenBefore) {
          broken++;
          lines.push(`- ❌ ${b.relPath} 定义无效，已回退到上面的生效文件（启动的不是你这份！）`);
          for (const p of b.problems || []) lines.push(`  - ${p}`);
        }
        if ((effective.warnings || []).length > 0) {
          withWarnings++;
          lines.push(`- ✅ 可启动，但有 ${effective.warnings!.length} 条警告：`);
          for (const w of effective.warnings!) lines.push(`  - ⚠️ ${w}`);
        } else {
          lines.push(`- ✅ 可启动，无警告`);
        }
        // Invalid candidates AFTER the effective one are harmless (never reached)
        // — mention them only so the user knows the file exists and is dead.
        const deadAfter = candidates.slice(candidates.indexOf(effective) + 1).filter((c) => c.verdict === "invalid");
        for (const d of deadAfter) {
          lines.push(`- ℹ️ ${d.relPath} 定义无效，但已被上面的生效文件遮蔽，不影响使用（问题：${(d.problems || [])[0]}）`);
        }
      } else {
        broken += candidates.length;
        lines.push(`- ❌ 无法启动（没有任何有效定义）`);
        for (const c of candidates) {
          lines.push(`- 文件 ${c.relPath}：`);
          for (const p of c.problems || []) lines.push(`  - ${p}`);
        }
      }
      detailLines.push(lines.join("\n"));
    }

    sections.push(`# Ralph Flow 工作流诊断\n\n## 概览\n\n- 可启动工作流：**${launchable}** 个${withWarnings > 0 ? `（其中 ${withWarnings} 个有警告）` : ""}\n- 有问题的定义文件：**${broken}** 个\n- 非工作流 YAML：**${strays.length}** 个\n- 实例目录异常：**${instanceIssues.length}** 个`);

    if (detailLines.length > 0) {
      sections.push(`## 工作流详情\n\n${detailLines.join("\n\n")}`);
    } else {
      sections.push(`## 工作流详情\n\n三个目录（项目 .opencode/ralph-flow/workflows/、全局 ~/.config/opencode/ralph-flow/workflows/、插件内置 workflows/）里都没有找到工作流定义文件。可以用 /ralphflow-create 交互式创建一个。`);
    }

    if (strays.length > 0) {
      sections.push(`## 被忽略的 YAML 文件\n\n以下文件不是工作流定义（缺少 steps 数组），list/start 都会忽略它们。若本意是工作流，需要补上 steps：\n\n${strays.map((s) => `- ${s.relPath}`).join("\n")}`);
    }

    if (instanceIssues.length > 0) {
      sections.push(`## 实例目录异常\n\n${instanceIssues.map((i) => `- ⚠️ ${i}`).join("\n")}`);
    }

    const projectDirExists = fs.existsSync(getProjectWorkflowsDir());
    const hasProjectWorkflow = names.some((n) => byName.get(n)!.some((c) => c.source === "project"));
    const hasGlobalWorkflow = names.some((n) => byName.get(n)!.some((c) => c.source === "global"));
    if (!hasProjectWorkflow && !hasGlobalWorkflow) {
      sections.push(`## 提示\n\n还没有自定义工作流${projectDirExists ? "" : "（.opencode/ralph-flow/workflows/ 目录尚未创建）"}。内置工作流开箱即用；要定制自己的流程，可以运行 /ralphflow-create 交互式创建。放在 \`.opencode/ralph-flow/workflows/\` 只对本项目生效；放在全局 \`~/.config/opencode/ralph-flow/workflows/\` 则所有项目可用（且插件更新不会覆盖）。`);
    }

    return sections.join("\n\n");
  }

  // ─── Step Helpers ───────────────────────────────────────────────────────────

  function getStep(workflow: WorkflowDef, stepId: string): StepDef | null {
    return workflow.steps.find((s) => s.id === stepId) || null;
  }

  function buildDoPrompt(step: NormalStepDef, userTask?: string, retryContext?: string, retryCount?: number): string {
    const sections: string[] = [];
    const isRetry = retryContext || (retryCount && retryCount > 0);

    if (userTask) sections.push(`## 用户需求\n\n${userTask}`);
    if (retryContext) sections.push(`## 上次失败原因\n\n${retryContext}`);
    if (retryCount && retryCount > 0) {
      sections.push(`## 重试信息\n\n这是第 **${retryCount}** 次重试，最大重试次数为 **${step.max_fail_count}** 次。`);
    }
    if (sections.length > 0) sections.push("---");

    try { fs.mkdirSync(getArtifactsDir(), { recursive: true }); } catch {}

    sections.push(`## 当前任务

**步骤**：${step.id}
**描述**：${step.desc}

**任务**：${renderStepText(step.do)}

**输入说明**：${renderStepText(step.input)}

**输出要求**：${renderStepText(step.output)}

**产出目录**：\`${getArtifactsRelDir()}/\` — 本工作流的文档产出（清单、方案、报告等）统一放在此目录。步骤中提到的文档文件名（如 checkpoints.md）若未写路径，即指此目录下的文件；明确写了其他路径的除外。`);

    if (isRetry) {
      sections.push(`---

## 执行指令

上次执行未通过，原因见上方。请执行以下操作：

1. **针对上述失败原因进行修复**，不要重复之前未通过的做法
2. 完成实际工作（修改代码、创建文件、执行命令等）
3. 所有任务要求和输出要求都满足后，在回复的**最后一行**单独输出 \`<promise>done</promise>\`

不要只描述你打算怎么做，直接去做。不要在工作未完成时输出 done 标记。`);
    } else {
      sections.push(`---

## 执行指令

请执行上述任务。完成实际工作（修改代码、创建文件、执行命令等），不要只做分析或规划。

所有任务要求和输出要求都满足后，在回复的**最后一行**单独输出 \`<promise>done</promise>\`。

如果遇到无法解决的问题，说明具体问题，不要输出 done 标记。`);
    }
    const prompt = sections.join("\n\n");
    // Cache the do prompt: the driver re-injects it in keep-alives and phase reports
    writeDoPromptCache(prompt);
    return prompt;
  }

  function buildCheckPrompt(step: NormalStepDef, userTask?: string): string {
    const sections: string[] = [];
    if (userTask) sections.push(`## 用户需求\n\n${userTask}`);
    sections.push(`## Do 阶段任务

**步骤**：${step.id}
**任务描述**：${renderStepText(step.do)}
**输入**：${renderStepText(step.input)}
**预期输出**：${renderStepText(step.output)}
**产出目录**：\`${getArtifactsRelDir()}/\` — 检查依据中未写路径的文档文件名即指此目录下的文件`);
    if (sections.length > 0) sections.push("---");
    sections.push(`## 检查依据

${renderStepText(step.check)}

---

请基于上述信息，自主探索项目验证任务完成情况。基于你自己的探索结果判断，不要依赖任何外部提供的"实现总结"。

检查完成后输出：
- 通过：先说明通过原因，最后一行输出 \`<promise-check>true</promise-check>\`
- 不通过：先说明失败原因，最后一行输出 \`<promise-check>false</promise-check>\`

标签必须独占最后一行。`);
    return sections.join("\n\n");
  }

  function buildSubWorkflowUserTask(step: SubWorkflowStepDef, parentUserTask: string): string {
    const parts: string[] = [];
    if (step.inputs && typeof step.inputs === "object" && !Array.isArray(step.inputs)) {
      for (const [key, value] of Object.entries(step.inputs)) {
        parts.push(`${key}: ${renderStepText(String(value))}`);
      }
    }
    if (parentUserTask) {
      if (parts.length > 0) parts.push("");
      parts.push(`原始需求：${parentUserTask}`);
    }
    return parts.join("\n");
  }

  /**
   * Recursively resolve a sub-workflow entry point.
   * If the sub-workflow's first step is itself a sub-workflow, push intermediate states and recurse.
   * Returns { text, error? } where text is the do prompt for the deepest normal step.
   */
  function resolveSubWorkflowEntry(subWorkflowName: string, parentUserTask: string, parentStep: SubWorkflowStepDef, maxDepth?: number, retryContext?: string, retryCount?: number): { text: string; error?: boolean } {
    const depth = getStackDepth();
    if (depth >= (maxDepth || MAX_NESTING_DEPTH)) {
      return { text: `嵌套深度超过限制（${depth}/${maxDepth || MAX_NESTING_DEPTH}）。可能存在循环引用。`, error: true };
    }

    const subProblems: string[] = [];
    const subWorkflow = loadWorkflow(subWorkflowName, subProblems);
    if (!subWorkflow) {
      return {
        text: subProblems.length > 0
          ? `子工作流 "${subWorkflowName}" 定义无效：\n${subProblems.map((p) => `- ${p}`).join("\n")}`
          : `子工作流 "${subWorkflowName}" 未找到。`,
        error: true,
      };
    }

    const firstStep = subWorkflow.steps[0];
    if (!firstStep) {
      return { text: `子工作流 "${subWorkflowName}" 没有步骤。`, error: true };
    }

    const subUserTask = buildSubWorkflowUserTask(parentStep, parentUserTask);

    if (isSubWorkflowStep(firstStep)) {
      // Push intermediate state and recurse
      const intermediateState: RalphFlowState = {
        active: true, workflow_name: subWorkflowName, current_step: firstStep.id,
        current_phase: "do", fail_count: 0, user_task: subUserTask, paused: false,
      };
      pushState(intermediateState);
      const result = resolveSubWorkflowEntry(firstStep.workflow, subUserTask, firstStep, maxDepth, retryContext, retryCount);
      if (result.error) {
        popState(); // undo the push on error
      }
      return result;
    }

    // Normal first step — write state and return do prompt
    writeState({
      active: true, workflow_name: subWorkflowName, current_step: firstStep.id,
      current_phase: "do", fail_count: 0, user_task: subUserTask, paused: false,
    });
    // If the sub-workflow's first step is manual, arm the marker for the driver
    if (subWorkflow.manual_step && subWorkflow.manual_step.includes(firstStep.id)) {
      writeManualStepMarker();
    } else {
      clearManualStepMarker();
    }
    recordStepStart(firstStep.id, "do");
    logEvent("info", "step_start", { step: firstStep.id, phase: "do" });
    return { text: buildDoPrompt(firstStep, subUserTask, retryContext, retryCount) };
  }

  // ─── State Stack (for sub-workflows, per instance) ──────────────────────────

  function getStackFile(instId?: string | null): string {
    return instPath(STACK_FILENAME, instId);
  }

  function pushState(state: RalphFlowState, instId?: string | null): void {
    try {
      const stackFile = getStackFile(instId);
      let stack: RalphFlowState[] = [];
      if (fs.existsSync(stackFile)) {
        try {
          const parsed = JSON.parse(stripBom(fs.readFileSync(stackFile, "utf-8")));
          if (Array.isArray(parsed)) stack = parsed;
          else console.error("[ralph-flow] Stack file is not an array, starting fresh");
        } catch (parseErr: any) {
          console.error("[ralph-flow] Stack file corrupted, backing up and starting fresh:", parseErr.message);
          try { fs.renameSync(stackFile, stackFile + ".corrupted." + Date.now()); } catch {}
        }
      }
      stack.push(state);
      atomicWriteJson(stackFile, stack);
    } catch (e: any) {
      console.error("[ralph-flow] Error pushing state:", e.message);
    }
  }

  function popState(instId?: string | null): RalphFlowState | null {
    try {
      const stackFile = getStackFile(instId);
      if (!fs.existsSync(stackFile)) return null;
      let stack: RalphFlowState[];
      try {
        stack = JSON.parse(stripBom(fs.readFileSync(stackFile, "utf-8")));
      } catch (parseErr: any) {
        console.error("[ralph-flow] Stack file corrupted, backing up and clearing:", parseErr.message);
        try { fs.renameSync(stackFile, stackFile + ".corrupted." + Date.now()); } catch {}
        return null;
      }
      if (!Array.isArray(stack) || stack.length === 0) return null;
      const parentState = stack.pop()!;
      atomicWriteJson(stackFile, stack);
      return parentState;
    } catch (e: any) {
      console.error("[ralph-flow] Error popping state:", e.message);
      return null;
    }
  }

  function getStackDepth(instId?: string | null): number {
    try {
      const stackFile = getStackFile(instId);
      if (!fs.existsSync(stackFile)) return 0;
      const stack = JSON.parse(stripBom(fs.readFileSync(stackFile, "utf-8")));
      return Array.isArray(stack) ? stack.length : 0;
    } catch { return 0; }
  }

  // ─── Log Helpers ────────────────────────────────────────────────────────────

  function getLogDir(instId?: string | null): string {
    const id = instId || boundInstanceId;
    // Fall back to the global logs dir for events fired before any instance is
    // bound, or after the instance dir was destroyed (e.g. a cross-session cancel
    // while our adversarial check was running) — never resurrect a deleted dir.
    if (!id || !fs.existsSync(getInstanceDir(id))) return path.join(getRalphFlowDir(), "logs");
    return path.join(getInstanceDir(id), "logs");
  }

  function ensureLogDir(instId?: string | null): void {
    const logDir = getLogDir(instId);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  }

  const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
  const MAX_LOG_ROTATIONS = 3;

  function rotateLogIfNeeded(instId?: string | null): void {
    try {
      const logFile = path.join(getLogDir(instId), "execution.log");
      if (!fs.existsSync(logFile)) return;
      const stats = fs.statSync(logFile);
      if (stats.size < MAX_LOG_SIZE_BYTES) return;
      // Rotate: .3 → delete, .2 → .3, .1 → .2, current → .1
      for (let i = MAX_LOG_ROTATIONS; i >= 1; i--) {
        const older = `${logFile}.${i}`;
        if (i === MAX_LOG_ROTATIONS) { if (fs.existsSync(older)) fs.unlinkSync(older); }
        else { if (fs.existsSync(older)) fs.renameSync(older, `${logFile}.${i + 1}`); }
      }
      fs.renameSync(logFile, `${logFile}.1`);
    } catch (e: any) {
      console.error("[ralph-flow] Log rotation failed:", e.message);
    }
  }

  function logEvent(level: string, event: string, extra?: Record<string, unknown>): void {
    try {
      ensureLogDir();
      rotateLogIfNeeded();
      const entry = { ts: new Date().toISOString(), level, event, ...extra };
      fs.appendFileSync(path.join(getLogDir(), "execution.log"), JSON.stringify(entry) + "\n");
    } catch (e: any) {
      console.error(`[ralph-flow] Log failed (${event}):`, e.message);
    }
  }

  // ─── Step Records Persistence (per instance) ────────────────────────────────

  const STEP_RECORDS_FILENAME = "step-records.json";

  function getStepRecordsFile(instId?: string | null): string {
    return path.join(getLogDir(instId), STEP_RECORDS_FILENAME);
  }

  function loadStepRecords(instId?: string | null): StepExecutionRecord[] {
    try {
      const file = getStepRecordsFile(instId);
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(stripBom(fs.readFileSync(file, "utf-8")));
          if (Array.isArray(parsed)) return parsed;
          console.error("[ralph-flow] Step records file is not an array, resetting");
        } catch (parseErr: any) {
          console.error("[ralph-flow] Step records file corrupted, backing up:", parseErr.message);
          try { fs.renameSync(file, file + ".corrupted." + Date.now()); } catch {}
        }
      }
    } catch (e: any) {
      console.error("[ralph-flow] Error loading step records:", e.message);
    }
    return [];
  }

  function saveStepRecords(): void {
    try {
      ensureLogDir();
      atomicWriteJson(getStepRecordsFile(), stepRecords);
    } catch (e: any) {
      console.error("[ralph-flow] Error saving step records:", e.message);
    }
  }

  // ─── Report Generation ──────────────────────────────────────────────────────

  function formatDuration(startTime: string, endTime: string): string {
    const durationMs = Math.max(0, new Date(endTime).getTime() - new Date(startTime).getTime());
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
  }

  function buildReportText(workflowName: string, status: string, stepRecords: StepExecutionRecord[]): string {
    const totalFailures = stepRecords.reduce((sum, s) => sum + (s.failCount || 0), 0);
    const startTime = stepRecords.length > 0 ? stepRecords[0].startTime : new Date().toISOString();
    const endTime = stepRecords.length > 0 ? stepRecords[stepRecords.length - 1].endTime || new Date().toISOString() : new Date().toISOString();

    const statusCn: Record<string, string> = { completed: "已完成", cancelled: "已取消", paused: "已暂停" };

    const lines = [
      "# 工作流执行报告", "",
      "## 执行摘要", "",
      `- **工作流**: ${workflowName}`,
      `- **状态**: ${statusCn[status] || status}`,
      `- **总步骤数**: ${stepRecords.length}`,
      `- **失败次数**: ${totalFailures}`,
      `- **总耗时**: ${formatDuration(startTime, endTime)}`,
      "", "## 步骤执行情况", "",
    ];

    for (let i = 0; i < stepRecords.length; i++) {
      const step = stepRecords[i];
      const icon = step.status === "passed" ? "✓" : "✗";
      lines.push(`### ${i + 1}. ${step.stepId} (${step.phase}) ${icon}`);
      lines.push(`- 状态：${step.status === "passed" ? "通过" : "失败"}`);
      if (step.failCount > 0) lines.push(`- 失败次数：${step.failCount}`);
      if (step.reason) lines.push(`- ${step.status === "passed" ? "通过原因" : "失败原因"}：${step.reason}`);
      if (step.startTime && step.endTime) lines.push(`- 耗时：${formatDuration(step.startTime, step.endTime)}`);
      lines.push("");
    }

    return lines.join("\n");
  }

  // ─── Check Result Parsing ───────────────────────────────────────────────────

  /** Match the check verdict tag on the LAST line only. */
  function matchCheckTag(responseText: string): RegExpMatchArray | null {
    const lines = responseText.trim().split("\n");
    const lastLine = lines[lines.length - 1].trim();
    return lastLine.match(/<promise-check>\s*(true|false)\s*<\/promise-check>/i);
  }

  function parseCheckResult(responseText: string): boolean {
    const match = matchCheckTag(responseText);
    if (!match) return false;
    return match[1].toLowerCase() === "true";
  }

  function getAdversarialCheckReason(responseText: string): string {
    const lines = responseText.trim().split("\n");
    const reason = lines.slice(0, -1).join("\n").trim();
    return reason.length > 5000 ? reason.substring(0, 5000) + "..." : reason;
  }

  // ─── Workflow Advancement Logic (shared by done handler) ────────────────────

  function handleCheckPassed(state: RalphFlowState, workflow: WorkflowDef, step: StepDef, checkResult: { reason?: string }): TransitionResult {
    // Note: manual steps no longer pause after the check — the manual review gate
    // now sits BEFORE the check (the driver stops the session when the DO phase of
    // a manual step completes; the user's ralphflow_continue call is the approval
    // that starts the check). Once the check passes, the workflow advances.

    if (step.on_pass === "done") {
      const parentState = popState();
      if (parentState) {
        const parentWorkflow = loadWorkflow(parentState.workflow_name);
        if (parentWorkflow) {
          const parentStep = getStep(parentWorkflow, parentState.current_step);
          if (parentStep) {
            // Sub-workflow completed — advance to parent step's on_pass target
            const grandparentResult = handleCheckPassed(
              { ...parentState, current_phase: "do", fail_count: 0, last_failure_reason: undefined, paused: false, pause_reason: undefined },
              parentWorkflow, parentStep, { reason: `子工作流 "${state.workflow_name}" 已完成。` }
            );
            // Only record parent step's check as passed if transition succeeded and
            // the instance still exists (a completed workflow already destroyed it)
            if (!grandparentResult.paused && !grandparentResult.completed) {
              addStepRecord(parentState.current_step, "check", "passed", parentState.fail_count || 0, `子工作流 "${state.workflow_name}" 已完成。`);
            }
            logEvent("info", "sub_workflow_end", { workflow: state.workflow_name, parent_workflow: parentState.workflow_name, parent_step: parentState.current_step });
            return {
              text: `## 检查结果：通过 ✓\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n## 子工作流 "${state.workflow_name}" 已完成！\n\n---\n\n${grandparentResult.text}`,
              paused: grandparentResult.paused,
              completed: grandparentResult.completed,
            };
          }
        }
        // Parent workflow not found — push parent state back and pause so user can fix and resume
        pushState({ ...parentState, paused: true, pause_reason: "config_error", last_failure_reason: `父工作流 "${parentState.workflow_name}" 加载失败。` });
        writeState({ ...parentState, paused: true, pause_reason: "config_error", last_failure_reason: `父工作流 "${parentState.workflow_name}" 加载失败。` });
        logEvent("warn", "parent_workflow_not_found", { workflow: state.workflow_name, parent_workflow: parentState.workflow_name });
        return {
          text: `## 检查结果：通过 ✓\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n子工作流 "${state.workflow_name}" 已完成，但父工作流 "${parentState.workflow_name}" 加载失败。工作流已暂停 — 请修复工作流 YAML 后调用 \`ralphflow_continue\` 恢复。`,
          paused: true,
        };
      }
      // No parent — this is the top-level workflow, complete it.
      // Archive the report and destroy the instance directory.
      const instId = boundInstanceId!;
      const reportPath = destroyInstance(instId, "completed");
      logEvent("info", "workflow_end", { workflow: state.workflow_name });
      return {
        text: `## 检查结果：通过 ✓\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n## 工作流完成！\n\n所有步骤已验证通过。${reportPath ? `执行报告：${path.relative(projectDir, reportPath)}` : ""}`,
        completed: true,
      };
    }

    const nextStep = getStep(workflow, step.on_pass);
    if (!nextStep) {
      logEvent("error", "next_step_not_found", { step: state.current_step, on_pass: step.on_pass });
      writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: `下一步 "${step.on_pass}" 在工作流定义中未找到。` });
      return { text: `## 检查结果：通过 ✓\n\n下一步 "${step.on_pass}" 在工作流定义中未找到。\n\n## 工作流已暂停\n\n工作流配置错误。请修复工作流定义，然后调用 \`ralphflow_continue\` 恢复。`, paused: true };
    }

    if (isSubWorkflowStep(nextStep)) {
      recordStepStart(nextStep.id, "do");
      logEvent("info", "step_start", { step: nextStep.id, phase: "do" });
      // Write parent's next step state before entering sub-workflow.
      // This ensures the state file reflects the correct parent step after sub-workflow completes
      const nextState = { ...state, current_step: nextStep.id, current_phase: "do", fail_count: 0, last_failure_reason: undefined, paused: false, pause_reason: undefined };
      writeState(nextState);
      pushState({ ...state, current_step: nextStep.id, current_phase: "do", fail_count: 0, paused: false, pause_reason: undefined });
      const subResult = resolveSubWorkflowEntry(nextStep.workflow, state.user_task, nextStep);
      if (subResult.error) {
        popState();
        writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text });
        return { text: subResult.text, paused: true };
      }
      return {
        text: `## 检查结果：通过 ✓\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n## 进入子工作流：${nextStep.id}\n\n---\n\n${subResult.text}`,
      };
    }

    const nextState = { ...state, current_step: nextStep.id, current_phase: "do", fail_count: 0, last_failure_reason: undefined, paused: false, pause_reason: undefined };
    writeState(nextState);
    recordStepStart(nextStep.id, "do");
    logEvent("info", "step_start", { step: nextStep.id, phase: "do" });
    return {
      text: `## 检查结果：通过 ✓\n\n${checkResult.reason || "检查通过。"}\n\n---\n\n下一步：**${nextStep.id}** - ${nextStep.desc}\n\n---\n\n${buildDoPrompt(nextStep, state.user_task)}`,
    };
  }

  function handleCheckFailed(state: RalphFlowState, workflow: WorkflowDef, step: StepDef, checkResult: { reason?: string }): TransitionResult {
    const newFailCount = state.fail_count + 1;
    logEvent("warn", "fail_count_increment", { step: state.current_step, fail_count: newFailCount });

    if (newFailCount >= step.max_fail_count) {
      const parentState = popState();
      if (parentState) {
        const parentFailCount = parentState.fail_count + 1;
        // Check if parent step's max_fail_count is exceeded
        const parentWorkflow = loadWorkflow(parentState.workflow_name);
        const parentStep = parentWorkflow ? getStep(parentWorkflow, parentState.current_step) : null;
        if (parentStep && parentFailCount >= parentStep.max_fail_count) {
          // Parent step also exceeded max failures — pause parent workflow
          // Push parent state back to stack so resume/cancel can restore nesting
          pushState({ ...parentState, current_phase: "do", fail_count: parentFailCount, paused: true, pause_reason: "max_failures", last_failure_reason: checkResult.reason });
          writeState({ ...parentState, current_phase: "do", fail_count: parentFailCount, paused: true, pause_reason: "max_failures", last_failure_reason: checkResult.reason });
          logEvent("warn", "workflow_paused", { workflow: parentState.workflow_name, step: parentState.current_step, fail_count: parentFailCount });
          return {
            text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n## 工作流已暂停\n\n子工作流失败且父步骤最大失败次数 (${parentFailCount}/${parentStep.max_fail_count}) 已达。请修复问题，然后调用 \`ralphflow_continue\` 恢复。`,
            paused: true,
          };
        }
        // Parent step not at max — follow parent's on_fail
        if (!parentWorkflow || !parentStep) {
          // Push parent state back so resume can restore the stack
          pushState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `父工作流 "${parentState.workflow_name}" 或步骤 "${parentState.current_step}" 未找到。` });
          writeState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `父工作流 "${parentState.workflow_name}" 或步骤 "${parentState.current_step}" 未找到。` });
          logEvent("error", "parent_workflow_or_step_not_found", { workflow: parentState.workflow_name, step: parentState.current_step });
          return {
            text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n父工作流或步骤未找到。工作流已暂停。`,
            paused: true,
          };
        }
        const failStep = getStep(parentWorkflow, parentStep.on_fail);
        if (failStep) {
          if (isSubWorkflowStep(failStep)) {
            recordStepStart(failStep.id, "do");
            logEvent("info", "step_start", { step: failStep.id, phase: "do" });
            pushState({ ...parentState, current_step: failStep.id, current_phase: "do", fail_count: parentFailCount, last_failure_reason: checkResult.reason });
            const subResult = resolveSubWorkflowEntry(failStep.workflow, parentState.user_task, failStep, MAX_NESTING_DEPTH, checkResult.reason, parentFailCount);
            if (subResult.error) {
              popState();
              writeState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text });
              return { text: subResult.text, paused: true };
            }
            return {
              text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n子工作流失败。使用父步骤重试：**${failStep.id}**\n\n---\n\n${subResult.text}`,
            };
          }
          const retryState = { ...parentState, current_step: failStep.id, current_phase: "do", fail_count: parentFailCount, last_failure_reason: checkResult.reason };
          writeState(retryState);
          recordStepStart(failStep.id, "do");
          logEvent("info", "step_start", { step: failStep.id, phase: "do" });
          return {
            text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n子工作流失败。使用父步骤重试：**${failStep.id}** - ${failStep.desc}\n\n---\n\n${buildDoPrompt(failStep, parentState.user_task, checkResult.reason, parentFailCount)}`,
          };
        }
        // on_fail step not found — pause, but push parent state back so resume can restore stack
        pushState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `父步骤 on_fail "${parentStep.on_fail}" 未找到。` });
        writeState({ ...parentState, fail_count: parentFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `父步骤 on_fail "${parentStep.on_fail}" 未找到。` });
        return {
          text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n父步骤 on_fail "${parentStep.on_fail}" 未找到。工作流已暂停。`,
          paused: true,
        };
      }
      clearManualStepMarker();
      const pausedState = { ...state, fail_count: newFailCount, paused: true, pause_reason: "max_failures", last_failure_reason: checkResult.reason };
      writeState(pausedState);
      logEvent("warn", "workflow_paused", { workflow: state.workflow_name, step: state.current_step, fail_count: newFailCount });
      return {
        text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n## 工作流已暂停\n\n已达最大失败次数。请修复问题，然后调用 \`ralphflow_continue\` 恢复。`,
        paused: true,
      };
    }

    const failStep = getStep(workflow, step.on_fail);
    if (!failStep) {
      const pausedState = { ...state, fail_count: newFailCount, paused: true, pause_reason: "config_error", last_failure_reason: `失败步骤 "${step.on_fail}" 在工作流定义中未找到。` };
      writeState(pausedState);
      logEvent("error", "fail_step_not_found", { step: state.current_step, on_fail: step.on_fail });
      return {
        text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n失败步骤 "${step.on_fail}" 在工作流定义中未找到。\n\n---\n\n## 工作流已暂停\n\n工作流配置错误。请修复工作流定义，然后调用 \`ralphflow_continue\` 恢复。`,
        paused: true,
      };
    }

    if (isSubWorkflowStep(failStep)) {
      recordStepStart(failStep.id, "do");
      logEvent("info", "step_start", { step: failStep.id, phase: "do" });
      // Always use newFailCount (never reset on routing to different step)
      pushState({ ...state, current_step: failStep.id, current_phase: "do", fail_count: newFailCount, last_failure_reason: checkResult.reason });
      const subResult = resolveSubWorkflowEntry(failStep.workflow, state.user_task, failStep, MAX_NESTING_DEPTH, checkResult.reason, newFailCount);
      if (subResult.error) {
        popState();
        writeState({ ...state, fail_count: newFailCount, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text });
        return { text: subResult.text, paused: true };
      }
      return {
        text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n使用子工作流重试：**${failStep.id}**\n\n---\n\n${subResult.text}`,
      };
    }

    // Always use newFailCount (never reset on routing to different step)
    const retryState = { ...state, current_step: failStep.id, current_phase: "do", fail_count: newFailCount, last_failure_reason: checkResult.reason };
    writeState(retryState);
    recordStepStart(failStep.id, "do");
    logEvent("info", "step_start", { step: failStep.id, phase: "do" });
    return {
      text: `## 检查结果：失败 ✗ (${newFailCount}/${step.max_fail_count})\n\n${checkResult.reason || "检查失败。"}\n\n---\n\n重试：**${failStep.id}** - ${failStep.desc}\n\n---\n\n${buildDoPrompt(failStep, state.user_task, checkResult.reason, newFailCount)}`,
    };
  }

  // ─── Step Records (per bound instance) ──────────────────────────────────────

  let stepRecords: StepExecutionRecord[] = [];
  const stepStartTimes = new Map<string, string>(); // key: "stepId:phase" → ISO timestamp

  function recordStepStart(stepId: string, phase: string): void {
    stepStartTimes.set(`${stepId}:${phase}`, new Date().toISOString());
  }

  function addStepRecord(stepId: string, phase: string, status: "passed" | "failed", failCount: number, reason?: string): void {
    const now = new Date().toISOString();
    const key = `${stepId}:${phase}`;
    const startTime = stepStartTimes.get(key) || now;
    stepStartTimes.delete(key);
    stepRecords.push({ stepId, phase, status, failCount: failCount || 0, startTime, endTime: now, reason });
    if (stepRecords.length > MAX_STEP_RECORDS) {
      stepRecords = stepRecords.slice(-MAX_STEP_RECORDS);
    }
    saveStepRecords();
  }

  function getBoundInstance(): string | null {
    return boundInstanceId;
  }

  function setBoundInstance(instId: string | null): void {
    boundInstanceId = instId;
    if (instId) stepRecords = loadStepRecords(instId);
  }

  function getCurrentStepRecords(): StepExecutionRecord[] {
    return stepRecords;
  }

  // ─── Legacy single-workflow layout migration ────────────────────────────────

  const LEGACY_STATE_FILENAME = "ralph-flow.local.md";

  /** Parse the pre-2.0 markdown-frontmatter state file. */
  function parseLegacyState(content: string): (RalphFlowState & { session_id?: string }) | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const state: any = {
      active: false, workflow_name: "", current_step: "", current_phase: "do",
      fail_count: 0, user_task: "", paused: false,
    };
    let inFailureReason = false;
    let failureReasonLines: string[] = [];
    for (const line of match[1].split(/\r?\n/)) {
      if (inFailureReason) {
        if (line.startsWith("  ")) { failureReasonLines.push(line.substring(2)); continue; }
        state.last_failure_reason = failureReasonLines.join("\n").trim() || undefined;
        inFailureReason = false;
      }
      const [key, ...valueParts] = line.split(":");
      const value = valueParts.join(":").trim();
      switch (key.trim()) {
        case "active": state.active = value === "true"; break;
        case "workflow_name": state.workflow_name = value; break;
        case "current_step": state.current_step = value; break;
        case "current_phase": state.current_phase = value === "check" ? "check" : "do"; break;
        case "fail_count": state.fail_count = parseInt(value) || 0; break;
        case "user_task": state.user_task = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r"); break;
        case "paused": state.paused = value === "true"; break;
        case "session_id": if (value) state.session_id = value; break;
        case "last_failure_reason":
          if (value === "") { inFailureReason = true; failureReasonLines = []; }
          else state.last_failure_reason = value;
          break;
      }
    }
    if (inFailureReason && failureReasonLines.length > 0) {
      state.last_failure_reason = failureReasonLines.join("\n").trim() || undefined;
    }
    return state;
  }

  /**
   * Pre-2.0 plugin versions kept ONE workflow per project directly under
   * .opencode/ralph-flow/ (ralph-flow.local.md + state-stack.json). The current
   * code only scans instances/<id>/, so an interrupted legacy workflow would
   * silently become invisible after an upgrade. Move it into the instances
   * layout at startup. The state-file rename is the atomic claim, so concurrent
   * processes in the same project migrate it exactly once.
   */
  function migrateLegacyInstance(): void {
    try {
      const dir = getRalphFlowDir();
      const legacyState = path.join(dir, LEGACY_STATE_FILENAME);
      if (!fs.existsSync(legacyState)) return;

      let state: (RalphFlowState & { session_id?: string }) | null = null;
      try { state = parseLegacyState(stripBom(fs.readFileSync(legacyState, "utf-8"))); } catch {}
      if (!state || state.active !== true || !state.workflow_name || !state.current_step) {
        // Not a resumable workflow — park it so it is never re-parsed again
        try { fs.renameSync(legacyState, legacyState + ".pre-migration-backup"); } catch {}
        return;
      }

      const instId = generateInstanceId(state.workflow_name);
      const instDir = getInstanceDir(instId);
      fs.mkdirSync(instDir, { recursive: true });

      // Atomic claim: exactly one concurrent process wins this rename
      try {
        fs.renameSync(legacyState, path.join(instDir, LEGACY_STATE_FILENAME + ".migrated"));
      } catch {
        try { fs.rmSync(instDir, { recursive: true, force: true }); } catch {}
        return; // another process already migrated it
      }

      // Write the new-format state (legacy session_id becomes owner-session:
      // its session may still exist, but the plugin restart makes it "dead" —
      // exactly the auto-takeover journey).
      const { session_id, ...cleanState } = state;
      atomicWriteJson(path.join(instDir, STATE_FILENAME), { ...cleanState, instance_id: instId });
      if (session_id) {
        try { atomicWriteText(path.join(instDir, OWNER_FILENAME), session_id); } catch {}
      }
      // Move the sub-workflow stack along (missing is fine).
      try { fs.renameSync(path.join(dir, STACK_FILENAME), path.join(instDir, STACK_FILENAME)); } catch {}

      logEvent("info", "legacy_instance_migrated", { instance: instId, workflow: state.workflow_name, step: state.current_step, phase: state.current_phase });
      console.error(`[ralph-flow] Migrated legacy workflow state to instance ${instId}`);
    } catch (e: any) {
      console.error("[ralph-flow] Legacy migration failed:", e.message);
    }
  }

  function ensureProjectWorkflows(): void {
    // Ensure the project AND global user workflow dirs exist as places for the
    // user to drop *custom* workflows. Built-in workflows are intentionally NOT
    // copied into either: loadWorkflow falls back to the plugin dir, so
    // built-ins always resolve to the latest shipped version. Seeding copies
    // would shadow the plugin dir and go stale on plugin updates. The global
    // dir matters most for online installs, where the plugin package itself is
    // a managed, non-editable location.
    for (const dir of [getProjectWorkflowsDir(), getGlobalWorkflowsDir()]) {
      if (!dir) continue;
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (e: any) {
        console.error("[ralph-flow] Error initializing workflows dir:", dir, e.message);
      }
    }
  }

  return {
    projectDir,
    // locks
    withLock, withInstanceLock,
    // op scope
    beginOp, getMySessionId, isSessionAlive,
    // paths
    getRalphFlowDir, getInstancesRoot, getReportsDir, getInstanceDir, instPath,
    getArtifactsDir, getArtifactsRelDir, getPluginWorkflowsDir, getProjectWorkflowsDir,
    getGlobalWorkflowsDir, getGlobalConfigHome,
    // instance infra
    generateInstanceId, isValidInstanceId, instanceExists,
    writeArtifactsDirName, writeExtraDirs, readExtraDirs,
    readOwnerSession, writeOwnerSession,
    listInstances, resolveInstance, bindInstance, destroyInstance,
    instanceStatusLabel, formatInstanceList, formatLastActivity,
    getBoundInstance, setBoundInstance,
    // state + markers
    readState, writeState, isValidState,
    writeMarker, clearMarker, markerExists,
    writeManualStepMarker, clearManualStepMarker, clearManualGate,
    clearReinjectCounter, clearDoPromptCache, clearDoneTagDetected,
    writeDoPromptCache, markPromptDelivered,
    writeAdversarialSession, clearAdversarialSession, readAdversarialSession,
    // workflows
    parseWorkflowFile, loadWorkflow, listWorkflows, lintWorkflow, buildDoctorReport,
    // steps + prompts
    getStep, buildDoPrompt, buildCheckPrompt, buildSubWorkflowUserTask,
    resolveSubWorkflowEntry, renderStepText,
    // stack
    pushState, popState, getStackDepth,
    // logs + records
    logEvent, recordStepStart, addStepRecord, loadStepRecords, getCurrentStepRecords,
    // reports
    buildReportText, archiveReport,
    // check parsing
    matchCheckTag, parseCheckResult, getAdversarialCheckReason,
    // transitions
    handleCheckPassed, handleCheckFailed,
    // startup
    migrateLegacyInstance, ensureProjectWorkflows,
  };
}

export function isSubWorkflowStep(step: StepDef): step is SubWorkflowStepDef {
  return "workflow" in step && typeof (step as SubWorkflowStepDef).workflow === "string";
}

// ─── Adversarial check defaults (shared with check.ts) ──────────────────────

export const DEFAULT_ADVERSARIAL_SYSTEM_PROMPT = `你是一个严格的检查者。你的职责是根据检查依据判断任务是否完成。

## 核心原则

1. 只审查，不修改
2. 严格按照"检查依据"判断，不要被其他因素干扰
3. 如果有任何疑问，判定为不通过

## 验证方法

你必须**自主探索**项目来验证任务是否完成：
- 根据任务类型，选择合适的验证方式
- 基于检查依据中的要求，逐一验证每一项
- 不要依赖任何外部提供的"实现总结"，只基于你自己的验证结果判断

## 判断逻辑

**通过条件**：检查依据中的每一项都满足
**不通过条件**：检查依据中任何一项不满足

## 输出格式

- 通过：先说明通过原因，最后一行输出 <promise-check>true</promise-check>
- 不通过：先说明失败原因，最后一行输出 <promise-check>false</promise-check>

标签必须独占最后一行。`;

export const DEFAULT_ADVERSARIAL_TIMEOUT_MS = 900_000;


