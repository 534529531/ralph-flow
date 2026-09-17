import { describe, expect, it, vi } from "vitest";
import { RalphFlowTuiPlugin } from "../tui.js";

function setupTui() {
  let listener: ((event: any) => void) | undefined;
  const navigate = vi.fn();
  const show = vi.fn();
  const context = {
    data: {
      on: vi.fn((_type: string, callback: (event: any) => void) => {
        listener = callback;
        return vi.fn();
      }),
    },
    ui: { router: { navigate }, toast: { show } },
  } as any;
  RalphFlowTuiPlugin.setup(context);
  return { listener: listener!, navigate, show };
}

describe("OpenCode V2 Ralph Flow TUI handoff", () => {
  it.each(["🔄 Ralph Flow reset", "🔙 Ralph Flow rewind"])("follows a top-level %s session", (title) => {
    const tui = setupTui();
    tui.listener({ data: { title, sessionID: "ses_new" } });
    expect(tui.navigate).toHaveBeenCalledWith({ type: "session", sessionID: "ses_new" });
    expect(tui.show).toHaveBeenCalledWith({ variant: "info", message: "工作流已在干净上下文中继续" });
  });

  it("does not steal the screen for a verifier or child session", () => {
    const tui = setupTui();
    tui.listener({ data: { title: "Ralph Check: loop", sessionID: "ses_check" } });
    tui.listener({ data: { title: "🔄 child", sessionID: "ses_child", parentID: "ses_parent" } });
    expect(tui.navigate).not.toHaveBeenCalled();
    expect(tui.show).not.toHaveBeenCalled();
  });
});
