#!/bin/sh
set -e

# Kodus CLI installer
# Installs Kodus CLI if not present, authenticates with team key if provided,
# and installs Kodus skills into project skill directories for Cursor,
# Claude Code, and other supported tools.

# Colors (only if stdout is a TTY)
if [ -t 1 ]; then
  BOLD="\033[1m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  GRAY="\033[37m"
  DARK="\033[90m"
  CYAN="\033[36m"
  RESET="\033[0m"
else
  BOLD=""
  GREEN=""
  YELLOW=""
  GRAY=""
  DARK=""
  CYAN=""
  RESET=""
fi

print_header() {
  printf "${BOLD}%s${RESET}\n" "$1"
}

print_ascii() {
  B="${CYAN}"
  R="${RESET}"

printf '%s\n' \
' ██╗  ██╗ ██████╗ ██████╗ ██╗   ██╗ ███████╗' \
' ██║ ██╔╝██╔═══██╗██╔══██╗██║   ██║ ██╔════╝' \
' █████╔╝ ██║   ██║██║  ██║██║   ██║ ███████╗' \
' ██╔═██╗ ██║   ██║██║  ██║██║   ██║ ╚════██║' \
' ██║  ██╗╚██████╔╝██████╔╝╚██████╔╝ ███████║' \
' ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝  ╚══════╝'

  printf "\n"
  printf "  ${DARK}AI-powered code review from your terminal${R}\n"
}

print_success() {
  printf "${GREEN}✓${RESET} %s\n" "$1"
}

print_info() {
  printf "${YELLOW}→${RESET} %s\n" "$1"
}

print_error() {
  printf "${BOLD}Error:${RESET} %s\n" "$1" >&2
}

print_dim() {
  printf "${DARK}%s${RESET}\n" "$1"
}

# Parse arguments
TEAM_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --team-key)
      TEAM_KEY="$2"
      shift 2
      ;;
    --team-key=*)
      TEAM_KEY="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "Usage: curl -fsSL <url> | bash -s -- [options]"
      echo ""
      echo "Options:"
      echo "  --team-key <key>  Authenticate with team key after installation"
      echo "  -h, --help        Show this help message"
      echo ""
      echo "Example:"
      echo "  curl -fsSL https://raw.githubusercontent.com/kodustech/cli/main/install.sh | bash -s -- --team-key <key>"
      exit 0
      ;;
    *)
      print_error "Unknown option: $1"
      echo "Use -h or --help for usage information"
      exit 1
      ;;
  esac
done

print_ascii
printf "\n"

print_info "Checking Kodus CLI installation..."

# Check if kodus is installed (before update)
KODUS_WAS_INSTALLED=0
if command -v kodus >/dev/null 2>&1; then
  KODUS_VERSION=$(kodus --version 2>/dev/null || echo "unknown")
  print_success "Kodus CLI is already installed (${KODUS_VERSION})"
  KODUS_WAS_INSTALLED=1
fi

print_info "Updating Kodus CLI..."
if command -v npm >/dev/null 2>&1; then
  npm install -g @kodus/cli
else
  print_error "npm is required but not installed"
  print_dim "Please install Node.js from https://nodejs.org"
  exit 1
fi

KODUS_VERSION=$(kodus --version 2>/dev/null || echo "unknown")
if [ "$KODUS_WAS_INSTALLED" -eq 1 ]; then
  print_success "Kodus CLI updated successfully (${KODUS_VERSION})"
else
  print_success "Kodus CLI installed successfully (${KODUS_VERSION})"
fi

printf "\n"

# Authenticate with team key if provided
if [ -n "$TEAM_KEY" ]; then
  print_info "Authenticating with team key..."
  if kodus auth team-key --key "$TEAM_KEY"; then
    print_success "Authenticated successfully"
  else
    print_error "Authentication failed"
    exit 1
  fi
  printf "\n"
else
  print_dim "No team key provided. Run later with: kodus auth team-key --key <your-key>"
  printf "\n"
fi

print_info "Installing Kodus skills..."

# Prepare kodus-review skill content from local file
if [ -f "./skills/kodus-review/SKILL.md" ]; then
  SKILL_CONTENT_REVIEW=$(cat "./skills/kodus-review/SKILL.md")
