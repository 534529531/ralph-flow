import { OpenCode, type OpenCodeClient, type SessionMessageInfo } from "@opencode/client";
import { discover, headers } from "@opencode/client/service";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";

export interface LegacyModelRef {
  providerID: string;
  modelID: string;
}

interface LegacyRequest {
  path?: { id?: string };
  query?: { directory?: string };
  body?: {
    title?: string;
    agent?: string;
    model?: LegacyModelRef | { providerID: string; id: string };
    permissions?: ReadonlyArray<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>;
    parts?: Array<{ type: string; text?: string }>;
    system?: string;
    noReply?: boolean;
  };
}

export interface V2ClientAdapterOptions {
  verifierSystemPrompts: Map<string, string>;
  /** 测试或宿主补丁可注入；正常运行时自动连接当前已注册的本地服务。 */
  removeSession?: (sessionID: string) => Promise<void>;
}

function sessionID(request: LegacyRequest): string {
  const id = request.path?.id;
  if (!id) throw new Error("缺少 session id");
  return id;
}

function promptText(request: LegacyRequest): string {
  return (request.body?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function toV2Model(model: LegacyRequest["body"] extends infer _ ? LegacyModelRef | { providerID: string; id: string } | undefined : never) {
  if (!model) return undefined;
  const id = "modelID" in model ? model.modelID : model.id;
  return { providerID: model.providerID, id };
}

function toLegacyModel(model: { providerID: string; id: string } | undefined): LegacyModelRef | undefined {
  return model ? { providerID: model.providerID, modelID: model.id } : undefined;
}

function assistantParts(message: Extract<SessionMessageInfo, { type: "assistant" }>) {
  return message.content.map((part) => {
    if (part.type === "text" || part.type === "reasoning") return { type: part.type, text: part.text };
    return { type: "tool" };
  });
}

function legacyMessages(messages: readonly SessionMessageInfo[], currentModel?: { providerID: string; id: string }) {
  return messages.map((message) => {
    if (message.type === "assistant") {
      return {
        info: { role: "assistant", model: toLegacyModel(message.model) },
        parts: assistantParts(message),
      };
    }
    if (message.type === "user") {
      return {
        info: { role: "user", model: toLegacyModel(currentModel) },
        parts: [{ type: "text", text: message.text }],
      };
    }
    return { info: { role: message.type }, parts: [] };
  });
}

function lastAssistant(messages: readonly SessionMessageInfo[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.type === "assistant") return message;
  }
  return undefined;
}

/**
 * 核心代码仍使用 V1 SDK 的小切面；这里把它映射到 V2 Promise 插件上下文。
 * 适配范围刻意限制在 Ralph Flow 实际调用的方法，避免伪造完整旧客户端。
 */
export function createV2ClientAdapter(context: PluginContext, options: V2ClientAdapterOptions) {
  let removalClient: Promise<OpenCodeClient> | undefined;

  const removeThroughService = async (id: string): Promise<void> => {
    if (options.removeSession) return options.removeSession(id);

    // 2.0.3/2.0.4 的 HTTP 客户端有 session.remove，但 Promise 插件上下文
    // 遗漏了该方法。先支持宿主未来补齐；当前版本则连接同版本已注册服务。
    const direct = (context.session as unknown as { remove?: (input: { sessionID: string }) => Promise<void> }).remove;
    if (direct) return direct({ sessionID: id });

    removalClient ??= (async () => {
      const endpoint = await discover({ version: context.app.version });
      if (!endpoint) throw new Error("无法发现当前 OpenCode 服务，验证会话未能删除");
      return OpenCode.make({ baseUrl: endpoint.url, headers: headers(endpoint) });
    })();
    const client = await removalClient;
    await client.session.remove({ sessionID: id });
  };

  const preparePrompt = async (id: string, body: NonNullable<LegacyRequest["body"]>) => {
    if (body.agent) await context.session.switchAgent({ sessionID: id, agent: body.agent });
    const model = toV2Model(body.model);
    if (model) await context.session.switchModel({ sessionID: id, model });
  };

  const promptAsync = async (request: LegacyRequest) => {
    const id = sessionID(request);
    const body = request.body ?? {};
    await preparePrompt(id, body);
    const text = promptText(request);
    const data = body.noReply
      ? await context.session.synthetic({ sessionID: id, text, resume: false })
      : await context.session.prompt({ sessionID: id, text, resume: true });
    return { data };
  };

  const promptBlocking = async (request: LegacyRequest) => {
    const id = sessionID(request);
    const body = request.body ?? {};
    await preparePrompt(id, body);
    if (body.system) options.verifierSystemPrompts.set(id, body.system);
    try {
      await context.session.prompt({ sessionID: id, text: promptText(request), resume: true });
      await context.session.wait({ sessionID: id });
      const messages = await context.session.context({ sessionID: id });
      const assistant = lastAssistant(messages);
      if (assistant?.error) return { error: assistant.error };
      return { data: { parts: assistant ? assistantParts(assistant) : [] } };
    } finally {
      if (body.system && options.verifierSystemPrompts.get(id) === body.system) {
        options.verifierSystemPrompts.delete(id);
      }
    }
  };

  return {
    session: {
      async create(request: LegacyRequest) {
        const body = request.body ?? {};
        const data = await context.session.create({
          title: body.title,
          agent: body.agent,
          model: toV2Model(body.model),
          permissions: body.permissions,
          location: { directory: request.query?.directory ?? context.location.directory },
        });
        return { data };
      },
      async delete(request: LegacyRequest) {
        await removeThroughService(sessionID(request));
        return { data: true };
      },
      async abort(request: LegacyRequest) {
        const data = await context.session.interrupt({ sessionID: sessionID(request) });
        return { data };
      },
      async messages(request: LegacyRequest) {
        const id = sessionID(request);
        const [messages, session] = await Promise.all([
          context.session.context({ sessionID: id }),
          context.session.get({ sessionID: id }),
        ]);
        return { data: legacyMessages(messages, session.model) };
      },
      promptAsync,
      prompt: promptBlocking,
    },
    app: {
      async agents() {
        const response = await context.agent.list();
        return {
          data: response.data.map((agent) => ({
            name: agent.id,
            model: toLegacyModel(agent.model),
          })),
        };
      },
    },
    // V2 TUI 入口根据 session.created 负责跳转和 toast；服务侧旧调用保留为空操作。
    tui: {
      async publish() {},
      async showToast() {},
    },
  };
}
