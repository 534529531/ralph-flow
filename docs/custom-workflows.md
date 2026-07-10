# Custom Workflows

[English](custom-workflows.md) · [中文](custom-workflows_CN.md)

Create your own workflow by placing a `.yaml` file in `.opencode/ralph-flow/workflows/`, or run `/ralphflow-create` to design and validate one interactively. A project workflow **shadows** a same-named built-in.

> After writing a workflow, run **`/ralphflow-doctor`**. It catches the traps below before they bite: a step missing a required field is **silently skipped** (the rest of the workflow still runs), unreachable steps never execute, a workflow with no path to `done` never finishes, and unresolvable `{{...}}` tokens reach the prompt verbatim.

---

## Quick Example

```yaml
description: Analyze then implement

steps:
  - id: analyze
    desc: Task analysis
    do: Analyze the requirements and produce a design document.
    input: User requirements
    output: "design.md"
    check: Open design.md; verify it is complete and technically sound.
    on_pass: execute
    on_fail: analyze
    max_fail_count: 3

  - id: execute
    desc: Implementation
    do: Implement the design. Run the tests until green.
    input: design.md
    output: Working code with passing tests
    check: Run the test suite yourself and verify the implementation matches design.md.
    on_pass: done
    on_fail: execute
    max_fail_count: 5
```

Execution starts at the **first** step. `on_pass: done` finishes the workflow.

---

## Step Fields Reference

### Normal Steps

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique step identifier |
| `desc` | ✅ | Human-readable description (shown in status) |
| `do` | ✅ | Task prompt — what the working session should do |
| `input` | ✅ | What this step consumes |
| `output` | ✅ | What this step must produce |
| `check` | ✅ | Verification recipe run by the independent session |
| `on_pass` | ✅ | Next step id on success, or `"done"` to finish |
| `on_fail` | ✅ | Step id to retry/fall back to (`"done"` NOT allowed) |
| `max_fail_count` | ✅ | Max CHECK failures before pausing (number ≥ 1, per step) |

> ⚠️ **Every field above is required, per step.** A step missing any one of them is **silently dropped** while the rest of the workflow still runs. Never omit `input`/`output`. `/ralphflow-doctor` reports every dropped step.

### Sub-Workflow Steps

Instead of `do`/`check`, a step can call another workflow:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique step identifier |
| `desc` | ✅ | Human-readable description |
| `workflow` | ✅ | Name of the workflow to invoke |
| `input` | ✅ | What this step consumes |
| `output` | ✅ | What this step must produce |
| `inputs` | ❌ | Key-value pairs merged into the sub-workflow's task |
| `on_pass` | ✅ | Next step id on success, or `"done"` |
| `on_fail` | ✅ | Step id to retry/fall back to |
| `max_fail_count` | ✅ | Max failures before pausing |

