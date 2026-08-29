import { describe, it, expect, vi, afterEach } from "vitest";
import { buildWindowPlan, shellQuote } from "../window.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shellQuote", () => {
  it("wraps simple strings in single quotes", () => {
    expect(shellQuote("opencode")).toBe("'opencode'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("buildWindowPlan", () => {
  const opts = { cmd: "opencode", args: ["--session", "ses_123"], cwd: "/proj", title: "🔄 wf · step" };

  it("win32: wt.exe first, cmd start fallback, argv passthrough", () => {
    const { plan, error } = buildWindowPlan({ ...opts, platform: "win32" });
    expect(error).toBeUndefined();
    expect(plan?.candidates.length).toBe(2);
    expect(plan?.candidates[0].file).toBe("wt.exe");
    expect(plan?.candidates[0].args).toEqual(["new-window", "--title", "🔄 wf · step", "opencode", "--session", "ses_123"]);
    expect(plan?.candidates[1].file).toBe("cmd.exe");
    expect(plan?.candidates[1].args).toEqual(["/c", "start", "", "opencode", "--session", "ses_123"]);
  });

  it("darwin: temp sh script + open -a Terminal", () => {
    const { plan, error } = buildWindowPlan({ ...opts, platform: "darwin", hasDisplay: true });
    expect(error).toBeUndefined();
    expect(plan?.candidates.length).toBe(1);
    expect(plan?.candidates[0].file).toBe("open");
    expect(plan?.candidates[0].args[0]).toBe("-a");
    expect(plan?.candidates[0].args[1]).toBe("Terminal");
    expect(plan?.script).toBeTruthy();
  });

  it("darwin headless: fails without display", () => {
    const { plan, error } = buildWindowPlan({ ...opts, platform: "darwin", hasDisplay: false });
    expect(plan).toBeUndefined();
    expect(error).toContain("headless");
  });

  it("linux: terminal table becomes candidates carrying the script", () => {
    const { plan, error } = buildWindowPlan({ ...opts, platform: "linux", hasDisplay: true, linuxTerminals: ["konsole", "xterm"] });
    expect(error).toBeUndefined();
    expect(plan?.candidates.length).toBe(2);
    expect(plan?.candidates[0]).toEqual({ file: "konsole", args: ["-e", plan!.script!] });
    expect(plan?.candidates[1]).toEqual({ file: "xterm", args: ["-e", plan!.script!] });
  });

  it("linux: gnome-terminal uses `-- script` form", () => {
    const { plan, error } = buildWindowPlan({ ...opts, platform: "linux", hasDisplay: true, linuxTerminals: ["gnome-terminal"] });
    expect(error).toBeUndefined();
    expect(plan?.candidates[0].args).toEqual(["--", plan!.script!]);
  });

  it("linux headless: fails without display", () => {
    const { plan, error } = buildWindowPlan({ ...opts, platform: "linux", hasDisplay: false });
    expect(plan).toBeUndefined();
    expect(error).toContain("headless");
  });

  it("script content: shebang + cd + exec (argv carried, not shell-parsed at spawn)", () => {
    const { plan } = buildWindowPlan({ ...opts, platform: "darwin", hasDisplay: true });
    const fs = require("fs");
    const content = fs.readFileSync(plan!.script!, "utf-8");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("cd '/proj' && exec 'opencode' '--session' 'ses_123'");
  });

  it("unknown platform: fails", () => {
    const { plan, error } = buildWindowPlan({ ...opts, platform: "freebsd" as any });
    expect(plan).toBeUndefined();
    expect(error).toContain("不支持的平台");
  });
});