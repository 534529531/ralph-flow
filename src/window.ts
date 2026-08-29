/**
 * Terminal window spawning — cross-platform "open a new terminal window" for
 * the reset handoff (isNewOpen). opencode version: open a new terminal window
 * that attaches the freshly created reset session via `opencode --session`.
 *
 * Design rules (see docs/reset-window-design.md §5.2):
 * - argv is passed through directly, never parsed through a shell string. The
 *   new window's default shell (fish/zsh/cmd) is therefore irrelevant.
 * - macOS/Linux terminal programs demand a `-e`/`--` argument, so the command
 *   is carried by a tiny `#!/bin/sh` script (shellQuoted) instead.
 * - Any detection failure / headless / spawn error returns { ok: false } so the
 *   caller degrades gracefully — the workflow must never break over a window.
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface SpawnWindowResult {
  ok: boolean;
  error?: string;
}

export interface SpawnWindowOptions {
  cwd: string;
  title?: string;
}

export interface WindowPlan {
  /** Candidate launchers, tried in order until one spawns successfully. */
  candidates: Array<{ file: string; args: string[] }>;
  /** Temp script path to carry the command (macOS/Linux). Left on disk — the
   *  terminal reads it on launch; deleting early would break the spawn. */
  script?: string;
}

export interface BuildWindowPlanOpts {
  cmd: string;
  args: string[];
  cwd: string;
  title?: string;
  /** Injectable for tests. Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injectable for tests. Defaults to real env probe. */
  hasDisplay?: boolean;
  /** Injectable for tests: which linux terminals are considered installed. */
  linuxTerminals?: string[];
}

const LINUX_TERMINALS = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"];

function hasDisplayEnv(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function writeTempScript(cmd: string, args: string[], cwd: string, title: string): string | null {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-open-"));
    const scriptPath = path.join(dir, "open.sh");
    const quoted = [cmd, ...args].map(shellQuote).join(" ");
    const content = `#!/bin/sh\ncd ${shellQuote(cwd)} && exec ${quoted} # ${title.replace(/\n/g, " ")}\n`;
    fs.writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o755 });
    return scriptPath;
  } catch {
    return null;
  }
}

/**
 * Pure plan builder — computes WHAT would be run for the platform. Exported for
 * tests; spawnTerminalWindow executes the plan.
 */
export function buildWindowPlan(opts: BuildWindowPlanOpts): { plan?: WindowPlan; error?: string } {
  const platform = opts.platform ?? process.platform;
  const title = opts.title ?? "ralph-flow";
  const display = opts.hasDisplay ?? hasDisplayEnv();

  if (platform === "win32") {
    // Windows Terminal first; `cmd /c start` as the always-present fallback.
    return {
      plan: {
        candidates: [
          { file: "wt.exe", args: ["new-window", "--title", title, opts.cmd, ...opts.args] },
          { file: "cmd.exe", args: ["/c", "start", "", opts.cmd, ...opts.args] },
        ],
      },
    };
  }

  if (platform === "darwin") {
    if (!display) return { error: "headless 环境，无窗口可开" };
    const script = writeTempScript(opts.cmd, opts.args, opts.cwd, title);
    if (!script) return { error: "写入临时脚本失败" };
    return {
      plan: { candidates: [{ file: "open", args: ["-a", "Terminal", script] }], script },
    };
  }

  if (platform === "linux") {
    if (!display) return { error: "headless 环境，无窗口可开" };
    const script = writeTempScript(opts.cmd, opts.args, opts.cwd, title);
    if (!script) return { error: "写入临时脚本失败" };
    const terminals = opts.linuxTerminals ?? LINUX_TERMINALS;
    const candidates = terminals.map((term) => ({
      file: term,
      args: term === "gnome-terminal" ? ["--", script] : ["-e", script],
    }));
    return { plan: { candidates, script } };
  }

  return { error: `不支持的平台：${platform}` };
}

/**
 * Detached spawn that resolves true only once the child process actually
 * STARTED. ENOENT (missing wt.exe / terminal) arrives asynchronously via the
 * child's 'error' event — a synchronous try/catch would miss it and let it
 * surface as an unhandled error in the parent process.
 */
function spawnDetached(file: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { cwd, detached: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

/**
 * Open a new terminal window running `cmd args` with cwd. Best effort:
 * candidates (wt.exe → cmd start / open -a Terminal / linux terminal table)
 * are tried in order. Returns ok:false (never throws) on every failure so the
 * caller degrades to the in-app fallback.
 */
export async function spawnTerminalWindow(
  cmd: string,
  args: string[],
  opts: SpawnWindowOptions,
): Promise<SpawnWindowResult> {
  const { plan, error } = buildWindowPlan({ cmd, args, cwd: opts.cwd, title: opts.title });
  if (!plan) return { ok: false, error };

  for (const c of plan.candidates) {
    if (await spawnDetached(c.file, c.args, opts.cwd)) return { ok: true };
  }
  return { ok: false, error: "无法打开新终端窗口（候选启动器均失败）" };
}