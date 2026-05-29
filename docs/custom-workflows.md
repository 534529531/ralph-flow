# Custom Workflows

Create your own workflow by placing a `.yaml` file in `.opencode/ralph-flow/workflows/`.

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

### Sub-Workflow Steps

Instead of `do`/`check`/`input`/`output`, you can call another workflow:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Unique step identifier |
| `desc` | ✅ | Human-readable description |
| `workflow` | ✅ | Name of the workflow to invoke |
| `inputs` | ❌ | Key-value pairs passed to the sub-workflow |
| `on_pass` | ✅ | Next step id on success |
| `on_fail` | ✅ | Next step id on failure |
| `max_fail_count` | ✅ | Max failures before pausing |

See [Nested Workflows](#nested-workflows) for details.

---

## Workflow-Level Options

### `manual_step`

Add step IDs to require user action before proceeding:

```yaml
manual_step: analyze, execute

steps:
  - id: analyze
    # ...
  - id: execute
    # ...
```

Steps in this list will **not** auto-continue when the session is idle — the AI waits for your input.

### `adversarial_check`

Configure the independent verification session. By default, the CHECK phase uses the `ralph-check` agent with default settings. You can customize:

```yaml
adversarial_check:
  agent: "build"                    # Use a different agent
  model:                            # Use a specific model for verification
    providerID: "anthropic"
    modelID: "claude-haiku-4-5"
  system_prompt: |                  # Custom system prompt for the checker
    You are a strict code reviewer.
    Check that:
    - All functions have error handling
    - No hardcoded secrets
    - Tests cover edge cases
```

| Field | Description | Default |
|-------|-------------|---------|
| `agent` | Which agent to use for verification | `ralph-check` |
| `model` | Specific model for verification (providerID + modelID) | Same as main session |
| `system_prompt` | Custom system prompt for the checker | Built-in verification prompt |

**Use cases:**
- Use a **cheaper model** for verification (e.g., Haiku for checking Sonnet's work)
- Use a **stricter agent** that only reads, never writes
- Customize the **system prompt** for domain-specific verification criteria

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
