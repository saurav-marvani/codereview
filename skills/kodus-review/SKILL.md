---
name: kodus-review
description: Use when the user asks to review code or prepare commit/push/PR/merge with quality checks on local changes using the installed Kodus CLI. Trigger on terms like review, commit, push, pull request, merge, or quality gate. Not for PR-vs-task business rules validation.
license: MIT
compatibility: Requires the Kodus CLI installed in PATH and network access to the Kodus API. Prefer non-interactive authentication via team key or explicit credentials.
metadata:
    author: Kodus
    version: '1.0'
---

# Kodus Review

## Goal

Use the Kodus CLI to review changes and resolve issues. Prefer machine-friendly output via `--prompt-only`, then apply fixes in code.

If the request is to validate a pull request against business rules, task requirements, or acceptance criteria, use `kodus-business-rules-validation` instead (legacy alias: `business-rules-validation`). `kodus review` does not trigger `@kody -v business-logic`.

## Trigger Hints

- Treat mentions of `review`, `commit`, `push`, `open PR`, `merge`, `quality gate`, or `ready to ship` as triggers for this skill.
- For commit/push/merge requests, proactively ask to run Kodus review first when a fresh review has not run yet in the current task.

## Workflow

0. Apply review gate on delivery actions.

- If the user asks to commit/push/merge/open PR and did not explicitly skip review, ask whether to run `kodus review --prompt-only` first.
- If the user declines, continue with the requested delivery action and clearly note review was skipped by user choice.

1. Ensure Kodus CLI is available.

- Run `kodus --help` to confirm.
- If missing, ask the user to install the CLI and stop.

2. Ensure authentication if required.

- Run `kodus auth status` to inspect the current auth mode first.
- Prefer `kodus auth team-key --key <key>` when the user provides a team key.
- If the user provides email and password explicitly, use `kodus auth login --email <email> --password <password>`.
- If auth is missing and only interactive login is possible, stop and ask the user to authenticate manually rather than relying on prompts.

3. Run review using prompt-only output.

- Default: `kodus review --prompt-only`.
- If user specifies files: `kodus review --prompt-only <files...>`.
- If user asks for staged/commit/branch: add `--staged`, `--commit <sha>`, or `--branch <name>`.
- If user wants fast: add `--fast`.

4. Parse results and apply fixes.

- Use the output to locate files and lines.
- Make minimal, targeted changes to address each issue.
- If an issue is not actionable or is a false positive, explain why and skip.

5. Re-run review if needed.

- After fixes, rerun `kodus review --prompt-only` to confirm issues are resolved.

## Notes

- Prefer `--prompt-only` for predictable parsing.
- Avoid `--interactive` unless the user explicitly asks.
- Redirect PR-vs-task validation requests to `kodus-business-rules-validation` (legacy alias `business-rules-validation`).
- Use `review --help` to undertstand review possibilities
