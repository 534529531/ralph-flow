/**
 * Ralph Flow plugin for opencode — wiring layer.
 *
 * Composition (workflow logic mirrors the Claude plugin; runtime is native):
 *   MCP server (tools)   → Hooks.tool (src/tools.ts)
 *   Stop hook             → session.idle event (src/driver.ts)
 *   PostToolUse hook      → not needed (tool context carries sessionID)
 *   skills/ (commands)    → Hooks.config command registration (src/commands.ts);
 *                           every launchable workflow ALSO gets its own slash
 *                           command there (/loop, /spec, …) — see the config hook
 *   spawned `claude -p`   → independent SDK session (src/check.ts)
 *
 * Ownership is just the session_id in each instance's state.json — no session
 * liveness probe (opencode can't cheaply tell whether a session is still open),
 * so instance takeover is explicit (`/ralphflow-continue`, optionally with an
 * instance id) or automatic when a single instance exists.
 */

import type { Plugin, PluginModule, Config } from "@opencode-ai/plugin";
import { RALPH_COMMANDS, registerWorkflowCommands } from "./commands.js";
import { createEngine, type Platform, RALPH_CHECK_AGENT_PERMISSION } from "./engine.js";
import { createTools } from "./tools.js";
import { handleSessionIdle, handleSessionGone } from "./driver.js";
import { abortActiveCheck, isCheckSession } from "./check.js";
import { deleteVotingProgress } from "./voting-progress.js";
import { setup } from "./setup.js";

const setupDirs = new Set<string>();
const orphanCleanedDirs = new Set<string>();

/**
 * Plugin-load orphan cleanup (design §6.2): after a process restart, verifier
 * sessions created by the previous process are orphans — nobody will ever
 * collect their results. Delete them so the next idle re-runs the check
 * instead of stalling on a stale .adversarial-session. Also fixes the
 * single-verifier "restart then idle-stuck" behavior.
 */
async function cleanupOrphanVerifiers(client: any, engine: ReturnType<typeof createEngine>): Promise<void> {
  try {
    const instances = engine.listInstances();
    for (const inst of instances) {
      if (inst.state.current_phase !== "check") continue;
      const orphans = engine.readAdversarialSessions(inst.id);
      if (orphans.length === 0) continue;
      for (const sid of orphans) {
        try { await client.session.delete({ path: { id: sid } }); } catch {}
      }
      engine.clearAdversarialSession(inst.id);
      deleteVotingProgress(engine, inst.id);
      engine.logEvent(inst.id, "info", "orphan_verifier_cleaned", { count: orphans.length });
    }
  } catch {}
}

const RalphFlowPlugin: Plugin = async ({ client, directory }) => {
  if (!setupDirs.has(directory)) {
    setup(directory);
    setupDirs.add(directory);
  }

  const platform: Platform = {
    abortActiveCheck(instId) {
      abortActiveCheck(client, instId);
    },
  };

  const engine = createEngine(directory, platform);
  engine.ensureProjectWorkflows();
  engine.migrateLegacyInstance();

  // Orphan verifier cleanup: once per project per process (design §6.2).
  if (!orphanCleanedDirs.has(directory)) {
    orphanCleanedDirs.add(directory);
    void cleanupOrphanVerifiers(client, engine);
  }

  const tools = createTools(engine, client);

  return {
    config: async (input: Config) => {
      input.command = input.command ?? {};
      for (const [name, def] of Object.entries(RALPH_COMMANDS)) {
        if (!input.command[name]) {
          input.command[name] = def;
        }
      }

      // 动态注册：每个可启动的工作流各得到一个快捷 slash 命令（/loop、
      // /spec……），补全列表里显示为 "loop (ralph-flow) <描述>"。省去
      // list → start 的两步旅程。静态管理命令先注册，撞名一律不覆盖。
      registerWorkflowCommands(input.command, engine.listWorkflows());

      // Register the ralph-check agent dynamically as well, so the very first
      // session works even before setup() has written the agent file.
      input.agent = input.agent ?? {};
      if (!input.agent["ralph-check"]) {
        input.agent["ralph-check"] = {
          description: "Ralph Flow 检查阶段 agent —— 验证者",
          mode: "all",
          // edit hard-denied, bash open. See RALPH_CHECK_AGENT_PERMISSION —
          // mutation safety is anchored on `edit: deny` + the system prompt,
          // NOT a bash allow-list (overlay with opencode's own plan/explore agents).
          permission: RALPH_CHECK_AGENT_PERMISSION,
        } as any;
      }
    },

    tool: tools,

    // Full-automation permission gate. Ralph Flow drives the model unattended,
    // so an interactive permission prompt would stall the loop forever. Auto-allow
    // permissions, but ONLY for the session that owns an active ralph-flow instance
    // — never for arbitrary sessions, and never for the verifier session (its
    // agent-level `edit: deny` in RALPH_CHECK_AGENT_PERMISSION must stand so the
    // checker can't mutate the workspace it is judging).
    "permission.ask": async (input: any, output: { status: "ask" | "deny" | "allow" }) => {
      try {
        const sessionId: string | undefined = input?.sessionID;
        if (!sessionId) return;
        if (isCheckSession(sessionId)) return; // verifier session: leave its gate untouched
        const ownsActiveInstance = engine.listInstances().some((i) => i.owner === sessionId);
        if (ownsActiveInstance) output.status = "allow";
      } catch {
        // Never let a plugin error turn into a denied/hung permission prompt.
      }
    },

    event: async ({ event }) => {
      const props: any = (event as any).properties || {};

      if (event.type === "session.idle") {
        const sessionId: string | undefined = props.sessionID;
        if (!sessionId) return;
        // The verifier's own session also idles in this project — never drive it.
        if (isCheckSession(sessionId)) return;
        await handleSessionIdle(client, engine, sessionId).catch(() => {});
        return;
      }

      if (event.type === "session.compacted") {
        // After compaction the session forgot its task — re-drive it exactly
        // like an idle (the keep-alive re-injects the cached DO prompt).
        const sessionId: string | undefined = props.sessionID;
        if (!sessionId || isCheckSession(sessionId)) return;
        await handleSessionIdle(client, engine, sessionId).catch(() => {});
        return;
      }

      if (event.type === "session.error") {
        const error = props.error;
        const sessionId: string | undefined = props.sessionID;
        if (error?.name === "MessageAbortedError" && sessionId) {
          await handleSessionGone(engine, sessionId, "aborted").catch(() => {});
        }
        return;
      }

      if (event.type === "session.deleted") {
        const deletedSessionId: string | undefined = props?.info?.id;
        if (!deletedSessionId) return;
        await handleSessionGone(engine, deletedSessionId, "deleted").catch(() => {});
        return;
      }
    },
  };
};

// V1 PluginModule format (opencode >= 1.3.x)
export default {
  id: "ralph-flow",
  server: RalphFlowPlugin,
} satisfies PluginModule;

// Legacy format for older opencode versions
export { RalphFlowPlugin as RalphFlow };
