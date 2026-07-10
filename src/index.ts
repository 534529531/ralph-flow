/**
 * Ralph Flow plugin for opencode — wiring layer.
 *
 * Structural mirror of the Claude Code plugin's composition:
 *   MCP server (tools)   → Hooks.tool (src/tools.ts)
 *   Stop hook             → session.idle event (src/driver.ts)
 *   PostToolUse hook      → not needed (tool context carries sessionID)
 *   skills/ (commands)    → Hooks.config command registration (src/commands.ts)
 *   spawned `claude -p`   → independent SDK session (src/check.ts)
 *
 * Session liveness (Platform.isSessionAlive): the Claude version checks
 * ~/.claude/sessions pid files; here a session counts as alive when THIS
 * plugin process has seen activity from it and it has not been deleted. After
 * an opencode restart the set is empty, so every previous owner reads as
 * closed — exactly the auto-takeover journey for interrupted workflows.
 */

import type { Plugin, PluginModule, Config } from "@opencode-ai/plugin";
import { RALPH_COMMANDS } from "./commands.js";
import { createEngine, type Platform } from "./engine.js";
import { createTools } from "./tools.js";
import { handleSessionIdle, handleSessionGone } from "./driver.js";
import { abortActiveCheck, hasActiveCheck, isCheckSession } from "./check.js";
import { setup } from "./setup.js";

const setupDirs = new Set<string>();

const RalphFlowPlugin: Plugin = async ({ client, directory }) => {
  if (!setupDirs.has(directory)) {
    setup(directory);
    setupDirs.add(directory);
  }

  // ── Platform seam ──────────────────────────────────────────────────────────
  const seenSessions = new Set<string>();
  const platform: Platform = {
    isSessionAlive(sessionId) {
      return !!sessionId && seenSessions.has(sessionId);
    },
    abortActiveCheck(instId) {
      abortActiveCheck(client, instId);
    },
  };

  const engine = createEngine(directory, platform);
  engine.ensureProjectWorkflows();
  engine.migrateLegacyInstance();

  const tools = createTools(engine, client);

  return {
    config: async (input: Config) => {
      input.command = input.command ?? {};
      for (const [name, def] of Object.entries(RALPH_COMMANDS)) {
        if (!input.command[name]) {
          input.command[name] = def;
        }
      }

      // Register the ralph-check agent dynamically as well, so the very first
      // session works even before setup() has written the agent file.
      input.agent = input.agent ?? {};
      if (!input.agent["ralph-check"]) {
        input.agent["ralph-check"] = {
          description: "Ralph Flow check phase agent - read-only verification",
          mode: "all",
          permission: {
            edit: "deny",
            bash: "allow",
            external_directory: "allow",
          },
        } as any;
      }
    },

    tool: tools,

    "chat.message": async (input) => {
      if (input.sessionID) seenSessions.add(input.sessionID);
    },

    event: async ({ event }) => {
      const props: any = (event as any).properties || {};

      if (event.type === "session.idle") {
        const sessionId: string | undefined = props.sessionID;
        if (!sessionId) return;
        seenSessions.add(sessionId);
        // The verifier's own session also idles in this project — it must
        // never be driven or receive orphan hints.
        if (isCheckSession(sessionId)) return;
        await handleSessionIdle(client, engine, sessionId).catch((e) => {
          engine.logEvent("error", "session_idle_handler_failed", { error: String(e) });
        });
        return;
      }

      if (event.type === "session.compacted") {
        // After compaction the session forgot its task — re-drive it exactly
        // like an idle (the keep-alive re-injects the cached DO prompt).
        const sessionId: string | undefined = props.sessionID;
        if (!sessionId || isCheckSession(sessionId)) return;
        seenSessions.add(sessionId);
        await handleSessionIdle(client, engine, sessionId).catch((e) => {
          engine.logEvent("error", "session_compacted_handler_failed", { error: String(e) });
        });
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
        seenSessions.delete(deletedSessionId);
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
