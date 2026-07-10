/**
 * Adversarial Check (Independent Verification) — opencode adapter.
 *
 * Mirrors the contract of the Claude Code version's adversarialCheck (spawned
 * `claude -p` subprocess): same inputs, same { passed, infra?, reason } result,
 * same infra-vs-work-failure classification. The execution vehicle differs by
 * platform: here the verifier runs as an independent SDK session using the
 * read-only `ralph-check` agent (edit: deny), which is opencode's native
 * equivalent of the Claude version's --allowedTools whitelist.
 *
 * Cancellation: the check session id is written to the instance dir
 * (.adversarial-session — the counterpart of the Claude version's
 * .adversarial-pid) and registered in an in-process map so destroyInstance can
 * abort it. A check owned by ANOTHER process cannot be reached from here; its
 * result is discarded by the phase-3 state checks.
 */

import fs from "fs";
import type { Engine, NormalStepDef, AdversarialCheckConfig, CheckResult } from "./engine.js";
import { DEFAULT_ADVERSARIAL_SYSTEM_PROMPT, DEFAULT_ADVERSARIAL_TIMEOUT_MS } from "./engine.js";

// Loose client typing: only the session sub-API is used, and the SDK's
// generated option types are far stricter than what we need here.
type Client = any;

interface ActiveCheck {
  checkSessionId: string;
  abort: () => void;
}

const activeChecks = new Map<string, ActiveCheck>(); // instId -> handle

/** Abort a still-running check for an instance (in-process only). */
export function abortActiveCheck(client: Client, instId: string): void {
  const active = activeChecks.get(instId);
  if (!active) return;
  activeChecks.delete(instId);
  try { active.abort(); } catch {}
  // Fire-and-forget: abort the generation, then drop the session.
  Promise.resolve()
    .then(() => client.session.abort({ path: { id: active.checkSessionId } }))
    .catch(() => {})
    .then(() => client.session.delete({ path: { id: active.checkSessionId } }))
    .catch(() => {});
}

export function hasActiveCheck(instId: string): boolean {
  return activeChecks.has(instId);
}

/** Whether a sessionID belongs to a currently running verifier session. */
export function isCheckSession(sessionId: string): boolean {
  for (const active of activeChecks.values()) {
    if (active.checkSessionId === sessionId) return true;
  }
  return false;
}

function extractResponseText(response: unknown): string {
  const data = response as { data?: { parts?: Array<{ type: string; text?: string }> } };
  const parts = data?.data?.parts ?? [];
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

/** Resolve the yaml model field into the SDK's {providerID, modelID} shape. */
function resolveModel(model: AdversarialCheckConfig["model"]): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  if (typeof model === "object") {
    if (model.providerID && model.modelID) return { providerID: model.providerID, modelID: model.modelID };
    return undefined;
  }
  // String form "provider/model" (Claude Code yaml compatibility); a bare name
  // without provider cannot be resolved here — fall back to the agent default.
  const idx = model.indexOf("/");
  if (idx > 0) return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
  return undefined;
}

/**
 * Run the independent verification for a step. `checkPrompt` is built by the
 * caller in phase 1 (with the explicit instId) and passed in, so this function
 * needs no instance binding of its own.
 */