elif [ -f "${PWD}/skills/kodus-review/SKILL.md" ]; then
  SKILL_CONTENT_REVIEW=$(cat "${PWD}/skills/kodus-review/SKILL.md")
elif command -v curl >/dev/null 2>&1 && SKILL_CONTENT_REVIEW=$(curl -fsSL "https://raw.githubusercontent.com/kodustech/cli/main/skills/kodus-review/SKILL.md" 2>/dev/null); then
  :
else
  # Fallback: use skill content inline
  SKILL_CONTENT_REVIEW='---
name: kodus-review
description: Use the Kodus CLI to run code reviews and apply fixes based on CLI output. Trigger when asked to review code with Kodus, run `kodus review`, use `--prompt-only`, or act on Kodus review results.
---

# Kodus Review

## Goal

Use the Kodus CLI to review changes and resolve issues. Prefer machine-friendly output via `--prompt-only`, then apply fixes in code.

## Workflow

1) Ensure Kodus CLI is available.
- Run `kodus --help` to confirm.
- If missing, ask the user to install the CLI and stop.

2) Ensure authentication if required.
- If `kodus review` fails with auth, run `kodus auth login` (interactive) and retry.
- For team keys, use `kodus auth team-key --key <key>` when provided by the user.

3) Run review using prompt-only output.
- Default: `kodus review --prompt-only`.
- If user specifies files: `kodus review --prompt-only <files...>`.
- If user asks for staged/commit/branch: add `--staged`, `--commit <sha>`, or `--branch <name>`.
- If user wants fast: add `--fast`.

4) Parse results and apply fixes.
- Use the output to locate files and lines.
- Make minimal, targeted changes to address each issue.
- If an issue is not actionable or is a false positive, explain why and skip.

5) Re-run review if needed.
- After fixes, rerun `kodus review --prompt-only` to confirm issues are resolved.

## Notes

- Prefer `--prompt-only` for predictable parsing.
- Avoid `--interactive` unless the user explicitly asks.
- Use `review --help` to understand review possibilities
'
fi

# Prepare kodus-pr-suggestions-resolver skill content from local file
if [ -f "./skills/kodus-pr-suggestions-resolver/SKILL.md" ]; then
  SKILL_CONTENT_RESOLVE=$(cat "./skills/kodus-pr-suggestions-resolver/SKILL.md")
elif [ -f "${PWD}/skills/kodus-pr-suggestions-resolver/SKILL.md" ]; then
  SKILL_CONTENT_RESOLVE=$(cat "${PWD}/skills/kodus-pr-suggestions-resolver/SKILL.md")
elif command -v curl >/dev/null 2>&1 && SKILL_CONTENT_RESOLVE=$(curl -fsSL "https://raw.githubusercontent.com/kodustech/cli/main/skills/kodus-pr-suggestions-resolver/SKILL.md" 2>/dev/null); then
  :
else
  # Fallback: use skill content inline
  SKILL_CONTENT_RESOLVE='---
name: kodus-pr-suggestions-resolver
description: Run Kodus CLI PR suggestions and apply fixes with judgment. Use when asked to fetch `kodus pr suggestions` for a PR URL/number/repo-id, analyze each suggestion against the PR intent, implement reasonable fixes, run build/tests when available, and report what was done or skipped.
---

# Kodus PR Suggestions Resolver

## Overview

Fetch PR suggestions via Kodus CLI, triage each suggestion against the PR goal, apply safe fixes, then validate with build/tests and report results.

## Workflow

### 1) Collect the PR target

- If the user did not provide a target, ask for one of:
  - `--pr-url <url>`
  - `--pr-number <number>` with `--repo-id <id>`
- If multiple are provided, prefer `--pr-url`.

### 2) Run Kodus suggestions

Use:

```
kodus pr suggestions --pr-url <url>
```

Or when the URL is not available:

```
kodus pr suggestions --pr-number <number> --repo-id <id>
```

### 3) Analyze suggestions with PR intent in mind

