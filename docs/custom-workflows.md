# Custom Workflows

[English](custom-workflows.md) · [中文](custom-workflows_CN.md)

Create your own workflow by placing a `.yaml` file in `.opencode/ralph-flow/workflows/`, or run `/ralphflow-create` to design and validate one interactively. A project workflow **shadows** a same-named built-in.

After writing a workflow, run `/ralphflow-doctor` — it catches silently-skipped steps (a step missing any required field is dropped while the rest still runs), unreachable steps, missing `done`, unresolvable template tokens, broken sub-workflow references and cycles.

---

## Quick Example

```yaml
steps:
  - id: analyze
    desc: Task Analysis
    do: Analyze requirements and produce a design document
    input: User requirements
    output: design.md
    check: Verify the design is complete and technically sound
    on_pass: execute
    on_fail: analyze
    max_fail_count: 3

  - id: execute
    desc: Implementation
    do: Implement the design
    input: design.md
    output: Working code
    check: Run tests and verify implementation
    on_pass: done
    on_fail: execute
    max_fail_count: 5
```

---

## Step Fields Reference

### Normal Steps

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique step identifier |
| `desc` | ✅ | Human-readable description |
| `do` | ✅ | Task prompt (what the AI should do) |
| `input` | ✅ | Expected inputs |
| `output` | ✅ | Expected outputs |
| `check` | ✅ | Verification criteria prompt |
| `on_pass` | ✅ | Next step id on success, or `"done"` to finish |
| `on_fail` | ✅ | Next step id on failure |
| `max_fail_count` | ✅ | Max failures before pausing (per step) |

> Every required field is required **per step**. A step missing one is **silently skipped** while the rest of the workflow still runs — run `/ralphflow-doctor` to catch this. Never omit `input`/`output`.

### Sub-Workflow Steps

Instead of `do`/`check`, you can call another workflow:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique step identifier |
| `desc` | ✅ | Human-readable description |
| `workflow` | ✅ | Name of the workflow to invoke |
| `input` | ✅ | Expected inputs |
| `output` | ✅ | Expected outputs |
| `inputs` | ❌ | Key-value pairs passed to the sub-workflow's `user_task` |
| `on_pass` | ✅ | Next step id on success |
| `on_fail` | ✅ | Next step id on failure |
| `max_fail_count` | ✅ | Max failures before pausing |