export async function adversarialCheck(
  client: Client,
  engine: Engine,
  instId: string,
  ownerSessionId: string | null,
  step: NormalStepDef,
  checkPrompt: string,
  userTask: string | undefined,
  adversarialConfig?: AdversarialCheckConfig
): Promise<CheckResult> {
  const systemPrompt = adversarialConfig?.system_prompt || DEFAULT_ADVERSARIAL_SYSTEM_PROMPT;
  const timeout = adversarialConfig?.timeout_ms || DEFAULT_ADVERSARIAL_TIMEOUT_MS;
  const model = resolveModel(adversarialConfig?.model);
  const agent = adversarialConfig?.agent || "ralph-check";

  if (!engine.instanceExists(instId)) {
    return { passed: false, reason: "工作流实例已被取消。" };
  }
  // Re-validate extra_dirs here, not just at start: a dir deleted mid-workflow
  // would otherwise surface as a cryptic failure. Infra error → check_error
  // pause, no fail burn; continue re-verifies once the dir is restored.
  const extraDirs = engine.readExtraDirs(instId);
  const missingDirs = extraDirs.filter((d) => {
    try { return !fs.statSync(d).isDirectory(); } catch { return true; }
  });
  if (missingDirs.length > 0) {
    return { passed: false, infra: true, reason: `启动时通过 extra_dirs 声明的目录已不存在：${missingDirs.map((d) => `\`${d}\``).join("、")}。恢复该目录（或重新启动工作流）后调用 ralphflow_continue 重新验证。` };
  }

  engine.logEvent(instId, "info", "adversarial_check_start", { stepId: step.id, agent, model: model ? `${model.providerID}/${model.modelID}` : "agent-default", timeout_ms: timeout, extra_dirs: extraDirs });

  // Log the (near-)full prompts sent to the verifier, so the execution log is a
  // faithful record of exactly what was checked (matches the original opencode
  // plugin's behavior). Truncated to keep the log line bounded.
  const truncate = (t: string) => (t.length > 3000 ? t.substring(0, 3000) + "…(截断)" : t);
  engine.logEvent(instId, "info", "adversarial_check_prompt", { stepId: step.id, systemPrompt: truncate(systemPrompt), checkPrompt: truncate(checkPrompt) });

  // Create the independent verifier session.
  let checkSessionId: string;
  try {
    const checkSession = await client.session.create({
      body: {
        title: `Ralph Check: ${step.id} - ${(userTask || "").substring(0, 50)}`,
        ...(ownerSessionId ? { parentID: ownerSessionId } : {}),
      },
      query: { directory: engine.projectDir },
    });
    checkSessionId = (checkSession as { data: { id: string } }).data.id;
    if (!checkSessionId) throw new Error("session.create returned no id");
  } catch (err: any) {
    engine.logEvent(instId, "error", "adversarial_check_session_create_failed", { stepId: step.id, error: err.message });
    return { passed: false, infra: true, reason: `验证会话创建失败：${err.message}` };
  }

  // Register for cancellation support (in-process handle + cross-process file)
  let aborted = false;
  const handle: ActiveCheck = { checkSessionId, abort: () => { aborted = true; } };
  activeChecks.set(instId, handle);
  engine.writeAdversarialSession(checkSessionId, instId);

  // Close the cancel race: a cross-session cancel between the phase-1 pre-check
  // and the marker write above finds nothing to abort and deletes the instance
  // dir. If the instance is gone now, nobody else can ever reach this session —
  // clean it up ourselves.
  if (!engine.instanceExists(instId)) {
    activeChecks.delete(instId);
    try { await client.session.delete({ path: { id: checkSessionId } }); } catch {}
    engine.logEvent(instId, "warn", "adversarial_check_cancelled_before_start", { stepId: step.id });
    return { passed: false, reason: "工作流实例已被取消。" };
  }

  const startTime = Date.now();
  // Liveness watchdog: logs progress every minute (the Claude version also
  // watches the child pid; an SDK request has no pid to watch).
  const keepalive = setInterval(() => {
    engine.logEvent(instId, "info", "adversarial_check_keepalive", { stepId: step.id, elapsed_ms: Date.now() - startTime });
  }, 60_000);

  try {
    let response: unknown;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        client.session.prompt({
          path: { id: checkSessionId },
          body: {
            ...(model ? { model } : {}),
            agent,
            system: systemPrompt,
            parts: [{ type: "text", text: checkPrompt }],
          },
        }),
        // The timer MUST be cleared when the prompt wins the race — an
        // uncleared setTimeout keeps the event loop alive for the full timeout
        // (up to 1h), delaying process exit and leaking one timer per check.
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error("Adversarial check timeout")), timeout);
        }),
      ]);
    } catch (err: any) {
      if (aborted || !engine.instanceExists(instId)) {
        return { passed: false, reason: "工作流实例已被取消。" };
      }
      if (String(err.message).includes("timeout")) {
        // Abort the runaway generation before reporting.
        try { await client.session.abort({ path: { id: checkSessionId } }); } catch {}
        engine.logEvent(instId, "warn", "adversarial_check_timeout", { stepId: step.id });
        return {
          passed: false,
          infra: true,
          reason: `检查阶段超时（${Math.round(timeout / 60000)} 分钟）。验证耗时过长。

可能原因：
- 验证会话响应缓慢或无响应
- 任务对于验证模型过于复杂
- API 端点未响应

建议：
1. 使用 /ralphflow-status 查看当前状态
2. 使用 /ralphflow-continue 重试
3. 或使用 /ralphflow-cancel 取消工作流
4. 如果任务确实需要更长时间，可以在工作流配置中增加 timeout_ms`,
        };
      }
      engine.logEvent(instId, "error", "adversarial_check_error", { stepId: step.id, error: err.message });
      return { passed: false, infra: true, reason: `验证会话执行失败：${err.message}` };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    if (aborted) {
      return { passed: false, reason: "工作流实例已被取消。" };
    }

    const responseText = extractResponseText(response).trim();
    if (!responseText) {
      return { passed: false, infra: true, reason: "验证返回空响应。" };
    }

    const passed = engine.parseCheckResult(responseText);
    const reason = engine.getAdversarialCheckReason(responseText);
    // One clear line per check (verdict + a short reason snippet). The full
    // reason lives in state.last_failure_reason and the final report.
    engine.logEvent(instId, "info", "adversarial_check_result", { stepId: step.id, passed, len: responseText.length, reason: reason.substring(0, 160) });
    return { passed, reason };
  } finally {
    clearInterval(keepalive);
    if (activeChecks.get(instId) === handle) activeChecks.delete(instId);
    if (engine.readAdversarialSession(instId) === checkSessionId) engine.clearAdversarialSession(instId);
    try { await client.session.delete({ path: { id: checkSessionId } }); } catch {}
  }
}