- Extract or confirm the PR goal from the user or PR context.
- For each suggestion:
  - Verify it does not conflict with the PR objective.
  - Prefer small, low-risk changes that improve the PR without changing scope.
  - Skip suggestions that are irrelevant, risky, or scope-expanding; note why.

### 4) Apply fixes one by one

- Make changes per accepted suggestion.
- Keep edits minimal and focused.
- If a suggestion is unclear, ask a clarifying question before changing code.

### 5) Validate with build/tests (when available)

- Run the most relevant build or tests for the edited area.
- If no tests are available or running them is not possible, state that explicitly.

### 6) Report results

Provide a concise report covering:

- Suggestions applied (with brief rationale).
- Suggestions skipped (with reasons).
- Tests/builds run and outcomes.
- Remaining uncertainties or follow-ups needed.
'
fi

# Prepare business-rules-validation skill content from local file
if [ -f "./skills/kodus-business-rules-validation/SKILL.md" ]; then
  SKILL_CONTENT_BUSINESS=$(cat "./skills/kodus-business-rules-validation/SKILL.md")
elif [ -f "${PWD}/skills/kodus-business-rules-validation/SKILL.md" ]; then
  SKILL_CONTENT_BUSINESS=$(cat "${PWD}/skills/kodus-business-rules-validation/SKILL.md")
elif [ -f "./skills/business-rules-validation/SKILL.md" ]; then
  SKILL_CONTENT_BUSINESS=$(cat "./skills/business-rules-validation/SKILL.md")
elif [ -f "${PWD}/skills/business-rules-validation/SKILL.md" ]; then
  SKILL_CONTENT_BUSINESS=$(cat "${PWD}/skills/business-rules-validation/SKILL.md")
elif command -v curl >/dev/null 2>&1 && SKILL_CONTENT_BUSINESS=$(curl -fsSL "https://raw.githubusercontent.com/kodustech/cli/main/skills/kodus-business-rules-validation/SKILL.md" 2>/dev/null); then
  :
else
  # Fallback: use skill content inline
  SKILL_CONTENT_BUSINESS='---
name: kodus-business-rules-validation
description: Use when asked for business validation, acceptance-criteria validation, PR-vs-task checks, or merge readiness with task compliance. Run `kodus pr business-validation` against local diff scope and optional task context.
---

# Business Rules Validation

## Goal

Run Kodus business-rules validation from local repository diff scope and optional task reference.

## Workflow

1) Ensure Kodus CLI is available.
- Run `kodus --help` to confirm.
- If missing, ask the user to install the CLI and stop.

2) Ensure authentication if required.
- If command fails with auth, run `kodus auth login` (interactive) and retry.
- For team keys, use `kodus auth team-key --key <key>` when provided by the user.

3) Choose local diff scope.
- Default (no scope flags): working tree diff.
- Optional explicit scope: `--staged`, `--branch <name>`, `--commit <sha>`, or `[files...]`.
- Use only one scope per command.

4) Run business validation.
- Examples:
```bash
kodus pr business-validation --staged --task-id KC-1441
kodus pr business-validation --branch main --task-id KC-1441
kodus pr business-validation src/service.ts src/use-case.ts --task-id KC-1441
```

5) Interpret and apply.
- Parse output and identify mismatches against requirements.
- Apply focused changes.
- Re-run the same command until output is acceptable.

## Notes

- Use `--task-id` or `--task-url` when available.
- `kodus review` and business validation are different flows.
'
fi

BUSINESS_SKILL_NAME="kodus-business-rules-validation"
BUSINESS_SKILL_LEGACY_NAME="business-rules-validation"

OPTIONAL_INSTALLED=0

# ── Helper functions ──

install_as_skill() {
  base_dir="$1"
  label="$2"
  skill_dirname="$3"
  skill_content="$4"
  skill_dir="$base_dir/$skill_dirname"
  skill_file="$skill_dir/SKILL.md"
  if [ -f "$skill_file" ]; then
    if printf "%s\n" "$skill_content" | cmp -s "$skill_file" -; then
      print_success "$label already up to date ($skill_dirname)"
    else
      printf "%s\n" "$skill_content" > "$skill_file"
      print_success "$label updated ($skill_dirname)"
    fi
  else
    mkdir -p "$skill_dir"
    printf "%s\n" "$skill_content" > "$skill_file"
    print_success "$label installed ($skill_dirname)"
  fi
  OPTIONAL_INSTALLED=$((OPTIONAL_INSTALLED + 1))
}

