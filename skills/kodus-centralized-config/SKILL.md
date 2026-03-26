---
name: kodus-centralized-config
description: Use when the user wants to manage centralized configuration via `kodus config centralized` commands (status, init, sync, disable, and download).
---

# Kodus Centralized Config

## Goal

Manage centralized configuration through Kodus CLI commands only.

Use this skill when the request involves enabling centralized config, selecting the source repository, syncing configuration, disabling centralized config, or downloading generated config files.

## Trigger Hints

- Mentions of centralized config, centralized configuration, config sync source repo, or source repository for rules.
- Requests to run: `kodus config centralized status|init|sync|disable|download`.
- Requests to enable or disable centralized config from terminal.

## Workflow

1. Confirm team-key authentication is available.

- Centralized config commands require team-key auth.
- If missing, instruct the user to run:

```bash
kodus auth team-key --key <your-key>
```

2. Check current centralized status first when context is unclear.

```bash
kodus config centralized status
```

3. Initialize centralized config when requested.

- Preferred command shape:

```bash
kodus config centralized init [owner/repo] --sync-option <pr|manual>
```

- Defaults and behavior:
- `--sync-option` defaults to `pr`.
- If repository is omitted in an interactive terminal, CLI prompts repository selection.
- In non-interactive mode, repository must be provided explicitly.

4. Sync centralized config on demand.

```bash
kodus config centralized sync
```

5. Disable centralized config when requested.

```bash
kodus config centralized disable
```

6. Download centralized config zip artifact.

```bash
kodus config centralized download --out <path/to/centralized-config.zip>
```

- `--out` is required.

## Output Guidance

- Prefer human-readable output for interactive guidance.
- Use `--json` when structured output is needed for automation/logging.

## Safety Notes

- Do not suggest manually editing backend parameters for centralized config when CLI commands exist.
- If repository selection fails, verify the repository is already selected in Kodus (`kodus config remote list`).
