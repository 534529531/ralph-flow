import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleSessionIdle: vi.fn(),
  handleSessionGone: vi.fn(),
  isCheckSession: vi.fn(() => false),
}));

vi.mock("../driver.js", () => ({
  handleSessionIdle: mocks.handleSessionIdle,
  handleSessionGone: mocks.handleSessionGone,
}));
vi.mock("../check.js", () => ({ abortActiveCheck: vi.fn(), isCheckSession: mocks.isCheckSession }));

import { handleOpenCodeEvent } from "../index.js";

describe("OpenCode V2 event bridge", () => {
  const client = {} as any;
  const engine = {} as any;

  beforeEach(() => {
    mocks.handleSessionIdle.mockReset().mockResolvedValue(undefined);
    mocks.handleSessionGone.mockReset().mockResolvedValue(undefined);
    mocks.isCheckSession.mockReset();
    mocks.isCheckSession.mockReturnValue(false);
  });

  it.each(["session.idle", "session.compacted", "session.execution.succeeded"])(
    "drives the same idle path for %s",
    async (type) => {
      await handleOpenCodeEvent({ type, data: { sessionID: "ses_owner" } }, client, engine);
      expect(mocks.handleSessionIdle).toHaveBeenCalledWith(client, engine, "ses_owner");
    },
  );

  it("drives on the V2 idle status event", async () => {
    await handleOpenCodeEvent(
      { type: "session.status", data: { sessionID: "ses_owner", status: { type: "idle" } } },
      client,
      engine,
    );
    expect(mocks.handleSessionIdle).toHaveBeenCalledWith(client, engine, "ses_owner");
  });

  it("never drives a verifier session", async () => {
    mocks.isCheckSession.mockReturnValue(true);
    await handleOpenCodeEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_check" } }, client, engine);
    expect(mocks.handleSessionIdle).not.toHaveBeenCalled();
  });

  it("maps interruption and deletion to the V1 session-gone paths", async () => {
    await handleOpenCodeEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_owner" } }, client, engine);
    await handleOpenCodeEvent({ type: "session.deleted", data: { sessionID: "ses_deleted" } }, client, engine);
    expect(mocks.handleSessionGone).toHaveBeenNthCalledWith(1, engine, "ses_owner", "aborted");
    expect(mocks.handleSessionGone).toHaveBeenNthCalledWith(2, engine, "ses_deleted", "deleted");
  });
});
