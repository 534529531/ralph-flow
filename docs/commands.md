# Commands Reference

## Slash Commands

| Command | Tool | Description |
|---------|------|-------------|
| `/ralphflow-start` | `ralphflow-start` | Start a workflow |
| `/ralphflow-continue` | `ralphflow-continue` | Resume a paused workflow |
| `/ralphflow-cancel` | `ralphflow-cancel` | Cancel and generate report |
| `/ralphflow-status` | `ralphflow-status` | Show current workflow state |
| `/ralphflow-list` | `ralphflow-list` | List available workflows |

### Usage Examples

```
# Start interactively
/ralphflow-start

# Start a specific workflow
/ralphflow-start loop "Build user authentication"

# Check current status
/ralphflow-status

# Resume after pause
/ralphflow-continue

# Cancel and get report
/ralphflow-cancel

# List all workflows
/ralphflow-list
```

---

## Log Events

Events are logged to `.opencode/ralph-flow/logs/execution.log` in JSON Lines format.

### Workflow Events

| Event | Description |
|-------|-------------|
| `workflow_start` | Workflow started |
| `workflow_end` | Workflow completed |
| `workflow_paused` | Paused (max failures reached) |
| `workflow_resumed` | Resumed by user |
| `workflow_cancelled` | Cancelled by user |

### Step Events

| Event | Description |
|-------|-------------|
| `step_start` | Step phase started |
| `done_detected` | `<promise>done</promise>` detected |
| `check_result` | Check result (true / false) |
| `fail_count_increment` | Failure count increased |

### Log Format

Each line is a JSON object with common fields:

```json
{
  "event": "step_start",
  "step": "loop",
  "phase": "do",
  "timestamp": "2024-01-15T10:30:01Z"
}
```

### Reading Logs

```bash
# View all logs
cat .opencode/ralph-flow/logs/execution.log

# Filter by event type
grep '"event":"check_result"' .opencode/ralph-flow/logs/execution.log

# View last 10 events
tail -10 .opencode/ralph-flow/logs/execution.log
```

---

## Final Report

When a workflow completes or is cancelled, a summary report is generated at `.opencode/ralph-flow/logs/final-report.md`.

The report includes:
- Workflow name and duration
- Steps completed
- Total failures and retries
- Final status
