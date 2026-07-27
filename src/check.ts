/**
 * Adversarial Check (Independent Verification) — opencode adapter.
 *
 * Mirrors the contract of the Claude Code version's adversarialCheck (spawned
 * `claude -p` subprocess): same inputs, same { passed, infra?, reason } result,
 * same infra-vs-work-failure classification. The execution vehicle differs by
 * platform: here the verifier runs as an independent SDK session using the
 * `ralph-check` agent (edit hard-denied, bash open), with mutation safety
 * anchored on `edit: deny` + the system prompt rather than a bash allow-list.
 *
 * Cancellation: the check session id is written to the instance dir
 * (.adversarial-session — the counterpart of the Claude version's
 * .adversarial-pid) and registered in an in-process map so destroyInstance can
 * abort it. A check owned by ANOTHER process cannot be reached from here; its
 * result is discarded by the phase-3 state checks.
 */

import fs from "fs";
import type { Engine, NormalStepDef, AdversarialCheckConfig, CheckResult } from "./engine.js";
import { DEFAULT_ADVERSARIAL_SYSTEM_PROMPT, DEFAULT_ADVERSARIAL_TIMEOUT_MS, resolveCheckModel } from "./engine.js";

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

/**
 * Pull a human-readable message out of a failed SDK request result. The SDK
 * is called with throwOnError=false, so a rejected prompt (unknown model,
 * provider auth failure, server-side die — e.g. opencode's ModelNotFoundError
 * path) arrives as { data: undefined, error: <400/404/500 body> } instead of
 * an exception. Shapes seen in the wild: {name, data:{message}}, {message},
 * plain strings, and statusText-only failures.
 */
function extractRequestError(response: unknown): string | null {
  const r = response as { error?: unknown } | null | undefined;
  const err = r?.error;
  if (err === null || err === undefined) return null;
  if (typeof err === "string") return err.trim() || null;
  if (typeof err === "object") {
    const e = err as { data?: { message?: unknown }; message?: unknown; name?: unknown };
    const msg = e.data?.message ?? e.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
    try {
      const s = JSON.stringify(err);
      if (s && s !== "{}") return s.length > 500 ? s.substring(0, 500) + "…" : s;
    } catch {}
    if (typeof e.name === "string" && e.name) return e.name;
  }
  return String(err);
}

type ModelRef = { providerID: string; modelID: string };

/**
 * The verifier agent's EXPLICITLY configured model (e.g. opencode.json
 * `agent.ralph-check.model`). Server-side priority is
 * `input.model ?? agent.model ?? currentModel(session)`, so when the agent
 * has one we must NOT pass an owner-session model — that would shadow the
 * user's deliberate per-agent config.
 */
async function readAgentModel(client: Client, agentName: string): Promise<ModelRef | undefined> {
  try {
    const res = await client.app.agents();
    const list = (res as { data?: Array<{ name?: string; model?: { providerID?: string; modelID?: string } }> })?.data ?? [];
    const found = list.find((a) => a?.name === agentName);
    const m = found?.model;
    if (m && typeof m.providerID === "string" && m.providerID && typeof m.modelID === "string" && m.modelID) {
      return { providerID: m.providerID, modelID: m.modelID };
    }
  } catch {}
  return undefined;
}

/**
 * The model the OWNER session is actually running on (its most recent user
 * message — the same source the server's own currentModel fallback reads).
 * A brand-new check session has no history, so that fallback lands on
 * opencode's GLOBAL default model instead of the model the user switched
 * their work session to. Reading it here makes the verifier follow the
 * user's live choice unless the workflow or the agent config says otherwise.
 */