See [Nested Workflows](#nested-workflows) for details.

---

## Artifacts Directory & Template Variables

Every workflow instance gets an isolated deliverables directory —
`.opencode/ralph-flow/artifacts/<task>-<suffix>/` — that **survives** workflow completion. Every DO and CHECK prompt automatically carries a 产出目录 (artifacts directory) section pointing at it, so:

- Write **bare filenames** in `output` (e.g. `"design.md"`, `"plan.json"`). Both the working session and the verifier know to put/find them in the artifacts dir.
- You do **not** need template variables. The engine resolves exactly one token, `{{artifacts_dir}}` (byte-exact — no spaces inside the braces), and you rarely need even that.
- Any other `{{...}}` token reaches the prompt unresolved. `/ralphflow-doctor` flags it.

---

## Workflow-Level Options

### `description`

A one-line description shown in `/ralphflow-list`. Optional (falls back to the first step's `desc`).

```yaml
description: Build, test, and document a feature
```

### `manual_step`

Step IDs that require **human review**. List form or comma-string, both work:

```yaml
manual_step: [design]
# or
manual_step: design, review
```

A manual step pauses **after its DO phase completes, but before verification**: the session stops with a 📋 message so you can review the work. The workflow does **not** advance until you run `/ralphflow-continue` — that command **is** the approval that starts the independent verification. If you ask for changes, the session makes them and re-emits `<promise>done</promise>`, re-arming the gate.

> A `manual_step` entry that doesn't match a real step id is a **hard error** — the workflow won't load. A typo must never silently skip a review gate you're relying on.

**Complete example** — the id in `manual_step` must match a step in `steps`:

```yaml
description: Design-gated feature development

manual_step: [design]        # pause for review after the design step's DO

steps:
  - id: design
    desc: Technical design
    do: Write design.md covering the data model, API surface, and error handling.
    input: User requirements
    output: "design.md"
    check: Open design.md; verify it covers the data model, API surface, and error handling.
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: Implementation
    do: Implement the approved design. Run the tests until green.
    input: design.md
    output: Working code with passing tests
    check: Run the test suite yourself; verify the code matches design.md.
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

What happens at runtime:

1. The **design** step runs its DO phase and ends with `<promise>done</promise>`.
2. Because `design` is in `manual_step`, the session **stops** with a 📋 message instead of verifying — you read `design.md`.
3. You run `/ralphflow-continue`. *Now* the independent verifier checks `design.md`; on pass the workflow advances to **implement**.
4. **implement** is a normal step, so it verifies automatically without stopping for you.

### `adversarial_check`

Configure the independent verification session. By default the CHECK phase uses the read-only `ralph-check` agent with its default model. Customize any of:

```yaml
adversarial_check:
  agent: build                      # a different agent (default: ralph-check, read-only)
  model:                            # verifier model (object form)
    providerID: anthropic
    modelID: claude-haiku-4-5
  # model: anthropic/claude-haiku-4-5   # "provider/model" string form also works
  system_prompt: |                  # extra system prompt for the checker
    You are a strict code reviewer. Check that:
    - all functions have error handling
    - no hardcoded secrets
    - tests cover edge cases
  timeout_ms: 1800000               # check timeout in ms; default 900000 (15 min), capped at 3600000 (1 h)
```

| Field | Description | Default |
|-------|-------------|---------|
| `agent` | Which agent verifies | `ralph-check` (read-only) |
| `model` | `{providerID, modelID}` object or `"provider/model"` string | Agent's default model |
| `system_prompt` | Extra system prompt for the checker | Built-in verification prompt |
| `timeout_ms` | Check timeout in ms (capped at `3600000`) | `900000` (15 min) |

> A **bare** model name (e.g. `sonnet`, `Opus`) can't be resolved to a provider and silently falls back to the agent's default model — use the object form or a `"provider/model"` string. `/ralphflow-doctor` warns when it sees a bare name.

**Use cases:**
- Use a **cheaper model** for verification (e.g. Haiku checking Sonnet's work)
- Use a **stricter agent** that only reads, never writes
- Customize the **system prompt** for domain-specific criteria
- Increase the **timeout** for tasks that need longer verification

---

## Nested Workflows

Steps can invoke other workflows, enabling composition and reuse. A sub-workflow step still needs `input`/`output` (like every step).

### Basic Usage

```yaml
# workflows/full-dev.yaml
steps:
  - id: analyze
    desc: Requirements analysis
    workflow: analyze              # calls workflows/analyze.yaml
    input: User requirements
    output: analysis artifacts
    inputs:
      task: "Analyze requirements"
    on_pass: build
    on_fail: analyze
    max_fail_count: 3

  - id: build
    desc: Implementation
    workflow: build                # calls workflows/build.yaml
    input: analysis artifacts
    output: Working code
    on_pass: done
    on_fail: build
    max_fail_count: 3
```

### Passing Inputs

Use `inputs` to pass parameters into the sub-workflow's task:

```yaml
steps:
  - id: analyze
    desc: Analyze the feature
    workflow: analyze
    input: Feature request
    output: design document
    inputs:
      task: "Design the auth module"
      context: "We use JWT with refresh tokens"
    on_pass: done
    on_fail: analyze
    max_fail_count: 3
```

The `inputs` are merged into the sub-workflow's `user_task`, so its sessions can read them.

### Multi-Level Nesting

Workflows can nest up to **5 levels deep**:

```
full-dev.yaml
  └── analyze.yaml
       └── research.yaml
            └── ...
```

The engine keeps a per-instance state stack to preserve parent context during nesting; cycles are detected by `/ralphflow-doctor`.

### How It Works

1. The parent workflow reaches a sub-workflow step
2. The parent state is pushed onto the stack
3. The sub-workflow starts with combined context (inputs + original task)
4. When the sub-workflow completes, the parent state is restored
5. The parent continues based on the sub-workflow result (pass/fail)

---

## Completion Tags

Sessions signal completion with XML-like tags:

| Phase | Tag | Meaning |
|-------|-----|---------|
| DO | `<promise>done</promise>` | Task finished |
| CHECK | `<promise-check>true</promise-check>` | Passed |
| CHECK | `<promise-check>false</promise-check>` | Failed |

> Tags are case-insensitive and tolerate whitespace. The done tag must be on the last line (or within the last 100 chars); the check tag must occupy the verifier's last line. Tags inside code fences or inline code are ignored.

---

## Multi-Step Flow Design

> Each example is a complete, valid workflow — every normal step includes `input` and `output`.

### Linear Flow

The simplest pattern — steps run in sequence:

```yaml
steps:
  - id: design
    desc: Design phase
    do: Create the technical design.
    input: User requirements
    output: "design.md"
    check: Verify design.md is complete and sound.
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: Implementation phase
    do: Write code based on design.md.
    input: design.md
    output: Working code
    check: Run the tests and verify they pass.
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### Branching Flow

Steps jump to different steps based on the check result:

```yaml
steps:
  - id: analyze
    desc: Analyze the problem
    do: Determine whether this is a bug fix or a feature.
    input: User report
    output: "analysis.md classifying the task"
    check: Is the classification in analysis.md justified by the report?
    on_pass: implement
    on_fail: clarify
    max_fail_count: 2

  - id: clarify
    desc: Ask for clarification
    do: Ask the user for the missing details and record their answers.
    input: analysis.md
    output: "clarification.md with the answers"
    check: Does clarification.md contain enough detail to proceed?
    on_pass: analyze
    on_fail: clarify
    max_fail_count: 3

  - id: implement
    desc: Implement the fix
    do: Write the code.
    input: analysis.md
    output: Working code
    check: Does it build and pass the tests?
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### Recovery Flow

Use `on_fail` to route to a dedicated recovery step:

```yaml
steps:
  - id: build
    desc: Build the project
    do: Run the build.
    input: Source tree
    output: Build artifacts
    check: Did the build succeed?
    on_pass: test
    on_fail: fix-build
    max_fail_count: 2

  - id: fix-build
    desc: Fix build errors
    do: Read the error output and fix the issues.
    input: Build error output
    output: A building source tree
    check: Does the build pass now?
    on_pass: test
    on_fail: fix-build
    max_fail_count: 5

  - id: test
    desc: Run tests
    do: Execute the test suite.
    input: Build artifacts
    output: Test results
    check: Do all tests pass?
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 3

  - id: fix-tests
    desc: Fix failing tests
    do: Analyze the failures and fix them.
    input: Test failure output
    output: A passing test suite
    check: Do the tests pass now?
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 5
```

### Circular Flow (Loop Back)

Point `on_fail` at an earlier step to create a cycle:

```yaml
steps:
  - id: design
    desc: Design
    do: Create the technical design.
    input: Requirements
    output: "design.md"
    check: Is the design complete and sound?
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: Implementation
    do: Write code based on design.md.
    input: design.md
    output: Compiling, lint-clean code
    check: Does the code compile and pass linting?
    on_pass: test
    on_fail: design          # loop back to design if implementation reveals a flaw
    max_fail_count: 3

  - id: test
    desc: Testing
    do: Run the full test suite.
    input: Implementation
    output: Test results
    check: Do all tests pass?
    on_pass: done
    on_fail: implement       # loop back to implement if tests fail
    max_fail_count: 5
```

This creates the cycle `design → implement → test → implement → test → …`. If implementation reveals a design flaw, it loops back to `design`; if tests fail, it loops back to `implement`. The workflow converges on a working solution.

---

## Tips

- **Keep steps focused** — each step should do one thing well.
- **Write self-contained `check` recipes** — the verifier saw none of the DO conversation, so name the files to open, the commands to run, and concrete pass/fail criteria. Vague criteria ("code quality is good") make CHECK useless.
- **A light persona sharpens verification** — opening `check` with e.g. 「你是一个挑剔的测试工程师：你的目标不是确认任务完成，而是想办法证明它没完成。」 helps. Keep it to one line.
- **Set reasonable `max_fail_count`** — 3–5 for bounded steps, large (e.g. 100) for grind-until-green loops.
- **Use `manual_step` where a wrong direction is expensive** — plans, designs, destructive actions.
- **Use sub-workflows for reuse** — common patterns (analyze, build, test) can be shared.
- **Use a cheaper model for verification** — `adversarial_check.model` can save cost while keeping quality.
- **Write `do`/`check` prose in the user's language.**
