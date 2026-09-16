/** Ralph Flow 的 OpenCode V2 服务插件边界。 */

import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { RALPH_COMMANDS, registerWorkflowCommands, type RalphCommandDef } from "./commands.js";
import { createEngine, type Engine, type Platform } from "./engine.js";
import { createTools } from "./tools.js";
import { toV2Tool } from "./v2-tool.js";
import { createV2ClientAdapter } from "./v2-client.js";
import { handleSessionIdle, handleSessionGone } from "./driver.js";
import { abortActiveCheck, isCheckSession } from "./check.js";
import { deleteVotingProgress } from "./voting-progress.js";
import { setup } from "./setup.js";

const setupDirs = new Set<string>();
const orphanCleanedDirs = new Set<string>();

type ServerEvent = {
  type: string;
  data?: {
    sessionID?: string;
    reason?: string;
    status?: { type?: string };
  };
};

async function cleanupOrphanVerifiers(client: any, engine: Engine): Promise<void> {
  try {
    for (const instance of engine.listInstances()) {
      if (instance.state.current_phase !== "check") continue;
      const orphans = engine.readAdversarialSessions(instance.id);
      if (orphans.length === 0) continue;
      for (const id of orphans) {
        try { await client.session.delete({ path: { id } }); } catch {}
      }
      engine.clearAdversarialSession(instance.id);
      deleteVotingProgress(engine, instance.id);
      engine.logEvent(instance.id, "info", "orphan_verifier_cleaned", { count: orphans.length });
    }
  } catch {}
}

function expandCommand(template: string, input: string): string {
  const value = input.trim();
  if (template.includes("$ARGUMENTS")) return template.split("$ARGUMENTS").join(value);
  return [template, value].filter(Boolean).join("\n\n");
}

async function registerCommands(context: PluginContext, engine: Engine): Promise<void> {
  const current = await context.command.list();
  const existing = new Set(current.data.map((command) => command.name));
  const definitions: Record<string, RalphCommandDef | undefined> = { ...RALPH_COMMANDS };
  registerWorkflowCommands(definitions, engine.listWorkflows());

  await context.command.transform((editor) => {
    for (const [name, definition] of Object.entries(definitions)) {
      if (!definition || existing.has(name)) continue;
      editor.add({
        name,
        description: definition.description,
        async execute({ sessionID, prompt, delivery }) {
          await context.session.prompt({
            ...prompt,
            sessionID,
            text: expandCommand(definition.template, prompt.text),
            delivery,
          });
        },
      });
    }
  });
}

export async function handleOpenCodeEvent(
  event: ServerEvent,
  client: ReturnType<typeof createV2ClientAdapter>,
  engine: Engine,
): Promise<void> {
  const id = event.data?.sessionID;
  if (!id) return;

  const reachedIdle =
    event.type === "session.idle" ||
    event.type === "session.compacted" ||
    event.type === "session.execution.succeeded" ||
    (event.type === "session.status" && event.data?.status?.type === "idle");
  if (reachedIdle) {
    if (isCheckSession(id)) return;
    await handleSessionIdle(client, engine, id).catch(() => {});
    return;
  }

  if (event.type === "session.execution.interrupted") {
    await handleSessionGone(engine, id, "aborted").catch(() => {});
    return;
  }

  if (event.type === "session.deleted") {
    await handleSessionGone(engine, id, "deleted").catch(() => {});
  }
}

async function setupPlugin(context: PluginContext) {
  const directory = context.location.directory;
  if (!setupDirs.has(directory)) {
    setup(directory);
    setupDirs.add(directory);
  }

  // setup() 可能刚写入全局 agent/skill 文件；显式 reload 保证热加载和首会话
  // 都能立即看见 ralph-check，而不依赖下一次进程启动。
  await Promise.all([context.agent.reload(), context.skill.reload()]);

  const verifierSystemPrompts = new Map<string, string>();
  const client = createV2ClientAdapter(context, { verifierSystemPrompts });
  const platform: Platform = {
    abortActiveCheck(instanceID) {
      abortActiveCheck(client, instanceID);
    },
  };
  const engine = createEngine(directory, platform);
  engine.ensureProjectWorkflows();
  engine.migrateLegacyInstance();

  await context.session.hook("context", (event) => {
    const system = verifierSystemPrompts.get(event.sessionID);
    if (system) event.system.push({ type: "text", text: system });
  });

  const tools = createTools(engine, client);
  await context.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(tools)) {
      editor.add(toV2Tool(name, definition));
    }
  });
  await registerCommands(context, engine);

  await context.permission.hook("evaluate", (event) => {
    try {
      if (isCheckSession(event.sessionID)) return;
      if (engine.listInstances().some((instance) => instance.owner === event.sessionID)) {
        event.effect = "allow";
      }
    } catch {
      // 插件异常不能把权限请求变成误拒绝或悬挂。
    }
  });

  if (!orphanCleanedDirs.has(directory)) {
    orphanCleanedDirs.add(directory);
    await cleanupOrphanVerifiers(client, engine);
  }

  const controller = new AbortController();
  const eventTask = (async () => {
    for await (const event of context.event.subscribe({ signal: controller.signal })) {
      await handleOpenCodeEvent(event as unknown as ServerEvent, client, engine);
    }
  })().catch(() => {});

  return async () => {
    controller.abort();
    await eventTask;
  };
}

export const RalphFlowPlugin = Plugin.define({
  id: "ralph-flow",
  setup: setupPlugin,
});

export default RalphFlowPlugin;