install_as_command() {
  base_dir="$1"
  label="$2"
  skill_name="$3"
  skill_content="$4"
  cmd_file="$base_dir/$skill_name.md"
  if [ -f "$cmd_file" ]; then
    if printf "%s\n" "$skill_content" | cmp -s "$cmd_file" -; then
      print_success "$label already up to date ($skill_name)"
    else
      printf "%s\n" "$skill_content" > "$cmd_file"
      print_success "$label updated ($skill_name)"
    fi
  else
    mkdir -p "$base_dir"
    printf "%s\n" "$skill_content" > "$cmd_file"
    print_success "$label installed ($skill_name)"
  fi
  OPTIONAL_INSTALLED=$((OPTIONAL_INSTALLED + 1))
}

install_skill_pair() {
  base_dir="$1"
  label="$2"
  if [ -d "$base_dir/$BUSINESS_SKILL_LEGACY_NAME" ]; then
    rm -rf "$base_dir/$BUSINESS_SKILL_LEGACY_NAME"
    print_dim "Removed legacy skill name ($BUSINESS_SKILL_LEGACY_NAME)"
  fi
  install_as_skill "$base_dir" "$label" "kodus-review" "$SKILL_CONTENT_REVIEW"
  install_as_skill "$base_dir" "$label" "kodus-pr-suggestions-resolver" "$SKILL_CONTENT_RESOLVE"
  install_as_skill "$base_dir" "$label" "$BUSINESS_SKILL_NAME" "$SKILL_CONTENT_BUSINESS"
}

install_command_pair() {
  base_dir="$1"
  label="$2"
  if [ -f "$base_dir/$BUSINESS_SKILL_LEGACY_NAME.md" ]; then
    rm -f "$base_dir/$BUSINESS_SKILL_LEGACY_NAME.md"
    print_dim "Removed legacy command name ($BUSINESS_SKILL_LEGACY_NAME)"
  fi
  install_as_command "$base_dir" "$label" "kodus-review" "$SKILL_CONTENT_REVIEW"
  install_as_command "$base_dir" "$label" "kodus-pr-suggestions-resolver" "$SKILL_CONTENT_RESOLVE"
  install_as_command "$base_dir" "$label" "$BUSINESS_SKILL_NAME" "$SKILL_CONTENT_BUSINESS"
}

install_gemini_toml() {
  dest_file="$1"
  label="$2"
  skill_name="$3"
  toml_desc="$4"
  skill_content="$5"
  tmp_file="${dest_file}.tmp"
  printf 'description = "%s"\nprompt = """\n' "$toml_desc" > "$tmp_file"
  printf "%s\n" "$skill_content" >> "$tmp_file"
  printf '\n"""\n' >> "$tmp_file"
  if [ -f "$dest_file" ] && cmp -s "$dest_file" "$tmp_file"; then
    rm -f "$tmp_file"
    print_success "$label already up to date ($skill_name)"
  else
    was_update=0
    [ -f "$dest_file" ] && was_update=1
    mv "$tmp_file" "$dest_file"
    if [ "$was_update" -eq 1 ]; then
      print_success "$label updated ($skill_name)"
    else
      print_success "$label installed ($skill_name)"
    fi
  fi
  OPTIONAL_INSTALLED=$((OPTIONAL_INSTALLED + 1))
}

# ── Cleanup legacy duplicates ──
# Previous versions installed as both skills and commands for the same tool.
# Tools that now use commands no longer need the skills copy.
cleanup_legacy_skill() {
  skill_dir="$1"
  if [ -d "$skill_dir/kodus-review" ] || [ -d "$skill_dir/kodus-pr-suggestions-resolver" ] || [ -d "$skill_dir/$BUSINESS_SKILL_LEGACY_NAME" ] || [ -d "$skill_dir/$BUSINESS_SKILL_NAME" ]; then
    rm -rf "$skill_dir/kodus-review" "$skill_dir/kodus-pr-suggestions-resolver" "$skill_dir/$BUSINESS_SKILL_LEGACY_NAME" "$skill_dir/$BUSINESS_SKILL_NAME"
    print_dim "Cleaned up legacy duplicates in $skill_dir"
  fi
}

