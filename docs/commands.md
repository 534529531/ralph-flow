# Commands Reference

[English](commands.md) · [中文](commands_CN.md)

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ralphflow-start` | Start a workflow (needs a workflow name and a task description) |
| `/ralphflow-continue` | Approve a manual review · signal DO done · resume a paused workflow · attach to an interrupted instance |
| `/ralphflow-status` | Show this session's instance, a named instance, or all instances |
| `/ralphflow-list` | List available workflows and active instances |
| `/ralphflow-cancel` | Cancel an instance (archives the report first) |
| `/ralphflow-doctor` | Diagnose all workflow definitions and instance state |
| `/ralphflow-create` | Interactively design a custom workflow, validated until clean |

### Usage Examples

```
# Start interactively (asks for workflow + task)
/ralphflow-start

# Start a specific workflow
/ralphflow-start loop "Build user authentication"

# Task source outside the project — the verifier needs read access
/ralphflow-start spec "Refactor the module in ~/legacy" extra_dirs=~/legacy

# Check status (this session, or all instances)
/ralphflow-status

# Resume after a pause, approve a manual review, or attach to an interrupted instance
/ralphflow-continue
/ralphflow-continue loop-260710-ab12     # attach to a specific instance (unique prefix OK)

# Cancel and archive the report
/ralphflow-cancel

# List workflows + active instances
/ralphflow-list

# Diagnose every workflow definition
/ralphflow-doctor
```

### Tools (called by the model)

The slash commands drive these underscore-named tools; the model may also call them directly.

| Tool | Arguments | Description |
|------|-----------|-------------|
| `ralphflow_start` | `workflow`, `task`, `extra_dirs?` | Create and bind a new instance |
| `ralphflow_continue` | `instance?` | DO-done → run CHECK & advance; also resume/attach |
| `ralphflow_cancel` | `instance?` | Cancel an instance |
| `ralphflow_status` | `instance?` | One instance's detail, or an overview |
| `ralphflow_list` | — | Workflows + instances |
| `ralphflow_doctor` | — | Read-only diagnosis report |

---

## Instance Model

- Every `ralphflow_start` creates an instance under `.opencode/ralph-flow/instances/<id>/`.
- One session drives at most one instance; parallel sessions in the same project each drive their own.
- Ownership is the `session_id` stored in the instance's `state.json`. Any session's `/ralphflow-continue` can take an instance over — automatically when it's the only one in the project, by explicit `instance` id (unique prefix allowed) otherwise. (There is no session-liveness probe; ownership is advisory.)
- Attaching to an instance interrupted mid-DO re-issues the DO prompt; interrupted after the done tag goes straight to verification.

---

## Log Events

Per-instance events are logged to `.opencode/ralph-flow/instances/<id>/logs/execution.log` in JSON Lines format (rotated at 10 MB).

### Workflow Events

| Event | Description |
|-------|-------------|
| `workflow_start` | Workflow started |
| `workflow_end` | Workflow completed |
| `workflow_paused` | Paused (max failures / config error / check infra error) |
| `workflow_resumed` | Resumed by the user |
| `workflow_cancelled` | Cancelled by the user |
| `legacy_instance_migrated` | A pre-2.0 workflow was migrated into the instances layout |

### Step Events

| Event | Description |
|-------|-------------|
| `step_start` | A step phase started |
| `done_detected` | `<promise>done</promise>` detected |
| `adversarial_check_start` / `_result` / `_timeout` | Independent verification lifecycle |
| `fail_count_increment` | A step's failure count increased |
| `sub_workflow_end` | A sub-workflow completed |
| `crash_recovery` | State was stuck in check phase and reset to DO |

### Log Format

Each line is a JSON object with common fields:

```json
{
  "ts": "2026-07-10T10:30:01.000Z",
  "level": "info",
  "event": "step_start",
  "step": "loop",
  "phase": "do"
}
```

### Reading Logs

```bash
# One instance's log (replace <id>)
cat .opencode/ralph-flow/instances/<id>/logs/execution.log

# Filter by event type across an instance
grep '"event":"adversarial_check_result"' .opencode/ralph-flow/instances/<id>/logs/execution.log

# Last 10 events
tail -10 .opencode/ralph-flow/instances/<id>/logs/execution.log
```

---

## Final Report

When a workflow completes or is cancelled, a summary report is archived to
`.opencode/ralph-flow/reports/<id>-final-report.md`.

The report includes:
- Workflow name, final status, and total duration
- Every step's phase, pass/fail, retry count, failure reason, and duration
- A pointer to the artifacts directory if it holds deliverables

---

## Instance Directory Contents

| File | Purpose |
|------|---------|
| `state.json` | Workflow state (step, phase, fail count, pause reason) |
| `state-stack.json` | Sub-workflow nesting stack |

| `artifacts-dir` | Name of this instance's artifacts directory |
| `.manual-step-active` / `.manual-gate` | Manual review gate markers |
| `.done-tag-detected` | DO finished, awaiting `ralphflow_continue` |
| `.do-prompt-cache` | Current DO prompt (re-injected by keep-alives) |
| `.adversarial-session` | Id of the running verifier session |
| `logs/execution.log` | JSON-lines event log |
| `logs/step-records.json` | Per-step records feeding the final report |
