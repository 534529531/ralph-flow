<div align="center">

# ralph-flow

**Workflow automation plugin for [opencode](https://opencode.ai)**

Make AI actually follow complex workflows — execute, verify, retry until done.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-green.svg)](https://opencode.ai)

[English](README.md) · [中文](README_CN.md)

</div>

---

## The Problem

You tell an AI: "Implement user auth, write tests, update docs, and make sure all tests pass."

What actually happens:
- AI writes some code and stops
- Tests are never run
- Docs are forgotten
- No verification that anything actually works

**Even when you ask AI to verify itself, it fails:**
- The AI is both player and referee — it lowers the bar for its own work
- It's overconfident — "looks good to me" without actually checking
- It blames external factors — "the test environment is broken", "existing code has issues"

**AI doesn't follow multi-step workflows.** It loses context, skips steps, and never truly verifies its own work.

## The Solution

ralph-flow forces AI to follow structured workflows with **independent verification at every step**. It's not just prompt engineering — it's a state machine that won't let the AI skip steps or claim "done" without proof.

Every step runs in two phases:

1. **DO** — the working session executes the step's task and ends with a `<promise>done</promise>` tag
2. **CHECK** — an **independent verifier session** (read-only `ralph-check` agent, fresh context, saw none of the DO conversation) re-verifies the work against the step's check criteria

Pass → next step. Fail → retry with the concrete failure reason. Too many failures → pause for the human.

---

## Features

- **Multi-instance**: every opencode session can run its own workflow instance in the same project, in parallel, fully isolated (`.opencode/ralph-flow/instances/<id>/`)
- **Independent verification**: CHECK runs in a separate session with a read-only agent — the AI never grades its own homework
- **Manual review gates**: steps listed in `manual_step` stop the session *after DO, before verification* so a human reviews first; only the user's `/ralphflow-continue` approves
- **Failure-aware retries**: the retry DO prompt carries the verifier's exact failure reason; `max_fail_count` bounds the loop, then pauses for the user
- **Sub-workflows**: steps can delegate to another workflow (nesting capped at 5, cycles detected by the doctor)
- **Artifacts directory**: every instance gets an isolated deliverables dir (`.opencode/ralph-flow/artifacts/<task>-<id>/`) that survives workflow completion
- **Session takeover**: closed opencode mid-workflow? A new session's `/ralphflow-continue` attaches to the interrupted instance and resumes exactly where it stopped
- **Doctor**: `/ralphflow-doctor` diagnoses every workflow definition — silently skipped steps, unreachable steps, broken sub-workflow refs, cycles, shadowing, corrupt instances
- **Create wizard**: `/ralphflow-create` designs a custom workflow with you, writes the YAML and validates it until clean
- **Final reports**: completed/cancelled instances archive an execution report to `.opencode/ralph-flow/reports/`

---

## Installation

```bash
cd ~/.config/opencode/plugins
git clone https://github.com/yibener/ralph-flow.git
cd ralph-flow
npm install && npm run build
```

Restart opencode. The plugin registers its tools, slash commands, the `ralph-check` agent, and syncs its bundled skills into the project on first use.

### Upgrading from 1.x

Just pull and rebuild. On first startup 2.0 automatically:
- migrates an interrupted 1.x workflow (`ralph-flow.local.md`) into the new multi-instance layout — attach to it with `/ralphflow-continue`
- parks the workflow copies the 1.x setup used to write into `.opencode/ralph-flow/workflows/` as `*.pre-2.0-backup` (built-ins now always resolve from the plugin, so they never go stale)

Note: tool names changed from `ralphflow-start` style to `ralphflow_start` (matching the slash commands stays `/ralphflow-start`).

---

## Quick Start

```
/ralphflow-start loop 帮我把这个模块的测试覆盖率提到 90%
```

Then let it run. The workflow will:
1. Decompose your request into a verifiable checkpoint list (`checkpoints.md`)
2. Execute until every checkpoint passes
3. Independently verify each step before advancing

Watch progress with `/ralphflow-status`, cancel with `/ralphflow-cancel`.

## Slash Commands

| Command | What it does |
|---|---|
| `/ralphflow-start` | Start a workflow (asks for workflow + task if not given) |
| `/ralphflow-continue` | Approve a manual review / resume a paused workflow / attach to an interrupted instance |
| `/ralphflow-status` | Show this session's instance, or all instances in the project |
| `/ralphflow-list` | List available workflows and active instances |
| `/ralphflow-cancel` | Cancel an instance (archives its report first) |
| `/ralphflow-doctor` | Diagnose all workflow definitions and instance state |
| `/ralphflow-create` | Interactively design a custom workflow, validated until clean |

## Built-in Workflows

| Workflow | Purpose |
|---|---|
| `loop` | Checkpoint-driven loop: decompose the request into a verifiable checkpoint list, then grind until every checkpoint passes |
| `spec` | Spec-driven development: requirements → design (manual review gate) → implementation → verification |
| `c-to-rust` | Migrate a C project to idiomatic safe Rust: analyze → TDD baseline → implement core → audit → implement full → audit → verify |
| `everything2rust` | Rewrite a system in ANY language to Rust: survey → behavior spec + golden corpus → design (ADRs) → TDD baseline → implement → audit → verify |

The `c-to-rust` and `everything2rust` workflows drive 12 bundled skills (auto-synced into `.opencode/skills/`) covering planning, test generation, implementation patterns, auditing and final validation.

---

## How It Works

```
/ralphflow-start
      │
      ▼
┌───────────┐   <promise>done</promise>   ┌──────────────────────┐
│  DO phase │ ──────────────────────────▶ │ manual step?          │
│ (your     │                             │  yes → 📋 STOP, wait  │
│  session) │ ◀── retry w/ fail reason ── │  for user review      │
└───────────┘                             └──────────┬───────────┘
      ▲                                              │ user /ralphflow-continue
      │ fail                                         ▼ (or auto for normal steps)
      │                                   ┌──────────────────────┐
      └────────────────────────────────── │ CHECK phase           │
                             pass ──────▶ │ independent read-only │──▶ next step / done
                                          │ verifier session      │
                                          └──────────────────────┘
```

- The session going idle without a done tag gets a keep-alive re-injection of its DO prompt (bounded — after 5 idle nudges the driver stops and hands control to you)
- Verification failures don't just retry blindly: the DO prompt carries the verifier's failure reason and the retry count
- Infrastructure failures during CHECK (API errors, timeouts) do **not** burn a failure count — the workflow pauses in check phase and `/ralphflow-continue` re-runs only the verification

See [SYNC.md](SYNC.md) for the architecture mapping to the Claude Code sibling plugin, and [docs/](docs/README.md) for details.

## Custom Workflows

Drop a YAML into `.opencode/ralph-flow/workflows/<name>.yaml` (shadows a same-named built-in), or better: run `/ralphflow-create` and let it design + validate the file with you.

```yaml
description: Build, test, and document a feature

manual_step: [design]        # human review gates (after DO, before CHECK)

steps:
  - id: design
    desc: Design the feature
    do: |
      Write a design document covering data model, API surface and error handling.
    check: |
      Open design.md; verify it covers data model, API surface, error handling.
    input: user requirements
    output: "design.md"
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: Implement per design
    do: |
      Implement the design. Run the full test suite until green.
    check: |
      你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。
      Run the test suite yourself; verify new code matches design.md.
    input: design.md
    output: working implementation
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

Every non-sub-workflow step **requires** `id`, `desc`, `do`, `check`, `input`, `output`, `on_pass`, `on_fail`, `max_fail_count` — a step missing one is *silently skipped* (run `/ralphflow-doctor` to catch this). Full schema: [docs/custom-workflows.md](docs/custom-workflows.md).

## Documentation

- [How it works](docs/how-it-works.md) — architecture, state machine, verification
- [Commands](docs/commands.md) — command & tool reference
- [Custom workflows](docs/custom-workflows.md) — full YAML schema and design guide
- [SYNC.md](SYNC.md) — structural mapping to the Claude Code sibling plugin

## License

MIT