cleanup_legacy_skill "${PWD}/.claude/skills"
cleanup_legacy_skill "$HOME/.claude/skills"
cleanup_legacy_skill "$HOME/.config/claude/skills"
cleanup_legacy_skill "${PWD}/.cursor/skills"
cleanup_legacy_skill "$HOME/.cursor/skills"
cleanup_legacy_skill "$HOME/.gemini/skills"

# ── Per-tool installation ──
# Each tool installs ONCE: project-level preferred over global.
# Tools supporting both skills and commands install as commands only (avoids duplication).

# ── Claude Code ──
CLAUDE_DONE=0
if [ -d "${PWD}/.claude" ]; then
  install_command_pair "${PWD}/.claude/commands" "Claude Code project command"
  CLAUDE_DONE=1
fi
if [ "$CLAUDE_DONE" -eq 0 ]; then
  if [ -n "$CLAUDE_CODE_SKILLS_DIR" ]; then
    install_skill_pair "$CLAUDE_CODE_SKILLS_DIR" "Claude Code skill"
    CLAUDE_DONE=1
  elif [ -d "$HOME/.claude" ]; then
    install_command_pair "$HOME/.claude/commands" "Claude Code command"
    CLAUDE_DONE=1
  elif [ -d "$HOME/.config/claude" ]; then
    install_command_pair "$HOME/.config/claude/commands" "Claude Code command"
    CLAUDE_DONE=1
  fi
fi

# ── Cursor ──
CURSOR_DONE=0
if [ -d "${PWD}/.cursor" ]; then
  install_command_pair "${PWD}/.cursor/commands" "Cursor project command"
  CURSOR_DONE=1
fi
if [ "$CURSOR_DONE" -eq 0 ] && [ -d "$HOME/.cursor" ]; then
  install_command_pair "$HOME/.cursor/commands" "Cursor command"
  CURSOR_DONE=1
fi

# ── OpenCode ──
OPENCODE_DONE=0
if [ -d "${PWD}/.opencode/skill" ]; then
  install_skill_pair "${PWD}/.opencode/skill" "OpenCode project skill"
  OPENCODE_DONE=1
fi
if [ "$OPENCODE_DONE" -eq 0 ]; then
  if command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ]; then
    install_command_pair "$HOME/.config/opencode/command" "OpenCode command"
    OPENCODE_DONE=1
  fi
fi

# ── AiderDesk (global preferred — AD uses ~/.aider-desk as its config root) ──
AIDERDESK_DONE=0
if [ -d "$HOME/.aider-desk" ]; then
  install_command_pair "$HOME/.aider-desk/commands" "AiderDesk command"
  AIDERDESK_DONE=1
fi
if [ "$AIDERDESK_DONE" -eq 0 ] && [ -d "${PWD}/.aider-desk" ]; then
  install_command_pair "${PWD}/.aider-desk/commands" "AiderDesk project command"
  AIDERDESK_DONE=1
fi

# ── Codex ──
CODEX_DONE=0
if [ -d "${PWD}/.codex/skills" ]; then
  install_skill_pair "${PWD}/.codex/skills" "Codex project skill"
  CODEX_DONE=1
fi
if [ "$CODEX_DONE" -eq 0 ] && [ -d "$HOME/.codex/skills" ]; then
  install_skill_pair "$HOME/.codex/skills" "Codex skill"
  CODEX_DONE=1
fi

# ── Amp ──
AMP_DONE=0
if [ -d "${PWD}/.agents/skills" ]; then
  install_skill_pair "${PWD}/.agents/skills" "Amp project skill"
  AMP_DONE=1
fi
if [ "$AMP_DONE" -eq 0 ] && [ -d "$HOME/.config/agents/skills" ]; then
  install_skill_pair "$HOME/.config/agents/skills" "Amp skill"
  AMP_DONE=1
