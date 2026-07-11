# ralph-flow Documentation

[English](README.md) · [中文](README_CN.md)

Welcome to the ralph-flow documentation. This guide helps you get the most out of workflow automation in opencode.

## Getting Started

New to ralph-flow? Start here:

1. [Installation](../README.md#-installation) — Install the plugin
2. [Quick Start](../README.md#-quick-start) — Run your first workflow
3. [Built-in Workflows](../README.md#built-in-workflows) — `loop`, `spec`

## Guides

Step-by-step guides for common tasks:

| Guide | Description |
|-------|-------------|
| [Custom Workflows](custom-workflows.md) | Create your own workflows with YAML |
| [Artifacts & Templates](custom-workflows.md#artifacts-directory--template-variables) | Where deliverables go, and the one template token |
| [Nested Workflows](custom-workflows.md#nested-workflows) | Compose workflows from reusable parts |
| [Verification Config](custom-workflows.md#adversarial_check) | Configure independent verification sessions |

## Reference

Technical reference documentation:

| Reference | Description |
|-----------|-------------|
| [How It Works](how-it-works.md) | Architecture, session events, state, multi-instance model |
| [Commands](commands.md) | All slash commands, tools, and log events |
| [File Structure](how-it-works.md#file-structure) | Where everything lives |
| [SYNC.md](../SYNC.md) | Structural mapping to the Claude Code sibling plugin |

## Reading Order

**For beginners:**
1. README (features, installation, quick start)
2. Custom Workflows (create your first workflow, then run `/ralphflow-doctor`)
3. Commands (learn all available commands)

**For advanced users:**
1. Custom Workflows → Nested Workflows (compose complex pipelines)
2. Custom Workflows → adversarial_check (optimize verification)
3. How It Works (understand the internals and the multi-instance model)
