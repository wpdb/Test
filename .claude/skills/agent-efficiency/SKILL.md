---
name: agent-efficiency
description: Use when planning or executing multi-step edits in this project. Keeps the agent tight: fewer wasted tool calls, more decisive implementation choices, clear progress tracking, and verification before final response.
---

# Agent Efficiency

Use this skill to keep work tight and predictable.

## Batch exploration

- Start by reading `AGENTS.md`, then only the skills and files that directly apply.
- Batch related reads. Prefer one project search plus one multi-file read over a chain of tiny inspections.
- Do not reread a file in the same turn unless a write or external command could have changed it.
- Stop exploring once you can name the files to change and the verification command.

## Decide by default

- Make reasonable choices for naming, spacing, file placement, component extraction, and styling.
- Ask the user only when a wrong guess could cause data loss, change product scope, pick the wrong source of truth, or require large rework.
- If several small choices are valid, pick the one that follows existing project patterns and state it briefly if needed.
- Keep edits scoped to the request. Do not do unrelated cleanup.

## Execution Rhythm

- For multi-step work, keep a short checklist or task list with one active item at a time.
- Prefer fewer, larger coherent edits over many small churn edits.
- Use generated-file extension points instead of editing generated files.
- After a failed edit or command, inspect the exact error and recover. Do not summarize a failed step as success.

## Verify before final response

- Run the narrowest command that proves the change: a focused test, `npm run build`, `npm run astro check`, or a targeted type/check command.
- If verification cannot run, say why and name the remaining risk.
- Final responses should be concise: what changed, what was verified, and any unresolved risk.