See [Nested Workflows](#nested-workflows) for details.

---

## Artifacts Directory & Template Variables

Every instance gets an isolated deliverables directory, `.opencode/ralph-flow/artifacts/<task>-<suffix>/`, that **survives** workflow completion. Every DO/CHECK prompt automatically carries a 产出目录 section pointing at it, so you write **bare filenames** in `output` (e.g. `"plan.md"`) and both the working session and the verifier know where to put/find them.

The engine resolves **exactly one** template token, `{{artifacts_dir}}` (byte-exact — no spaces inside the braces), and you rarely need even that. Any other `{{...}}` token reaches the prompt unresolved; `/ralphflow-doctor` flags it.

---

## Workflow-Level Options

### `description`

A one-line description shown in `/ralphflow-list`. Optional (falls back to the first step's `desc`).

```yaml
description: Build, test, and document a feature
```

### `manual_step`

Step IDs that require **human review**. Both list and comma-string forms are accepted:

```yaml
manual_step: [design]
# or
manual_step: design, review
```

A manual step pauses **after its DO phase completes but before verification**: the session stops with a 📋 message so you can review the work first. The workflow does *not* advance until you run `/ralphflow-continue` — that command **is** the approval that starts the independent verification. If you ask for changes, the session makes them and re-emits `<promise>done</promise>`, re-arming the gate.

> A `manual_step` entry that doesn't match a real step id is a **hard error** (the workflow won't load) — a typo must never silently skip a review gate you're counting on.

### `adversarial_check`

Configure the independent verification session. By default, the CHECK phase uses the `ralph-check` agent with default settings. You can customize:

```yaml
adversarial_check:
  agent: build                      # Use a different agent
  model:                            # Use a specific model for verification
    providerID: anthropic
    modelID: claude-haiku-4-5
  # model: anthropic/claude-haiku-4-5   # string form also works
  system_prompt: |                  # Custom system prompt for the checker
    You are a strict code reviewer.
    Check that:
    - All functions have error handling
    - No hardcoded secrets
    - Tests cover edge cases
  timeout_ms: 1800000               # Custom timeout (ms), default 15 minutes, capped at 1 hour
```

| Field | Description | Default |
|-------|-------------|---------|
| `agent` | Which agent to use for verification | `ralph-check` (read-only) |
| `model` | Verifier model: `{providerID, modelID}` object or `"provider/model"` string | Agent's default |
| `system_prompt` | Custom system prompt for the checker | Built-in verification prompt |
| `timeout_ms` | Check timeout in milliseconds (capped at `3600000`) | `900000` (15 minutes) |

> A **bare** model name (e.g. `sonnet`, `Opus`) can't be resolved to a provider and silently falls back to the agent's default model. Use the object form or a `"provider/model"` string. `/ralphflow-doctor` warns when it sees a bare name.

**Use cases:**
- Use a **cheaper model** for verification (e.g., Haiku for checking Sonnet's work)
- Use a **stricter agent** that only reads, never writes
- Customize the **system prompt** for domain-specific verification criteria
- Increase **timeout** for complex tasks that require longer verification

---

## Nested Workflows

Steps can invoke other workflows, enabling composition and reuse.

### Basic Usage

```yaml
# workflows/full-dev.yaml
steps:
  - id: analyze
    desc: Requirements Analysis
    workflow: analyze           # Calls workflows/analyze.yaml
    inputs:
      task: "Analyze requirements"
    on_pass: build
    on_fail: analyze
    max_fail_count: 3

  - id: build
    desc: Implementation
    workflow: build             # Calls workflows/build.yaml
    on_pass: done
    on_fail: build
    max_fail_count: 3
```

### Passing Inputs

Use `inputs` to pass parameters to the sub-workflow:

```yaml
steps:
  - id: analyze
    desc: Analyze the feature
    workflow: analyze
    inputs:
      task: "Design the auth module"
      context: "We use JWT with refresh tokens"
    on_pass: build
    on_fail: analyze
    max_fail_count: 3
```

The inputs are included in the sub-workflow's `user_task`, so the AI can access them.

### Multi-Level Nesting

Workflows can be nested up to **5 levels deep**:

```
full-dev.yaml
  └── analyze.yaml
       └── research.yaml
            └── ...
```

The plugin manages a state stack to preserve parent context during nesting.

### How It Works

1. Parent workflow reaches a sub-workflow step
2. Parent state is pushed onto the stack
3. Sub-workflow starts with combined context (inputs + original task)
4. When sub-workflow completes, parent state is restored
5. Parent continues based on sub-workflow result (pass/fail)

### Example: Modular Development Pipeline

```yaml
# workflows/full-dev.yaml
steps:
  - id: analyze
    desc: Requirements Analysis
    workflow: analyze
    inputs:
      task: "Analyze and design"
    on_pass: implement
    on_fail: analyze
    max_fail_count: 3

  - id: implement
    desc: Code Implementation
    workflow: implement
    on_pass: test
    on_fail: implement
    max_fail_count: 5

  - id: test
    desc: Testing
    workflow: test
    on_pass: done
    on_fail: test
    max_fail_count: 3
```

Each sub-workflow (`analyze.yaml`, `implement.yaml`, `test.yaml`) can have its own steps, verification, and retry logic.

---

## Completion Tags

The AI signals completion using XML-like tags:

| Phase | Tag | Meaning |
|-------|-----|---------|
| DO | `<promise>done</promise>` | Task finished |
| CHECK | `<promise-check>true</promise-check>` | Passed |
| CHECK | `<promise-check>false</promise-check>` | Failed |

> Tags are case-insensitive and allow whitespace. `<promise>DONE</promise>` works.

---

## Multi-Step Flow Design

### Linear Flow

The simplest pattern — steps execute in sequence:

```yaml
steps:
  - id: design
    desc: Design phase
    do: Create technical design
    check: Verify design completeness
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: Implementation phase
    do: Write code based on design
    check: Run tests
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

### Branching Flow

Steps can jump to different steps based on check results:

```yaml
steps:
  - id: analyze
    desc: Analyze the problem
    do: Determine if this is a bug fix or feature
    check: Is the analysis correct?
    on_pass: implement
    on_fail: clarify
    max_fail_count: 2

  - id: clarify
    desc: Ask for clarification
    do: Ask the user for more details
    check: Did the user provide enough info?
    on_pass: analyze
    on_fail: clarify
    max_fail_count: 3

  - id: implement
    desc: Implement the fix
    do: Write the code
    check: Does it work?
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
    do: Run the build process
    check: Did the build succeed?
    on_pass: test
    on_fail: fix-build
    max_fail_count: 2

  - id: fix-build
    desc: Fix build errors
    do: Read error output and fix issues
    check: Does the build pass now?
    on_pass: test
    on_fail: fix-build
    max_fail_count: 5

  - id: test
    desc: Run tests
    do: Execute test suite
    check: Do all tests pass?
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 3

  - id: fix-tests
    desc: Fix failing tests
    do: Analyze test failures and fix
    check: Do tests pass now?
    on_pass: done
    on_fail: fix-tests
    max_fail_count: 5
```

### Circular Flow (Loop Back)

Use `on_fail` to loop back to earlier steps, creating cycles:

```yaml
steps:
  - id: design
    desc: Design
    do: Create technical design
    check: Is the design complete and sound?
    on_pass: implement
    on_fail: design
    max_fail_count: 3

  - id: implement
    desc: Implementation
    do: Write code based on design
    check: Does the code compile and pass linting?
    on_pass: test
    on_fail: design          # Loop back to design if implementation reveals issues
    max_fail_count: 3

  - id: test
    desc: Testing
    do: Run full test suite
    check: Do all tests pass?
    on_pass: done
    on_fail: implement       # Loop back to implement if tests fail
    max_fail_count: 5
```

This creates the cycle: `design → implement → test → implement → test → ...`

If implementation reveals the design is flawed, it loops back to `design`. If tests fail, it loops back to `implement`. The workflow naturally converges on a working solution.

### Full Pipeline with Multiple Loops

```yaml
steps:
  - id: analyze
    desc: Requirements Analysis
    do: Analyze requirements and create spec
    check: Is the spec complete?
    on_pass: design
    on_fail: analyze
    max_fail_count: 3

  - id: design
    desc: Technical Design
    do: Create architecture and design doc
    check: Is the design sound?
    on_pass: implement
    on_fail: analyze         # Back to analyze if design needs rethinking
    max_fail_count: 3

  - id: implement
    desc: Code Implementation
    do: Write the code
    check: Does it compile?
    on_pass: test
    on_fail: design          # Back to design if implementation hits blockers
    max_fail_count: 3

  - id: test
    desc: Testing
    do: Run tests
    check: Do all tests pass?
    on_pass: done
    on_fail: implement       # Back to implement for fixes
    max_fail_count: 5
```

Multiple loops: `analyze ↔ design → implement ↔ test`

---

## Tips

- **Keep steps focused** — each step should do one thing well
- **Use descriptive `desc` values** — they appear in status output
- **Set reasonable `max_fail_count`** — too low causes frequent pauses, too high wastes tokens
- **Write clear `check` prompts** — the verification quality depends on how well you describe what "done" looks like
- **Use `manual_step` sparingly** — auto-continuation is a key benefit of workflows
- **Use sub-workflows for reuse** — common patterns (analyze, build, test) can be shared across workflows
- **Use cheaper models for verification** — `adversarial_check.model` can save costs while maintaining quality
