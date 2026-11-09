import { describe, expect, it } from "vitest";
import RalphFlowPluginDefault, { RalphFlowPlugin } from "../index.js";
import TuiPluginDefault, { RalphFlowTuiPlugin } from "../tui.js";

/**
 * OpenCode 2.x 的插件加载器要求默认导出是 `{ id, setup | effect }`：
 * 缺任何一项都会以
 *   PluginModule.LoadError: Plugin must export a default definition with an id
 *   and an effect or setup function.
 * 拒绝加载，并且每 5 秒重试一次——整个插件的命令、工具、agent 全部不可用。
 *
 * 这正是 v1 适配版（默认导出是 `async (ctx) => ({})` 函数）在 OpenCode 2.x
 * 上的失败形态。这里对入口形状做最小回归，避免再次发出不可加载的包。
 */
describe("OpenCode V2 plugin entry shape", () => {
  it("default export is a definition with an id and a setup function", () => {
    expect(RalphFlowPluginDefault).toBe(RalphFlowPlugin);
    expect(RalphFlowPlugin.id).toBe("ralph-flow");
    expect(typeof RalphFlowPlugin.setup).toBe("function");
  });

  it("TUI default export is a definition with an id and a setup function", () => {
    expect(TuiPluginDefault).toBe(RalphFlowTuiPlugin);
    expect(RalphFlowTuiPlugin.id).toBe("ralph-flow");
    expect(typeof RalphFlowTuiPlugin.setup).toBe("function");
  });

  it("package exports the V2 server and TUI entrypoints", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.exports["."]).toBe("./dist/index.js");
    expect(pkg.exports["./tui"]).toBe("./dist/tui.js");
  });
});
