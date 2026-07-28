import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

export default {
  id: "ralph-flow",
  tui: async (api) => {
    api.event.on("session.created", (evt) => {
      const info = (evt as any).properties?.info;
      // Reset sessions are top-level (no parentID) so they show up in /session;
      // the server side also publishes tui.session.select directly, this is the
      // redundant path for installs where that publish is rejected (old server).
      if (info?.title?.startsWith("🔄") && !info?.parentID) {
        api.route.navigate("session", { sessionID: info.id });
        api.ui.toast({ variant: "info", message: "工作流已在干净上下文中继续" });
      }
    });
  },
} satisfies TuiPluginModule;
