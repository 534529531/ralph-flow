/**
 * Ralph Flow plugin for opencode — wiring layer.
 *
 * Composition (workflow logic mirrors the Claude plugin; runtime is native):
 *   MCP server (tools)   → Hooks.tool (src/tools.ts)
 *   Stop hook             → session.idle event (src/driver.ts)
 *   PostToolUse hook      → not needed (tool context carries sessionID)
 *   skills/ (commands)    → Hooks.config command registration (src/commands.ts)
 *   spawned `claude -p`   → independent SDK session (src/check.ts)
 *
 * Ownership is just the session_id in each instance's state.json — no session
 * liveness probe (opencode can't cheaply tell whether a session is still open),
 * so instance takeover is explicit (`/ralphflow-continue`, optionally with an
 * instance id) or automatic when a single instance exists.
 */

import type { Plugin, PluginModule, Config } from "@opencode-ai/plugin";
import { RALPH_COMMANDS } from "./commands.js";
import { createEngine, type Platform, RALPH_CHECK_AGENT_PERMISSION } from "./engine.js";
import { createTools } from "./tools.js";
import { handleSessionIdle, handleSessionGone } from "./driver.js";
import { abortActiveCheck, isCheckSession } from "./check.js";
import { setup } from "./setup.js";

const setupDirs = new Set<string>();

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
          // Read-only: deny edits and mutating shell (allow-list parity with the
          // Claude version's --allowedTools). See RALPH_CHECK_AGENT_PERMISSION.
          permission: RALPH_CHECK_AGENT_PERMISSION,
        } as any;
      }
    },

    tool: tools,

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
