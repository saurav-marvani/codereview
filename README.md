# Kodus CLI

AI-powered code review from your terminal.

## Installation

### npm (Recommended)

```bash
npm install -g @kodus/cli
```

### Via curl

```bash
curl -fsSL https://raw.githubusercontent.com/kodustech/cli/main/install.sh | bash
```

### Homebrew (Coming soon)

```bash
brew install kodus/tap/kodus
```

### Using npx (No installation)

```bash
npx @kodus/cli review
```

## Quick Start

```bash
# Run an interactive review (default mode)
kodus review

# Run a review on staged files (interactive)
kodus review --staged

# Run a review on a specific commit (interactive)
kodus review --commit HEAD~1

# Run a review comparing against another branch (interactive)
kodus review --branch main

# Run a review on specific files (interactive)
kodus review src/index.ts src/utils.ts

# Review using only configured rules (no general suggestions)
kodus review --rules-only

# Fast mode: quicker analysis (good for large diffs)
kodus review --fast

# Auto-fix: apply all fixable issues automatically
kodus review --fix

# Non-interactive modes:
# - JSON output
kodus review --format json

# - Markdown report
kodus review --format markdown

# - AI Agent mode (optimized for Claude Code, Cursor, etc)
kodus review --prompt-only
```

## Authentication

Sign up at **https://app.kodus.io** to create your account.

```bash
# Login with your account
kodus auth login

# Check authentication status
kodus auth status

# Logout
kodus auth logout

# Generate CI/CD token
kodus auth token
```

## Review Modes

### Interactive Mode (Default)
Navigate through issues and apply fixes interactively:

```bash
# Interactive mode is now the default
kodus review

# You can also explicitly enable it
kodus review --interactive
kodus review -i
```

Features:
- **File-first navigation**: Browse files with issue counts
- **Copy fix prompt**: Generate AI-friendly prompts for Claude Code, Cursor, etc.
- **One-by-one review**: See issues with detailed information
- **Preview fixes**: View changes before applying
- **Apply fixes**: Choose which fixes to apply
- **Live progress**: Track fixed vs remaining issues

### Auto-fix Mode
Automatically apply all fixable issues:

```bash
kodus review --fix
```

Features:
- Applies all auto-fixable issues at once
- Shows confirmation prompt before applying
- Reports success/failure for each fix

### AI Agent Mode
Optimized for AI coding agents (Claude Code, Cursor, Windsurf):

```bash
kodus review --prompt-only
```

Features:
- Minimal, structured output
- Easy to parse programmatically
- Includes fix code for auto-fixable issues
- Perfect for autonomous generate-review-fix loops

## Output Formats

```bash
# Interactive mode (default)
kodus review

# JSON output (non-interactive)
kodus review --format json

# Markdown report (non-interactive)
kodus review --format markdown

# AI Agent output (non-interactive)
kodus review --prompt-only

# Save to file (non-interactive)
kodus review --format markdown --output report.md

# Terminal output without interactivity
kodus review --format terminal --output report.txt
```

## Context-Aware Reviews

Kodus CLI automatically reads your project's context files to provide better, more relevant reviews:

**Auto-detected files:**
- `.cursorrules` - Cursor IDE rules
- `claude.md` / `.claude.md` - Claude Code guidelines
- `.kodus.md` / `.kodus/rules.md` - Kodus-specific rules

**Custom context:**
```bash
# Include custom context file
kodus review --context path/to/custom-guidelines.md
```

This ensures reviews follow your team's standards, coding patterns, and architectural preferences.

## Configuration

When logged in, the CLI fetches your configuration from the Kodus platform:

```bash
# View active configuration
kodus config

# Review with only your configured rules
kodus review --rules-only
```

### Flags

