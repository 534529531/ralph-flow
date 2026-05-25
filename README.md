<div align="center">

# ralph-flow

**Workflow automation plugin for [opencode](https://opencode.ai)**

Automatically execute multi-step workflows with do/check phases, turning complex tasks into automated pipelines.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-green.svg)](https://opencode.ai)

[English](README.md) | [中文](README_CN.md)

</div>

---

## Features

- **Multi-step Workflows** - Define complex workflows with sequential steps
- **Do/Check Phases** - Each step has execution and verification phases
- **Auto-retry** - Automatically retry failed steps with configurable limits
- **Manual Control** - Pause for manual intervention when needed
- **YAML Definition** - Simple, human-readable workflow definitions
- **Execution Logs** - Detailed logging for debugging and auditing

## Installation

### Option 1: npm

Add to your opencode config:

```json
{
  "plugin": ["@yibener/ralph-flow"]
}
```

### Option 2: Local Plugin

Clone this repository to your opencode plugins directory:

```bash
git clone https://github.com/534529531/ralph-flow.git ~/.config/opencode/plugins/ralph-flow
```

Run `npm run build` in that folder:

```bash
cd ~/.config/opencode/plugins/ralph-flow
npm run build
```

Then create a **ralph-flow.ts** file in your plugins directory with the following content:

```ts
export { RalphFlow } from "./ralph-flow/dist/index.js";
```

## Quick Start

### 1. Start a workflow

```
/ralphflow-start
```

Or specify workflow and task directly:

```
/ralphflow-start loop "Build a REST API with authentication"
```

### 2. Check workflow status

```
/ralphflow-status
```

### 3. Continue a paused workflow

```
/ralphflow-continue
```

### 4. Cancel a workflow

```
/ralphflow-cancel
```

### 5. List available workflows

```
/ralphflow-list
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      Workflow Start                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step: DO Phase                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ AI executes task                                      │  │
│  │ Outputs: <promise>done</promise>                      │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Step: CHECK Phase                                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ AI verifies work                                      │  │
│  │ Outputs: <promise-check>true/false</promise-check>    │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
        ┌─────────┐                     ┌─────────┐
        │  PASS   │                     │  FAIL   │
        └─────────┘                     └─────────┘
              │                               │
              ▼                               ▼
    ┌─────────────────┐            ┌─────────────────────┐
    │  on_pass step   │            │  fail_count++       │
    │  (or complete)  │            │  on_fail step       │
    └─────────────────┘            └─────────────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │  Reached max_fail_count? │
                                  └─────────────────────────┘
                                           │
                                 ┌─────────┴─────────┐
                                 ▼                   ▼
                           ┌─────────┐         ┌─────────┐
                           │   No    │         │   Yes   │
                           └─────────┘         └─────────┘
                                 │                   │
                                 ▼                   ▼
                           ┌─────────┐         ┌─────────┐
                           │ Continue│         │  Pause  │
                           │  flow   │         │ (manual)│
                           └─────────┘         └─────────┘
```

1. `/ralphflow-start` initializes a workflow
2. Plugin injects the first step's **do phase** prompt
3. AI works on the task and outputs `<promise>done</promise>` when complete
4. Plugin detects the completion tag and transitions to the **check phase**
5. AI verifies the work and outputs `<promise-check>true</promise-check>` or `<promise-check>false</promise-check>`
6. Based on the result:
   - **Pass**: Move to `on_pass` step (or complete workflow if `on_pass: done`)
   - **Fail**: Increment `fail_count`, move to `on_fail` step (with failure context)
7. If `fail_count` reaches `max_fail_count`, the workflow **pauses** for manual intervention
8. Use `/ralphflow-continue` to reset `fail_count` and resume
9. Workflow completes when the final step's check passes

## Workflow Definition

Create YAML files in `.opencode/workflows/`. The default workflow `loop.yaml` is a single-step auto-loop:

```yaml
manual_phase:

steps:
    - id: loop
      desc: Auto-loop task execution
      do: Execute the user-defined task and keep working until complete
      input: User's task description
      output: Proof of completion (code, files, test results)
      check: Strict review mode with independent audit and tool verification
      on_pass: done
      on_fail: loop
      max_fail_count: 100
```

For multi-step workflows, define multiple steps:

```yaml
manual_phase: analyze.do, execute.check

steps:
  - id: analyze
    desc: Task Analysis
    do: Analyze user requirements and create design documents
    input: User requirements description
    output: design.md, task.md
    check: Verify design documents are clear and complete
    on_pass: execute
    on_fail: analyze
    max_fail_count: 5

  - id: execute
    desc: Code Development
    do: Implement code based on design documents
    input: design.md and task.md
    output: Development summary report
    check: Verify code implementation matches design
    on_pass: done
    on_fail: problem_fix
    max_fail_count: 5

  - id: problem_fix
    desc: Problem Fix
    do: Analyze and fix issues from failed checks
    input: Failure report
    output: Fix summary report
    check: Run unit tests to verify fixes
    on_pass: execute
    on_fail: problem_fix
    max_fail_count: 5
```

### Step Fields

| Field            | Type   | Required | Description                             |
| ---------------- | ------ | -------- | --------------------------------------- |
| `id`             | string | ✅        | Unique step identifier                  |
| `desc`           | string | ✅        | Human-readable step description         |
| `do`             | string | ✅        | Task execution prompt                   |
| `input`          | string | ✅        | Expected input description              |
| `output`         | string | ✅        | Expected output description             |
| `check`          | string | ✅        | Verification criteria                   |
| `on_pass`        | string | ✅        | Next step on pass (step id or `"done"`) |
| `on_fail`        | string | ✅        | Next step on fail (step id)             |
| `max_fail_count` | number | ✅        | Max failures before pausing             |

### Completion Tags

| Phase | Tag                                    | Description         |
| ----- | -------------------------------------- | ------------------- |
| Do    | `<promise>done</promise>`              | Task completed      |
| Check | `<promise-check>true</promise-check>`  | Verification passed |
| Check | `<promise-check>false</promise-check>` | Verification failed |

> **Note**: Tags are case-insensitive and allow whitespace. `<promise>DONE</promise>` is valid.

### Manual Phase

Specify phases that require manual continuation:

```yaml
manual_phase: analyze.do, execute.check
```

Phases in this list will **not** auto-continue when the session is idle.

## Project Structure

All generated files are consolidated under `.opencode/ralph-flow/`:

```
.opencode/
└── ralph-flow/            # All plugin files
    ├── ralph-flow.local.md    # Workflow state file
    ├── workflows/             # Workflow definitions
    │   └── *.yaml
    ├── logs/                  # Execution logs
    │   ├── execution.log      # Main execution log (JSON Lines)
    │   ├── step-*.log         # Per-step logs (JSON Lines)
    │   └── final-report.md    # Workflow completion report
    └── package.json           # Dependencies
```

## Configuration

### State File

Workflow state is stored in `.opencode/ralph-flow/ralph-flow.local.md`:

```markdown
---
active: true
workflow_name: loop
current_step: loop
current_phase: do
fail_count: 0
user_task: Build a REST API with authentication
---
```

### Logs

Logs are stored in `.opencode/ralph-flow/logs/` in JSON Lines format:

```json
{"ts":"2026-05-25T10:30:00.000Z","level":"info","event":"workflow_start","workflow":"loop"}
{"ts":"2026-05-25T10:30:05.000Z","level":"info","event":"step_start","step":"loop","phase":"do"}
{"ts":"2026-05-25T10:35:00.000Z","level":"info","event":"done_detected","step":"loop","phase":"do"}
{"ts":"2026-05-25T10:35:10.000Z","level":"info","event":"check_result","step":"loop","phase":"check","passed":true}
```

#### Log Event Types

| Event                  | Description                            |
| ---------------------- | -------------------------------------- |
| `workflow_start`       | Workflow started                       |
| `workflow_end`         | Workflow completed                     |
| `step_start`           | Step phase started                     |
| `done_detected`        | Done tag detected                      |
| `check_result`         | Check result received                  |
| `fail_count_increment` | Failure count increased                |
| `workflow_paused`      | Workflow paused (max failures reached) |
| `workflow_resumed`     | Workflow resumed by user               |
| `workflow_cancelled`   | Workflow cancelled by user             |

### Final Report

When a workflow completes or is cancelled, a report is generated in `.opencode/ralph-flow/logs/final-report.md`:

```markdown
# Workflow Execution Report

## Summary

- **Workflow**: loop
- **Status**: completed
- **Total Steps**: 3
- **Total Failures**: 1
- **Duration**: 25m

## Step Details

### 1. loop (do) ✓
- Status: passed
- Duration: 5m

### 2. loop (check) ✓
- Status: passed
- Duration: 5m

## Suggestions

(Generated by LLM)
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<div align="center">

**[⬆ Back to top](#ralph-flow)**

</div>