async function readOwnerSessionModel(client: Client, ownerSessionId: string | null): Promise<ModelRef | undefined> {
  if (!ownerSessionId) return undefined;
  try {
    const res = await client.session.messages({ path: { id: ownerSessionId } });
    const list = (res as { data?: Array<{ info?: { role?: string; model?: { providerID?: string; modelID?: string } } }> })?.data ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const info = list[i]?.info;
      const m = info?.model;
      if (info?.role === "user" && m && typeof m.providerID === "string" && m.providerID && typeof m.modelID === "string" && m.modelID) {
        return { providerID: m.providerID, modelID: m.modelID };
      }
    }
  } catch {}
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
  const agent = adversarialConfig?.agent || "ralph-check";
  // Model resolution, mirroring the server's `input.model ?? agent.model ??
  // currentModel(session)` — but that session fallback is unreachable for a
  // fresh check session (no history → opencode's GLOBAL default, not the
  // user's current one), so we substitute the owner session's live model:
  //   workflow yaml (valid) → passed explicitly
  //   agent's own config    → pass NOTHING, let the server apply it
  //   owner session current → passed explicitly (the fix for "check uses the
  //                           wrong model" reports)
  //   otherwise             → omitted (opencode global default)
  let model = resolveCheckModel(adversarialConfig?.model);
  let modelSource: "workflow" | "agent-config" | "owner-session" | "global-default" = model ? "workflow" : "global-default";
  if (!model) {
    if (await readAgentModel(client, agent)) {
      modelSource = "agent-config";
    } else {
      model = await readOwnerSessionModel(client, ownerSessionId);
      if (model) modelSource = "owner-session";
    }
  }

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

  engine.logEvent(instId, "info", "adversarial_check_start", { stepId: step.id, agent, model: model ? `${model.providerID}/${model.modelID}` : "agent-default", model_source: modelSource, timeout_ms: timeout, extra_dirs: extraDirs });

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
      const promptPromise = client.session.prompt({
        path: { id: checkSessionId },
        body: {
          ...(model ? { model } : {}),
          agent,
          system: systemPrompt,
          parts: [{ type: "text", text: checkPrompt }],
        },
      });
      // If the timeout (or an abort) wins the race, this promise stays pending
      // and later rejects — most reliably right after we call session.abort().
      // Without a handler that late rejection is an UnhandledPromiseRejection
      // (there is no process-level guard), which can crash the opencode host.
      // A no-op catch makes the late rejection harmless; the race result is
      // still driven by the awaited Promise.race below.
      Promise.resolve(promptPromise).catch(() => {});
      response = await Promise.race([
        promptPromise,
        // The timer MUST be cleared when the prompt wins the race — an
        // uncleared setTimeout keeps the event loop alive for the full timeout
        // (up to 1h), delaying process exit and leaking one timer per check.
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error("Adversarial check timeout")), timeout);
        }),
      ]);
    } catch (err: any) {
      if (aborted || !engine.instanceExists(instId)) {
        return { passed: false, infra: true, reason: "工作流实例已被取消。" };
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
      return { passed: false, infra: true, reason: "工作流实例已被取消。" };
    }

    // A rejected request (unknown/unauthorized model, provider 5xx, …) is NOT
    // thrown — the SDK resolves with an error body. Surface the real message
    // so a misconfigured adversarial_check.model doesn't masquerade as an
    // "empty response". Still infra: the verdict never ran, no fail burn.
    const requestError = extractRequestError(response);
    if (requestError) {
      engine.logEvent(instId, "error", "adversarial_check_request_failed", { stepId: step.id, agent, model: model ? `${model.providerID}/${model.modelID}` : "agent-default", error: requestError });
      return {
        passed: false,
        infra: true,
        reason: `验证请求失败：${requestError}

可能原因：
- 验证使用的模型（${model ? `${model.providerID}/${model.modelID}` : "agent 默认"}${modelSource === "workflow" ? "，来自工作流 adversarial_check.model 配置" : modelSource === "owner-session" ? "，来自工作会话当前模型" : ""}）不存在、未启用或未授权
- 对应 provider 的 API 端点异常或额度耗尽

修复配置（或稍等恢复）后运行 /ralphflow-continue 重新验证。`,
      };
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
