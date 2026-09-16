import { Plugin } from "@opencode/plugin/tui";

export const RalphFlowTuiPlugin = Plugin.define({
  id: "ralph-flow",
  setup(context) {
    return context.data.on("session.created", (event) => {
      const info = event.data;
      // reset/rewind 会话必须是顶层会话，才能出现在会话列表并成为长期工作地。
      if ((info.title?.startsWith("🔄") || info.title?.startsWith("🔙")) && !info.parentID) {
        context.ui.router.navigate({ type: "session", sessionID: info.sessionID });
        context.ui.toast.show({ variant: "info", message: "工作流已在干净上下文中继续" });
      }
    });
  },
});

export default RalphFlowTuiPlugin;
