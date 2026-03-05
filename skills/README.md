# Kodus Skills

This directory contains the agent skills shipped with the Kodus CLI repository.

## Included Skills

- `kodus-review`
    - Run local Kodus code review for workspace changes with the installed CLI.
- `kodus-review-dev`
    - Run the local Kodus CLI build against a dev API using `scripts/run-local-cli.sh`.
- `business-rules-validation`
    - Trigger business rules validation in PR mode or local diff mode with `@kody -v business-logic`.
- `kodus-pr-suggestions-resolver`
    - Fetch PR suggestions and apply fixes with judgment.

## Trigger Map (recommended)

- User mentions `review`, `commit`, `push`, `open PR`, `merge`, `quality gate`
    - Prefer `kodus-review` (or `kodus-review-dev` for local dev CLI flow).
    - If the request is delivery action (commit/push/merge) and no fresh review ran, ask to run Kodus review first.
- User mentions `business validation`, `acceptance criteria`, `PR vs task`, `@kody -v business-logic`
    - Use `business-rules-validation`.
- User asks to apply Kodus PR suggestions
    - Use `kodus-pr-suggestions-resolver`.

## Notes

- Skill source lives in `skills/<skill-name>/SKILL.md`.
- Some skills include helper scripts in `skills/<skill-name>/scripts/`.
- Packaging these files in the npm artifact makes them available to external installers and local integration tooling.
- Shipping the files here does not, by itself, install them into Claude Code, Cursor, Codex, or other agents. That installation step still depends on the integration tooling you use.
- `kodus update` upgrades the CLI package only. Skill sync/deployment should be done via the installer tooling (for example `curl -fsSL https://review-skill.com/install | bash`).

## For Integrators

- Validate skill structure and metadata:
    - `npm run skills:validate`
- Generate prompt metadata as XML (`<available_skills>`):
    - `npm run skills:prompt`
- Generate prompt metadata as JSON:
    - `npm run skills:prompt:json`

Recommended injection pattern:

1. Run `npm run skills:prompt` during session bootstrap or before each agent request.
2. Inject the XML payload into your system/developer prompt under a section such as `Available skills`.
3. Map user intent to the listed skill `name` and load the corresponding `SKILL.md` only when needed.
