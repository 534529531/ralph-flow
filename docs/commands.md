# Commands Reference

[English](commands.md) · [中文](commands_CN.md)

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ralphflow-start` | Start a workflow. Needs a workflow name AND a task description; asks for whichever is missing. |
| `/ralphflow-continue` | Four uses: signal DO completion (when prompted), approve a manual review, resume a paused workflow, attach to an interrupted instance (optionally pass an instance id, unique prefix allowed). |
| `/ralphflow-status` | Show this session's instance, a named instance, or an overview of all active instances. |
| `/ralphflow-list` | List available workflows (project + built-in) and active instances. |
| `/ralphflow-cancel` | Cancel an instance: aborts a running verification, archives the final report, removes the instance dir. |
| `/ralphflow-doctor` | Diagnose all workflow definitions and instance state; offers to fix problems. |
| `/ralphflow-create` | Interactively design a custom workflow, write the YAML, and validate it with the doctor until clean. |

## Tools (called by the model)

| Tool | Arguments | Description |
|------|-----------|-------------|
| `ralphflow_start` | `workflow`, `task`, `extra_dirs?` | Creates and binds a new workflow instance. `extra_dirs`: directories outside the project the verifier must read (validated at start). |
| `ralphflow_continue` | `instance?` | DO-complete signal → runs the independent CHECK and advances; also resumes paused instances and attaches to interrupted ones. |
| `ralphflow_cancel` | `instance?` | Cancel an instance (report archived first). |
| `ralphflow_status` | `instance?` | Detailed status of one instance, or an overview of all. |
| `ralphflow_list` | — | Available workflows + active instances. |
| `ralphflow_doctor` | — | Read-only full diagnosis report. |

## Instance model

- Every `ralphflow_start` creates an instance under `.opencode/ralph-flow/instances/<id>/`.
- One session drives at most one instance; parallel sessions in the same project each drive their own.
- Ownership is recorded in the instance's `owner-session` file. When the owning session is gone (opencode restarted), any session's `/ralphflow-continue` can take the instance over — automatically when it's the only one, by explicit `instance` id otherwise.
- Attaching to an instance interrupted mid-DO re-issues the DO prompt; interrupted after the done tag goes straight to verification.

## Instance directory contents

| File | Purpose |
|------|---------|
| `state.json` | Workflow state (step, phase, fail count, pause reason) |
| `state-stack.json` | Sub-workflow nesting stack |
| `owner-session` | Driving session id |
| `artifacts-dir` | Name of the instance's artifacts directory |
| `.manual-step-active` / `.manual-gate` | Manual review gate markers |
| `.done-tag-detected` | DO finished, awaiting `ralphflow_continue` |
| `.do-prompt-cache` | Current DO prompt (re-injected by keep-alives) |
| `.adversarial-session` | Id of the running verifier session |
| `logs/execution.log` | JSON-lines event log (rotated at 10 MB) |
| `logs/step-records.json` | Per-step execution records feeding the final report |

Outside the instance dir:

- `.opencode/ralph-flow/artifacts/<task>-<suffix>/` — deliverables, survive completion
- `.opencode/ralph-flow/reports/<id>-final-report.md` — archived final reports
- `.opencode/ralph-flow/workflows/` — project custom workflows (shadow built-ins by name)

## Log events

Notable `execution.log` events: `workflow_start`, `step_start`, `done_detected`, `adversarial_check_start/response/result/timeout`, `fail_count_increment`, `workflow_paused`, `workflow_resumed`, `sub_workflow_end`, `workflow_end`, `workflow_cancelled`, `crash_recovery`, `legacy_instance_migrated`.