| Flag | Description | Use Case |
|------|-------------|----------|
| (none) | Interactive mode (default) | Local development, manual review |
| `--rules-only` | Only check configured rules | Team standards, CI/CD |
| `--fast` | Faster analysis with lighter checks | Large diffs, quick feedback |
| `--staged` | Analyze only staged files | Pre-commit |
| `--interactive` / `-i` | Explicitly enable interactive mode | When combined with other flags |
| `--fix` | Auto-apply all fixable issues | Quick fixes, automation |
| `--prompt-only` | AI agent optimized output | Claude Code, Cursor integration |
| `--context <file>` | Include custom context file | Project-specific guidelines |
| `--format json` | Output as JSON (non-interactive) | Automation, integrations |
| `--output <file>` | Save to file (non-interactive) | Reports, CI/CD artifacts |

**Examples:**

```bash
# Pre-commit: interactive check on staged files (default)
kodus review --staged

# CI/CD: strict rules only, JSON output
kodus review --rules-only --format json

# Quick feedback on large changes (still interactive)
kodus review --fast

# Auto-fix all issues in staged files
kodus review --staged --fix

# AI agent workflow (non-interactive)
kodus review --prompt-only

# Custom context with interactive mode (default)
kodus review --context .github/GUIDELINES.md

# Copy fix prompts and paste into Claude Code
kodus review  # Select file → "Copy fix prompt for AI agent"
```

## AI Agent Integration

Kodus CLI works seamlessly with AI coding agents like **Claude Code**, **Cursor**, and **Windsurf**.

### Interactive Mode with Copy Prompt (Recommended)

The easiest way to use with AI agents:

```bash
# 1. Run interactive review
kodus review

# 2. Navigate to a file with issues
# 3. Select "Copy fix prompt for AI agent"
# 4. Paste into Claude Code/Cursor
# 5. AI automatically fixes the issues
```

The copied prompt includes:
- File path
- All issues with line numbers and severity
- Detailed suggestions and recommendations
- AI-optimized formatting

### Automated Mode with --prompt-only

For fully automated workflows:

Add this to your `.cursorrules` or prompt:

```
When writing code:
1. Implement the feature
2. Run: kodus review --prompt-only
3. If issues are found, fix them automatically
4. Repeat until review is clean
5. Show final result
```

Claude Code will automatically run reviews and fix issues in a loop.

### Using with Cursor

Similar workflow - the AI agent can autonomously:
- Generate code
- Review with `kodus review --prompt-only`
- Parse the structured output
- Apply fixes
- Iterate until clean

### Benefits
- ✅ Catch issues during development, not after
- ✅ Autonomous fix loops (no manual intervention)
- ✅ Consistent with team standards
- ✅ Faster development cycles

## Trial Mode

Without an account, you can use the CLI with rate limits:

- 5 reviews per day
- 10 files per review
- 500 lines per file

Sign up for free to remove these limits.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development
npm run dev

# Test locally
node dist/index.js review
```

## Telemetry

Kodus CLI collects anonymous usage data to help improve the product. We take privacy seriously:

**What we collect:**
- Command usage (which commands you run)
- Feature usage (interactive mode, fix mode, etc)
- Performance metrics (review duration, files analyzed)
- Error events (to improve reliability)

**What we DON'T collect:**
- Your code or file contents
- File names or paths (only basenames)
- Passwords, tokens, or secrets
- Any personally identifiable information

### Managing Telemetry

```bash
# Check telemetry status
kodus telemetry status

# Disable telemetry (opt-out)
kodus telemetry disable

# Enable telemetry
kodus telemetry enable
```

### Environment Variables

You can also control telemetry via environment variables:

```bash
# Disable telemetry
export KODUS_TELEMETRY=false

# Or use standard DO_NOT_TRACK
export DO_NOT_TRACK=1
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KODUS_API_URL` | API endpoint (default: https://api.kodus.io) |
| `KODUS_MOCK` | Set to `true` to use mock API |
| `KODUS_TOKEN` | CI/CD token for non-interactive environments |
| `KODUS_TELEMETRY` | Set to `false` to disable telemetry |
| `DO_NOT_TRACK` | Set to `1` to disable telemetry |
| `POSTHOG_API_KEY` | Custom PostHog API key |
| `POSTHOG_HOST` | Custom PostHog host |

## License

MIT

