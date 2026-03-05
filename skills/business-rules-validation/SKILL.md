---
name: business-rules-validation
description: Use when the user asks to validate a pull request against ticket/task requirements, acceptance criteria, or business rules using `@kody -v business-logic`. Trigger on terms like business validation, acceptance criteria, PR-vs-task check, or merge readiness with task compliance.
license: MIT
compatibility: Requires Kodus CLI auth plus Kodus task-management integration (Jira/Linear/Notion/ClickUp) for useful task context retrieval.
metadata:
    author: Kodus
    version: '1.0'
---

# Business Rules Validation

## Goal

Run Kodus business-rules validation using one explicit mode:
- PR mode (remote PR context)
- Local diff mode (git diff from the current repository)

Do not mix the two modes in the same command.

## Required Inputs

- Exactly one execution mode:
  - PR mode:
    - `--pr-url <url>`
    - or `--pr-number <number>` with `--repo-id <id>` or `--repo <owner/repo>`
  - Local diff mode:
    - one local scope: `--staged` or `--branch <name>` or `--commit <sha>` or `[files...]`
- Optional task reference:
  - `--task-url <url>` or `--task-id <id>`
  - Do not pass both.

## When to Use

- The user asks for business-validation, business validation, business rules validation, or acceptance-criteria validation
- The user wants to check implementation vs task requirements (PR or local diff)
- The user mentions `@kody -v business-logic`

Do not use this skill as a substitute for `kodus review`. Local review and business-rules validation are different flows.

## Workflow

1. Choose the mode.
- PR mode: use PR flags only.
- Local mode: use local scope flags only.
- If both groups are present, stop and ask to choose one.

2. Build and run the command.
- PR mode examples:
```bash
kodus pr business-validation --pr-url <url> --task-id KC-1441
kodus pr business-validation --pr-number 140 --repo-id <id> --task-id KC-1441
```
- Local mode examples:
```bash
kodus pr business-validation --staged --task-id KC-1441
kodus pr business-validation --branch main --task-id KC-1441
kodus pr business-validation src/service.ts src/use-case.ts --task-id KC-1441
```

3. Interpret the result.
- `Mode: pull request` means remote PR validation.
- `Mode: local diff` means validation over the provided local diff scope.
- If output says missing MCP/task context, report that directly and request integration/context setup.

## Notes

- `kodus review` does not trigger this flow.
- Prefer `--task-id` or `--task-url` when the task is not obvious from PR/task metadata.
- `KC-1441`-style keys are valid.
