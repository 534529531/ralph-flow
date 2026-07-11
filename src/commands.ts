/**
 * Ralph Flow slash commands — opencode adapter.
 *
 * The command templates are ports of the Claude Code plugin's user-invocable
 * skills (skills/ralphflow-&lt;name&gt;/SKILL.md); the underlying tools share the exact
 * MCP tool names (ralphflow_start, ralphflow_continue, …) so the texts stay
 * word-for-word portable. Path references use .opencode/ralph-flow/.
 */

export interface RalphCommandDef {
  description: string;
  template: string;
}

export const RALPH_COMMANDS: Record<string, RalphCommandDef> = {
  "ralphflow-start": {
    description: "Start a ralph-flow workflow",
    template: `Start a Ralph Flow workflow execution.

User input: $ARGUMENTS

User needs to specify both the workflow name and task description. If information is incomplete, ask the user:

- Only task, no workflow → ask which workflow to use
- Only workflow, no task → ask what to do
- Neither → ask for both

Do NOT guess which workflow to use - let the user choose.

Available workflows: use \`ralphflow_list\` tool to see.

Once information is complete, call the \`ralphflow_start\` tool to start the workflow.

**extra_dirs**: If the task's source material lives OUTSIDE the current project directory (e.g. migrating \`~/some-c-lib\` into this project), pass those directories in the optional \`extra_dirs\` parameter — the independent CHECK verifier works from the project directory and must be able to read the source material it verifies against. Each directory is validated at start; a nonexistent path refuses the start immediately. Do not guess: only pass paths the user actually mentioned.

Each start creates a new **workflow instance** (the response carries its instance id). One session runs at most one instance; multiple sessions in the same project can each run their own instance in parallel. If the tool says this session already has an active instance, finish or cancel it first.

## Workflow Mechanism

Each workflow step has two phases:

**DO Phase** (execution):
- Execute the current step's task based on the prompt you receive
- Complete the actual work (write code, create files, run commands)
- When all task requirements are met, output \`<promise>done</promise>\` on the **last line** of your response
- For **normal steps**, that's it — the system **automatically** runs the independent CHECK when you go idle. You do NOT call any tool.
- For **manual steps**, the system stops the session and asks the USER to review — only the user's /ralphflow-continue starts the verification.

**CHECK Phase** (verification, automatic for normal steps):
- After your done tag, an independent verifier session verifies your work against the step's check criteria (you'll see a "🔍 CHECK 阶段" message, then a "检查结果：通过/未通过" message).
- If it passes, the workflow advances to the next step automatically and injects the next DO prompt.
- If it fails, you receive the failure reason and re-do the step.

**Important**: You MUST output \`<promise>done</promise>\` when done, on its own last line. Do NOT call \`ralphflow_continue\` for normal steps — verification is automatic. \`ralphflow_continue\` is only for: approving a manual review, resuming a paused workflow, or attaching to an interrupted instance.

## Pause and Resume

**Max failures reached**: If a step fails verification too many times (exceeds \`max_fail_count\`), the workflow pauses. You must:
1. Check the failure reason with \`/ralphflow-status\`
2. Fix the issues manually
3. Call \`ralphflow_continue\` to resume (this resets the failure counter and retries)

**Manual steps**: Steps listed in the workflow's \`manual_step\` pause **after the DO phase completes and before verification**. The session stops with a 📋 message so the user can review. Wait for the user; their \`/ralphflow-continue\` starts the independent verification. If the user asks for changes, make them and output \`<promise>done</promise>\` again — the review gate re-arms.

## After Starting

Once the workflow starts, execute the DO prompt you receive. Complete the actual work (write code, create files, run commands), then output \`<promise>done</promise>\` on the last line when done.

## Phase Reporting

The system will automatically notify you of phase transitions via injected messages. When you receive these notifications, acknowledge them briefly to keep the user informed:

- **DO Phase**: Mention what you're working on (e.g., "I'm now in the DO phase, working on [task]")
- **CHECK Phase**: Let the user know verification is running (e.g., "CHECK phase started, waiting for verification")
- **Step Complete**: Confirm when done tag is detected (e.g., "Step complete, transitioning to CHECK")

This helps users track workflow progress without needing to manually check status.`,
  },

  "ralphflow-continue": {
    description: "Approve a manual review / signal step done / resume or attach to a ralph-flow workflow",
    template: `Call the \`ralphflow_continue\` tool. It covers four situations:

User input: $ARGUMENTS

**Normal steps are automatic**: after your \`<promise>done</promise>\` tag, the system runs the independent verification and advances on its own — you do NOT call this tool. \`ralphflow_continue\` is only for the three cases below.

**Manual review approval**: When the user runs this command after a 📋 manual-step review, calling \`ralphflow_continue\` is their approval — it starts the independent verification. (Never call it on your own initiative during a manual review.)

**Paused workflow**: If the workflow was paused due to max failures:
1. Review the failure reason shown in \`/ralphflow-status\`
2. Fix the issues that caused the failure
3. Call \`ralphflow_continue\` — it resets the fail counter and retries the step

**Attach to an interrupted instance (new session)**: If the user provided an instance id with this command, pass it as the \`instance\` argument (unique prefix allowed). Without an id:
- a single instance in the project → auto-attached
- multiple instances exist → the tool returns an instance list; show it to the user and ask which one to attach, then call again with \`instance\`
- attaching to an instance that was interrupted mid-DO returns the DO prompt — continue executing that task; if it was interrupted after done, verification starts directly

## Phase Reporting

After calling \`ralphflow_continue\`, the system will notify you of the next phase. Briefly acknowledge this to keep the user informed:

- If moving to DO phase: "Advanced to step [X], now in DO phase"
- If in CHECK phase: "Verification running for step [X]"
- If workflow completed: "All steps complete, workflow finished"
- If paused: Explain why and what needs to happen next`,
  },

  "ralphflow-status": {
    description: "Show ralph-flow workflow status (this session's instance or all instances)",
    template: `Show Ralph Flow workflow status.

User input: $ARGUMENTS

Call the \`ralphflow_status\` tool:
- Without arguments it shows this session's instance, or an overview of ALL active instances in the project when this session has none (id, workflow, step, state, owner session, last activity).
- If the user names an instance, pass it as the \`instance\` argument (unique prefix allowed) to inspect that instance.

Displayed per instance:
- Workflow name, current step and phase (do/check)
- State: running / verifying / waiting for manual review / paused (with reason)
- Failure count and last failure reason (if any)
- Owner session — an instance owned by another (or a since-closed) session can be taken over via \`ralphflow_continue\``,
  },

  "ralphflow-list": {
    description: "List available ralph-flow workflows and active instances",
    template: `List all available Ralph Flow workflows and active workflow instances.

Call the \`ralphflow_list\` tool to show:
- All workflow names with a brief description of each
- All active workflow instances in this project (id, workflow, step, state, owner session)

Workflows are resolved in order (a same-named workflow at an earlier tier shadows the later ones):
1. Project custom (.opencode/ralph-flow/workflows/) — this project only
2. Global custom (~/.config/opencode/ralph-flow/workflows/) — all projects, survives plugin updates
3. Plugin built-in (bundled with the plugin)`,
  },

  "ralphflow-cancel": {
    description: "Cancel a ralph-flow workflow instance",
    template: `Cancel a Ralph Flow workflow instance.

User input: $ARGUMENTS

Call the \`ralphflow_cancel\` tool to properly cancel the workflow: it aborts any running verification session, archives the final report to \`.opencode/ralph-flow/reports/\`, and removes the instance directory (including the sub-workflow state stack).

- Without arguments it cancels this session's instance (or the single instance in the project).
- To cancel a specific instance (e.g. one owned by another/closed session), pass the \`instance\` argument (unique prefix allowed). If the tool returns an instance list instead, show it to the user and confirm which one to cancel.

Do NOT manually delete files — use the tool to ensure proper cleanup.`,
  },

  "ralphflow-doctor": {
    description: "Diagnose ralph-flow workflow definitions and instance state, explain problems, and offer fixes",
    template: `Diagnose the health of all Ralph Flow workflow definitions (project custom + plugin built-in) and instance state.

## Procedure

1. Call the \`ralphflow_doctor\` tool. It is read-only and returns a full diagnosis report:
   - Per-workflow verdict (launchable / broken) with the **complete** list of validation problems, not just the first one
   - Warnings on launchable workflows: silently skipped steps, unreachable steps, unresolvable \`{{...}}\` tokens, broken sub-workflow references, sub-workflow cycles, clamped \`adversarial_check\` fields
   - Shadowing: which file actually runs when project and plugin define the same name, and when an invalid project file silently falls back to a built-in
   - YAML files ignored because they aren't workflow-shaped
   - Instance directories with missing/corrupt state.json

2. Present the report to the user. For each problem, explain the root cause in plain language and what its consequence is (e.g. "this step was silently dropped — the workflow runs, but without it").

3. **Offer to fix.** If the user agrees (or asked for fixes up front), edit the offending YAML files directly, then call \`ralphflow_doctor\` again to confirm the report is clean. Repeat until no problems remain. Never edit plugin built-in workflow files — if a built-in needs different behavior, copy it into \`.opencode/ralph-flow/workflows/\` and edit the copy (it shadows the built-in by name).

## Common problems → fixes

| Symptom in report | Fix |
|---|---|
| missing/invalid \`input\` / \`output\` / \`do\` / \`check\` / \`desc\` / \`on_pass\` / \`on_fail\` / \`max_fail_count\` | Add the missing field to that step. Every non-sub-workflow step needs all of: \`id\`, \`desc\`, \`do\`, \`check\`, \`input\`, \`output\`, \`on_pass\`, \`on_fail\`, \`max_fail_count\` (number ≥ 1) |
| step skipped silently | Same as above — the step is missing a required field; the rest of the workflow still validated, so it runs WITHOUT this step |
| \`on_pass\`/\`on_fail\` references unknown step | Fix the typo, or use \`done\` (valid for \`on_pass\` only, marks workflow completion) |
| \`manual_step\` references unknown step | Fix the step id in the top-level \`manual_step\` list (hard error by design: a typo'd review gate must never run gateless) |
| unreachable step | Wire it into the graph via some step's \`on_pass\`/\`on_fail\`, or delete it. Execution starts at the FIRST element of \`steps\` |
| no reachable step has \`on_pass: done\` | Point the final step's \`on_pass\` at \`done\` |
| unresolvable template token | Remove it. The engine resolves exactly one token, \`{{artifacts_dir}}\` (no spaces inside braces), and normally you don't need even that — every DO/CHECK prompt automatically carries a 产出目录 section |
| sub-workflow won't load | Fix the \`workflow:\` name or create the referenced workflow file |
| sub-workflow cycle | Break the cycle; nesting is capped at depth 5 and errors at runtime |
| invalid project file falling back to a built-in | Fix the project file — right now starting that name runs the BUILT-IN, not the user's version |
| corrupt instance state.json | The instance is unrecoverable; after the user confirms it's not needed, delete \`.opencode/ralph-flow/instances/<id>/\` |

To create a brand-new workflow instead of fixing one, suggest \`/ralphflow-create\`.`,
  },

  "ralphflow-create": {
    description: "Interactively design and create a custom ralph-flow workflow, validated and ready to run",
    template: `Interactively design a custom Ralph Flow workflow with the user, write it to \`.opencode/ralph-flow/workflows/<name>.yaml\`, and validate it with the \`ralphflow_doctor\` tool until it is clean and launchable.

User input: $ARGUMENTS

## Procedure

1. **Understand the process to automate.** Ask the user (in one round, don't interrogate):
   - What repeating process should the workflow run? What are its phases?
   - Where do they want a human review gate (workflow stops for their approval before verification)?
   - Should any phase reuse an existing workflow as a sub-workflow? (\`ralphflow_list\` shows what exists.)
   If the user already described all this, skip the questions and design directly.

2. **Design the step graph and present it** as a compact overview (step id → what it does → on_pass/on_fail targets) before writing the file. Adjust per feedback.

3. **Write the YAML** (kebab-case name). Ask the user for the scope, or default to project:
   - project-only → \`.opencode/ralph-flow/workflows/<name>.yaml\`
   - available in all projects → \`~/.config/opencode/ralph-flow/workflows/<name>.yaml\` (global; survives plugin updates)

   Create the directory if needed. If the name matches a built-in (\`loop\`, \`spec\`), tell the user it will shadow the built-in and confirm that's intended.

4. **Validate**: call the \`ralphflow_doctor\` tool and check the new workflow's section. Fix every problem AND warning it reports for this workflow, re-run doctor, repeat until its verdict is "可启动" with no warnings.

5. **Hand off**: show the user the final step overview and tell them how to run it: \`/ralphflow-start\` with workflow \`<name>\` and their task description.

## YAML schema (exact — the engine validates all of this)

\`\`\`yaml
description: One-line description shown in ralphflow_list   # optional but recommended

manual_step:            # optional: step ids that pause for HUMAN review after DO, before verification
  - design

adversarial_check:      # optional: config for the independent CHECK session
  agent: ralph-check    # optional: opencode agent used by the verifier (default ralph-check, read-only)
  model:                # optional: verifier model; object form or "provider/model" string
    providerID: anthropic
    modelID: claude-sonnet-4-5
  timeout_ms: 3600000   # capped at 3600000 (1 hour)
  # system_prompt: ...  # optional extra system prompt for the checker
\`\`\`

\`\`\`yaml
steps:                  # required, non-empty; execution starts at the FIRST element
  - id: step-id         # required, unique string
    desc: 一句话说明     # required
    do: |               # required (unless this is a sub-workflow step)
      DO-phase instructions executed by the working session.
    check: |            # required (unless sub-workflow step)
      CHECK-phase instructions executed by an INDEPENDENT verifier session.
    input: 上一步的产物或用户输入   # required: what this step consumes
    output: "result.md"            # required: what this step must produce
    on_pass: next-step-id          # required: step id, or "done" to finish the workflow
    on_fail: step-id               # required: step id to retry/fall back to ("done" NOT allowed)
    max_fail_count: 3              # required, number ≥ 1: pauses for the user after this many CHECK failures

  - id: delegate        # sub-workflow step: replaces do/check with:
    workflow: loop      # name of another workflow (nesting capped at depth 5, no cycles)
    desc: ...
    input: ...
    output: ...
    on_pass: done
    on_fail: delegate
    max_fail_count: 3
\`\`\`

Hard rules the engine enforces (violations make the file unlaunchable or silently drop steps):

- Every field above marked required is required **per step** — a step missing one is **silently skipped** while the rest of the workflow still runs. Never omit \`input\`/\`output\`.
- \`on_pass\`/\`on_fail\` must reference an existing step id (\`done\` valid only for \`on_pass\`).
- \`manual_step\` entries must match existing step ids — a typo is a hard error by design.
- **No template variables.** The engine resolves nothing except the internal \`{{artifacts_dir}}\` escape hatch, and you don't need it: every DO/CHECK prompt automatically carries a 产出目录 (artifacts directory) section. Write bare filenames in \`output\` (e.g. \`"plan.md"\`); the session knows to put them in the artifacts dir.

## Design best practices (apply these unless the user objects)

- **\`do\` must demand real work**, not analysis: create files, run commands, produce the named output. The session ends DO by emitting \`<promise>done</promise>\`.
- **\`check\` is executed by an independent session that saw none of the DO conversation.** Write it as a self-contained verification recipe: which files to open, which commands to run, and concrete pass/fail criteria. Vague criteria ("代码质量好") make CHECK useless.
- **Checkpoint-list pattern** for open-ended tasks: first step decomposes the request into a \`checkpoints.md\` of objectively verifiable items each annotated with its verification method; later steps execute and tick them; their \`check\` re-verifies each item independently instead of trusting the ticks.
- **Light persona nudge in \`check\`** sharpens verification, e.g. opening with 「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」 Keep it one line — no heavyweight role setups.
- **Retry loops**: \`on_fail\` usually points at the step itself; point it at an earlier step only when a failure genuinely invalidates earlier output. \`max_fail_count\` 3–5 for bounded steps, large (e.g. 100) for grind-until-green loops.
- **Manual gates** where a wrong direction is expensive (plans, designs, destructive actions) — list those step ids in \`manual_step\`.
- **Language**: write \`do\`/\`check\` prose in the user's language.`,
  },
};