fi

# ── Kilo Code ──
KILOCODE_DONE=0
if [ -d "${PWD}/.kilocode/skills" ]; then
  install_skill_pair "${PWD}/.kilocode/skills" "Kilo Code project skill"
  KILOCODE_DONE=1
fi
if [ "$KILOCODE_DONE" -eq 0 ] && [ -d "$HOME/.kilocode/skills" ]; then
  install_skill_pair "$HOME/.kilocode/skills" "Kilo Code skill"
  KILOCODE_DONE=1
fi

# ── Roo Code ──
ROO_DONE=0
if [ -d "${PWD}/.roo/skills" ]; then
  install_skill_pair "${PWD}/.roo/skills" "Roo Code project skill"
  ROO_DONE=1
fi
if [ "$ROO_DONE" -eq 0 ] && [ -d "$HOME/.roo/skills" ]; then
  install_skill_pair "$HOME/.roo/skills" "Roo Code skill"
  ROO_DONE=1
fi

# ── Goose ──
GOOSE_DONE=0
if [ -d "${PWD}/.goose/skills" ]; then
  install_skill_pair "${PWD}/.goose/skills" "Goose project skill"
  GOOSE_DONE=1
fi
if [ "$GOOSE_DONE" -eq 0 ] && [ -d "$HOME/.config/goose/skills" ]; then
  install_skill_pair "$HOME/.config/goose/skills" "Goose skill"
  GOOSE_DONE=1
fi

# ── Antigravity ──
ANTIGRAVITY_DONE=0
if [ -d "${PWD}/.agent/skills" ]; then
  install_skill_pair "${PWD}/.agent/skills" "Antigravity project skill"
  ANTIGRAVITY_DONE=1
fi
if [ "$ANTIGRAVITY_DONE" -eq 0 ] && [ -d "$HOME/.gemini/antigravity/skills" ]; then
  install_skill_pair "$HOME/.gemini/antigravity/skills" "Antigravity skill"
  ANTIGRAVITY_DONE=1
fi

# ── GitHub Copilot ──
COPILOT_DONE=0
if [ -d "${PWD}/.github/skills" ]; then
  install_skill_pair "${PWD}/.github/skills" "GitHub Copilot project skill"
  COPILOT_DONE=1
fi
if [ "$COPILOT_DONE" -eq 0 ] && [ -d "$HOME/.copilot/skills" ]; then
  install_skill_pair "$HOME/.copilot/skills" "GitHub Copilot skill"
  COPILOT_DONE=1
fi

# ── Clawdbot ──
CLAWDBOT_DONE=0
if [ -d "${PWD}/skills" ]; then
  install_skill_pair "${PWD}/skills" "Clawdbot project skill"
  CLAWDBOT_DONE=1
fi
if [ "$CLAWDBOT_DONE" -eq 0 ] && [ -d "$HOME/.clawdbot/skills" ]; then
  install_skill_pair "$HOME/.clawdbot/skills" "Clawdbot skill"
  CLAWDBOT_DONE=1
fi

# ── Droid ──
DROID_DONE=0
if [ -d "${PWD}/.factory/skills" ]; then
  install_skill_pair "${PWD}/.factory/skills" "Droid project skill"
  DROID_DONE=1
fi
if [ "$DROID_DONE" -eq 0 ] && [ -d "$HOME/.factory/skills" ]; then
  install_skill_pair "$HOME/.factory/skills" "Droid skill"
  DROID_DONE=1
fi

# ── Windsurf ──
WINDSURF_DONE=0
if [ -d "${PWD}/.windsurf/skills" ]; then
  install_skill_pair "${PWD}/.windsurf/skills" "Windsurf project skill"
  WINDSURF_DONE=1
fi
if [ "$WINDSURF_DONE" -eq 0 ] && [ -d "$HOME/.codeium/windsurf/skills" ]; then
  install_skill_pair "$HOME/.codeium/windsurf/skills" "Windsurf skill"
  WINDSURF_DONE=1
