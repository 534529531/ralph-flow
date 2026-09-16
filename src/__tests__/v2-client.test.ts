import { describe, expect, it, vi } from "vitest";
import { createV2ClientAdapter } from "../v2-client.js";

describe("OpenCode V2 client adapter", () => {
  it("marks noReply phase updates visible in the V2 TUI", async () => {
    const synthetic = vi.fn().mockResolvedValue({ id: "msg_status" });
    const prompt = vi.fn().mockResolvedValue({ id: "msg_prompt" });
    const context = {
      session: {
        synthetic,
        prompt,
        switchAgent: vi.fn(),
        switchModel: vi.fn(),
      },
    } as any;
    const client = createV2ClientAdapter(context, { verifierSystemPrompts: new Map() });

    await client.session.promptAsync({
      path: { id: "ses_owner" },
      body: {
        parts: [{ type: "text", text: "🔍 CHECK 阶段:自动验证中" }],
        noReply: true,
      },
    });

    expect(synthetic).toHaveBeenCalledWith({
      sessionID: "ses_owner",
      text: "🔍 CHECK 阶段:自动验证中",
      description: "Ralph Flow 状态更新",
      resume: false,
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("continues to send normal driving prompts as resumable prompts", async () => {
    const synthetic = vi.fn();
    const prompt = vi.fn().mockResolvedValue({ id: "msg_prompt" });
    const context = {
      session: {
        synthetic,
        prompt,
        switchAgent: vi.fn(),
        switchModel: vi.fn(),
      },
    } as any;
    const client = createV2ClientAdapter(context, { verifierSystemPrompts: new Map() });

    await client.session.promptAsync({
      path: { id: "ses_owner" },
      body: { parts: [{ type: "text", text: "继续执行 DO" }] },
    });

    expect(prompt).toHaveBeenCalledWith({
      sessionID: "ses_owner",
      text: "继续执行 DO",
      resume: true,
    });
    expect(synthetic).not.toHaveBeenCalled();
  });
});