fi
if [ "$WINDSURF_DONE" -eq 0 ]; then
  if [ -d "$HOME/.codeium" ] || [ -d "$HOME/Library/Application Support/Windsurf" ]; then
    WINDSURF_DIR="$HOME/.codeium/windsurf/memories"
    RULES_FILE="$WINDSURF_DIR/global_rules.md"
    mkdir -p "$WINDSURF_DIR"
    if [ -f "$RULES_FILE" ] && grep -q "# Kodus Review" "$RULES_FILE"; then
      print_success "Windsurf already updated (kodus-review)"
    else
      if [ -f "$RULES_FILE" ]; then
        printf "\n" >> "$RULES_FILE"
      fi
      printf "%s\n\n" "# Kodus Review" >> "$RULES_FILE"
      printf "%s\n" "$SKILL_CONTENT_REVIEW" >> "$RULES_FILE"
      printf "\n" >> "$RULES_FILE"
      print_success "Windsurf updated (kodus-review)"
    fi
    if [ -f "$RULES_FILE" ] && grep -q "# Kodus PR Suggestions Resolver" "$RULES_FILE"; then
      print_success "Windsurf already updated (kodus-pr-suggestions-resolver)"
    else
      if [ -f "$RULES_FILE" ]; then
        printf "\n" >> "$RULES_FILE"
      fi
      printf "%s\n\n" "# Kodus PR Suggestions Resolver" >> "$RULES_FILE"
      printf "%s\n" "$SKILL_CONTENT_RESOLVE" >> "$RULES_FILE"
      printf "\n" >> "$RULES_FILE"
      print_success "Windsurf updated (kodus-pr-suggestions-resolver)"
    fi
    if [ -f "$RULES_FILE" ] && grep -q "name: $BUSINESS_SKILL_NAME" "$RULES_FILE"; then
      print_success "Windsurf already updated ($BUSINESS_SKILL_NAME)"
    else
      if [ -f "$RULES_FILE" ]; then
        printf "\n" >> "$RULES_FILE"
      fi
      printf "%s\n\n" "# Kodus Business Rules Validation" >> "$RULES_FILE"
      printf "%s\n" "$SKILL_CONTENT_BUSINESS" >> "$RULES_FILE"
      printf "\n" >> "$RULES_FILE"
      print_success "Windsurf updated ($BUSINESS_SKILL_NAME)"
    fi
    OPTIONAL_INSTALLED=$((OPTIONAL_INSTALLED + 1))
    WINDSURF_DONE=1
  fi
fi

# ── Gemini CLI ──
GEMINI_DONE=0
if [ -d "${PWD}/.gemini/skills" ]; then
  install_skill_pair "${PWD}/.gemini/skills" "Gemini CLI project skill"
  GEMINI_DONE=1
fi
if [ "$GEMINI_DONE" -eq 0 ]; then
  if command -v gemini >/dev/null 2>&1 || [ -d "$HOME/.gemini" ]; then
    GEMINI_DIR="$HOME/.gemini/commands"
    mkdir -p "$GEMINI_DIR"
    install_gemini_toml "$GEMINI_DIR/kodus-review.toml" "Gemini CLI command" "kodus-review" "Review code with Kodus CLI" "$SKILL_CONTENT_REVIEW"
    install_gemini_toml "$GEMINI_DIR/kodus-pr-suggestions-resolver.toml" "Gemini CLI command" "kodus-pr-suggestions-resolver" "Resolve PR suggestions with Kodus CLI" "$SKILL_CONTENT_RESOLVE"
    install_gemini_toml "$GEMINI_DIR/$BUSINESS_SKILL_NAME.toml" "Gemini CLI command" "$BUSINESS_SKILL_NAME" "Validate PR business rules with Kodus CLI" "$SKILL_CONTENT_BUSINESS"
    GEMINI_DONE=1
  fi
fi

printf "\n"

if [ "$OPTIONAL_INSTALLED" -eq 0 ]; then
  print_dim "No additional tool locations detected."
  print_dim "Create a tool's skills directory and rerun to install automatically."
fi

print_header "Done"
print_info "Usage: kodus review [files...]"
print_info "Usage: kodus pr suggestions --pr-url <url>"
print_info "Usage: kodus pr business-validation --staged --task-id <id>"
printf "\n"
