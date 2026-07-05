import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LESSONS_PATH, projectLessonsPath } from './state.js';
import { getEnv } from './config.js';
import {
    dumpPlaybook,
    parsePlaybook,
    wrapCommand,
    type Playbook,
} from './playbook.js';
import { sshExec, truncateForModel } from './ssh.js';
import { RUNS_DIR, type PreviewState } from './state.js';

/**
 * Devin-style environment detection: an agent with a shell on the VM
 * explores the customer repo, tries to boot the environment, iterates until
 * tests run, and emits a playbook (.kody/environment.yml) so subsequent runs
 * are deterministic and token-free.
 */

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TURNS = 120;

const SYSTEM_PROMPT = `You are Kody's environment-detection agent. You have root shell access (via the bash tool) to a fresh Ubuntu 24.04 VM with Docker, docker compose, git, curl and jq preinstalled. A customer's repository has been cloned; every bash command you run already starts at the repository root with the customer's env file (if provided) exported.

Your mission, in order:
1. EXPLORE: understand the project — language(s), package manager, frameworks, services it depends on (databases, queues, caches), how it is built and tested. Read manifests (package.json, pyproject.toml, go.mod, Gemfile, pom.xml, Makefile, docker-compose*.yml, Dockerfile, CI workflows under .github/workflows or similar — CI configs are the best source of truth for how to build and test).
2. PROVISION: install the required toolchain versions (use official installers or apt; mise/nvm/pyenv if versions are pinned). Start required backing services — prefer the repo's own docker-compose if present, otherwise run official Docker images (postgres, redis, etc.) with credentials matching what the app expects.
3. BOOT: install dependencies, run migrations/seeds if needed, build the project.
4. VERIFY — actually USE the environment, don't just boot it:
   a. Run the repo's test suite if one exists (or a meaningful subset if huge — prefer unit tests first). A partially failing suite can still be success if failures are clearly pre-existing/flaky and the environment itself works.
   b. ALWAYS also exercise the application's core user flows end-to-end against the running app: make real requests that create/read data (e.g. for an API: POST a resource, GET it back, verify the response body; follow redirects; check side effects landed in the database). Each check must be a real assertion — a command that exits non-zero when the expected behavior does not happen (curl + grep/jq -e, psql -c + grep, etc.). "The server is up" is NOT verification.
   c. If the project has a web UI, ALSO verify it in a real browser. Playwright + headless Chromium are preinstalled globally: write a small Node script and run it with NODE_PATH=$(npm root -g) node script.mjs (import { chromium } from 'playwright'; launch with { headless: true }). Drive the actual UI flows a user would (load pages, fill forms, click through wizards/login, create data through the UI), assert on rendered content, and fail the script on page errors or failed expectations (collect page.on('console')/'pageerror' for diagnostics). In the playbook's test phase the browser check must be SELF-CONTAINED: one command that first writes the script via heredoc (cat > /opt/kody/ui-check.mjs <<'EOF' ... EOF) and then runs it — so it reproduces on a fresh VM.
   d. Record evidence of browser verification. Every browser script must write artifacts under /opt/kody/artifacts/: launch the context with recordVideo: { dir: '/opt/kody/artifacts/video' } AND wrap the flow in a Playwright trace (context.tracing.start({ screenshots: true, snapshots: true }) ... context.tracing.stop({ path: '/opt/kody/artifacts/trace-<flow>.zip' })). Name artifacts after the flow they verify. Also save a final full-page screenshot per flow (page.screenshot({ path: '/opt/kody/artifacts/<flow>.png', fullPage: true })).
5. Call finish with a playbook capturing the *reproducible* path you found. The playbook's test phase must contain those executable assertions (suite + functional flows), so a future run proves the environment WORKS, not merely boots.

Rules:
- Missing env vars: check which are required (env.example, config loaders, CI). Use values from the customer env file when present; invent safe local defaults only for infrastructure you started yourself (e.g. DATABASE_URL pointing at your own postgres container). Never invent third-party API credentials — if a test needs them and they're absent, note it in the playbook summary and skip those tests.
- Be economical with output: pipe long output through tail/head, use --quiet flags. You see at most ~12k chars per command.
- Long installs/builds are fine, but set a generous timeout_seconds when you expect them.
- If something fails, read the error and fix the environment; do not brute-force retry the same command.
- The playbook you emit must work on a FRESH identical VM whose ONLY preinstalled tools are: git, curl, jq, docker, node, npm, corepack, and headless playwright/chromium. NOTHING you install or enable during exploration persists to that fresh VM. So if you used pnpm/yarn/pipenv/poetry/a specific node version/a global CLI/a system package, the FIRST thing your setup phase must do is install/enable it (e.g. \`corepack enable\` for pnpm, \`npm i -g yarn\`, apt-get for a system lib). The single most common failure is a playbook that opens with \`pnpm ...\` but never enabled pnpm — it dies with exit 127 on line 1. Explicitly capture every toolchain prerequisite.
- Do NOT include host-level build steps that only worked because of ambient state. In particular, for a DOCKER-based app whose 'services' phase builds and boots the app via docker compose, the containers ARE the build — do not add a redundant host \`<pkg> run build\` (it often fails, e.g. a monorepo root \`nest build\` can't find src/main.ts). The trustworthy "it works" signal for a docker app is the containers reporting healthy, not a host build. Only include a host build if the app actually runs from a host build you exercised.
- Prefer capturing what you ACTUALLY did over what "should" work: if you ran \`corepack enable && pnpm install\` during exploration and it succeeded, that exact pair belongs in setup. A step you ran that "just worked" is exactly the step most likely to be missing from your playbook.
- The playbook you emit must work on a FRESH identical VM: include every command that was actually required (toolchain install, services, deps, build, test), in the phases setup/services/build/test. Commands run at the repo root with the customer env sourced. Do not include exploration commands.
- Never put a command in the playbook that you have not executed EXACTLY as written (same URLs, same flags, same waits). Before calling finish, re-run each playbook test command verbatim and confirm exit 0 — a plausible-looking but unverified check (wrong health endpoint, too-short boot wait) is worse than no check. Waits for first boot must be generous (migrations/index building can take minutes) and long-running processes you start must be stopped even when a check fails (trap/cleanup), so a re-run is idempotent.
- requiredEnv lists env var NAMES the customer must supply (never values).

Call finish exactly once, when you either succeeded or are certain you cannot proceed (success=false, explain why in summary). In finish.lessons, report new NON-OBVIOUS, GENERALIZABLE lessons you learned the hard way in this run (tooling gotchas, timing traps, API/version pitfalls) — one line each, project-specific lessons prefixed with the project name. Do not repeat lessons you were already given.`;

function readFileIfExists(path: string): string {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

/**
 * Builds the lessons block for a prompt: global (cross-project tooling
 * gotchas) plus, when a repo is given, that project's own accumulated
 * knowledge (how to boot it, its quirks) — so project-specific recipes
 * don't pollute other projects' runs.
 */
export function loadLessons(repoUrl?: string): string {
    const global = readFileIfExists(LESSONS_PATH);
    const project = repoUrl ? readFileIfExists(projectLessonsPath(repoUrl)) : '';
    let out = '';
    if (global) {
        out += `\n\nLessons from previous runs — apply them, do not relearn the hard way:\n${global}`;
    }
    if (project) {
        out += `\n\nProject-specific knowledge for THIS repository (how it builds/boots and its quirks):\n${project}`;
    }
    return out;
}

/**
 * Appends deduped lessons. With a repoUrl, they go to that project's file
 * (operational/boot knowledge specific to the repo); without one, to the
 * global file (generic technique/tooling lessons).
 */
export function appendLessons(lessons: string[] | undefined, repoUrl?: string): void {
    if (!lessons?.length) return;
    const path = repoUrl ? projectLessonsPath(repoUrl) : LESSONS_PATH;
    const existing = readFileIfExists(path);
    const fresh = lessons
        .map((l) => l.trim().replace(/^[-*]\s*/, ''))
        .filter((l) => l && !existing.includes(l.slice(0, 60)));
    if (!fresh.length) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, fresh.map((l) => `- ${l}`).join('\n') + '\n');
    console.log(`\n[lessons] recorded ${fresh.length} new lesson(s) in ${path}`);
}

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'bash',
        description:
            'Run a shell command on the VM as root. Starts at the repo root with the customer env file exported. Returns exit code and truncated output.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string' },
                timeout_seconds: {
                    type: 'number',
                    description: 'Kill the command after this long. Default 300.',
                },
            },
            required: ['command'],
        },
    },
    {
        name: 'finish',
        description: 'Report the final result and the reproducible playbook.',
        input_schema: {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                summary: {
                    type: 'string',
                    description:
                        'What the project is, what you set up, test results, caveats.',
                },
                playbook_yaml: {
                    type: 'string',
                    description:
                        'YAML playbook: version, summary, requiredEnv, setup, services, build, test, healthcheck.',
                },
                lessons: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'New non-obvious generalizable lessons from this run (persisted for future runs).',
                },
            },
            required: ['success', 'summary', 'playbook_yaml'],
        },
    },
];

export interface DetectResult {
    success: boolean;
    summary: string;
    playbook: Playbook | null;
    turns: number;
    transcriptPath: string;
}

export async function detectEnvironment(
    state: PreviewState,
    opts: { model?: string; hint?: string } = {},
): Promise<DetectResult> {
    const model = opts.model ?? getEnv('PREVIEW_AGENT_MODEL') ?? DEFAULT_MODEL;
    // Any Anthropic-surface endpoint works (BYOK-friendly): kimi-* models
    // default to Moonshot's coding endpoint, otherwise Anthropic proper.
    const isKimi = model.startsWith('kimi');
    const baseURL =
        getEnv('PREVIEW_AGENT_BASE_URL') ??
        // SDK appends /v1/messages itself, so no /v1 suffix here.
        (isKimi ? 'https://api.kimi.com/coding' : undefined);
    const apiKey =
        getEnv('PREVIEW_AGENT_API_KEY') ??
        (isKimi
            ? getEnv('KIMI_CODING_PLAN_KEY')
            : (getEnv('ANTHROPIC_API_KEY') ?? getEnv('BYOK_ANTHROPIC_API_KEY')));
    if (!apiKey) {
        throw new Error(
            `No API key for model '${model}' (checked PREVIEW_AGENT_API_KEY, ${isKimi ? 'KIMI_CODING_PLAN_KEY' : 'ANTHROPIC_API_KEY/BYOK_ANTHROPIC_API_KEY'})`,
        );
    }
    const client = new Anthropic({ apiKey, baseURL });

    const runDir = join(RUNS_DIR, state.name);
    mkdirSync(runDir, { recursive: true });
    const transcriptPath = join(
        runDir,
        `detect-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    );
    const logLine = (obj: unknown) =>
        appendFileSync(transcriptPath, JSON.stringify(obj) + '\n');

    const envNote = state.envFileUploaded
        ? 'A customer env file was uploaded and is exported into every command.'
        : 'No customer env file was provided.';
    const messages: Anthropic.MessageParam[] = [
        {
            role: 'user',
            content:
                `Repository: ${state.repoUrl ?? 'unknown'} (cloned at ${state.repoDir ?? '/opt/repo'}). ${envNote}` +
                (opts.hint ? `\nOperator hint: ${opts.hint}` : '') +
                '\nUnderstand this environment, get it running, run the tests, then call finish.',
        },
    ];

    // Heavy apps (Java/Spring, Rails, big monorepos) tend to make the agent
    // give up EARLY — call finish(success=false) with a placeholder summary
    // while it was actually making progress and had ~100 turns left. Bounce the
    // first such premature give-up once, telling it to push through.
    let bouncedFinish = false;
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const response = await client.messages.create({
            model,
            max_tokens: 8192,
            system: SYSTEM_PROMPT + loadLessons(state.repoUrl),
            tools: TOOLS,
            messages,
        });
        logLine({ turn, role: 'assistant', content: response.content });

        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
        if (text.trim()) console.log(`\n[agent:${turn}] ${text.trim()}`);

        const toolUses = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (!toolUses.length) {
            // Model stopped without finish — nudge it once.
            messages.push(
                { role: 'assistant', content: response.content },
                {
                    role: 'user',
                    content:
                        'Continue. Use the bash tool to keep working, or call finish if you are done.',
                },
            );
            continue;
        }

        messages.push({ role: 'assistant', content: response.content });
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUses) {
            if (toolUse.name === 'finish') {
                const input = toolUse.input as {
                    success: boolean;
                    summary: string;
                    playbook_yaml: string;
                    lessons?: string[];
                };
                appendLessons(input.lessons, state.repoUrl);
                let playbook: Playbook | null = null;
                try {
                    playbook = parsePlaybook(input.playbook_yaml);
                } catch (e: any) {
                    // Invalid playbook: bounce it back once instead of dying.
                    logLine({ turn, invalidPlaybook: e.message });
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content: `Playbook YAML invalid: ${e.message}. Fix it and call finish again.`,
                        is_error: true,
                    });
                    continue;
                }
                // Bounce a PREMATURE give-up: success=false (or a placeholder
                // summary) with plenty of turns left usually means the agent
                // stalled on a heavy app, not that the env is unbuildable. Push
                // it once more instead of recording a failure.
                const placeholder =
                    /placeholder|exploration in progress|still exploring|accidentally|need to (continue|keep|gather)|in progress/i.test(
                        input.summary ?? '',
                    );
                if (
                    (!input.success || placeholder) &&
                    !bouncedFinish &&
                    turn < MAX_TURNS - 15
                ) {
                    bouncedFinish = true;
                    logLine({ turn, bouncedFinish: input.summary });
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        content:
                            "Don't give up yet — you have many turns left and heavy apps (Java/Maven, Rails/bundler, large monorepos, .NET) just need persistence. Keep going: install whatever toolchain/deps are missing, start the required backing services, build, boot the app, and run its tests. Only call finish(success=false) if you've genuinely hit an unrecoverable blocker and can state the specific error. Otherwise continue with the bash tool now.",
                        is_error: true,
                    });
                    continue;
                }
                logLine({ turn, finish: input });
                return {
                    success: input.success,
                    summary: input.summary,
                    playbook,
                    turns: turn,
                    transcriptPath,
                };
            }

            const input = toolUse.input as {
                command: string;
                timeout_seconds?: number;
            };
            console.log(`\n[bash:${turn}] $ ${input.command}`);
            const res = await sshExec(state, wrapCommand(state, input.command), {
                timeoutMs: (input.timeout_seconds ?? 300) * 1000,
            });
            const rendered =
                `exit_code: ${res.exitCode}${res.timedOut ? ' (TIMED OUT)' : ''} (${Math.round(res.durationMs / 1000)}s)\n` +
                truncateForModel(
                    [res.stdout, res.stderr && `--- stderr ---\n${res.stderr}`]
                        .filter(Boolean)
                        .join('\n'),
                );
            console.log(
                `[bash:${turn}] exit ${res.exitCode} in ${Math.round(res.durationMs / 1000)}s`,
            );
            logLine({ turn, tool: 'bash', input, exitCode: res.exitCode });
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: rendered,
                is_error: res.exitCode !== 0,
            });
        }
        messages.push({ role: 'user', content: toolResults });
    }

    return {
        success: false,
        summary: `Agent hit the ${MAX_TURNS}-turn limit without calling finish.`,
        playbook: null,
        turns: MAX_TURNS,
        transcriptPath,
    };
}

const DIAGNOSE_SYSTEM_PROMPT = `You are Kody's failure-diagnosis agent. You have root shell access (via the bash tool) to a VM where a customer repository is checked out at the repo root (every command starts there, with the customer env file exported). The environment was previously validated as working; now one or more verification tests FAIL. The working-tree diff (git diff) represents the pull request under review — the failure was most likely introduced by it.

Investigate hands-on: reproduce the failing check, inspect the PR diff, read the relevant code, add temporary instrumentation if needed (revert it afterwards). Then call finish with:
- root_cause: precise explanation of the defect
- file: the file (and line if possible) where the bug lives
- suggested_fix: a concrete minimal fix (diff-style or exact code)
- confidence: high|medium|low

Rules: be economical with output (~12k chars/command visible). Do not fix the bug permanently — diagnosis only. Call finish exactly once.`;

const DIAGNOSE_TOOLS: Anthropic.Tool[] = [
    TOOLS[0], // bash
    {
        name: 'finish',
        description: 'Report the diagnosis.',
        input_schema: {
            type: 'object',
            properties: {
                root_cause: { type: 'string' },
                file: { type: 'string' },
                suggested_fix: { type: 'string' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['root_cause', 'file', 'suggested_fix', 'confidence'],
        },
    },
];

export interface DiagnoseResult {
    rootCause: string;
    file: string;
    suggestedFix: string;
    confidence: string;
    turns: number;
    transcriptPath: string;
}

export async function diagnoseFailure(
    state: PreviewState,
    failureReport: string,
    opts: { model?: string } = {},
): Promise<DiagnoseResult> {
    const model = opts.model ?? getEnv('PREVIEW_AGENT_MODEL') ?? DEFAULT_MODEL;
    const isKimi = model.startsWith('kimi');
    const baseURL =
        getEnv('PREVIEW_AGENT_BASE_URL') ??
        (isKimi ? 'https://api.kimi.com/coding' : undefined);
    const apiKey =
        getEnv('PREVIEW_AGENT_API_KEY') ??
        (isKimi
            ? getEnv('KIMI_CODING_PLAN_KEY')
            : (getEnv('ANTHROPIC_API_KEY') ?? getEnv('BYOK_ANTHROPIC_API_KEY')));
    if (!apiKey) throw new Error(`No API key for model '${model}'`);
    const client = new Anthropic({ apiKey, baseURL });

    const runDir = join(RUNS_DIR, state.name);
    mkdirSync(runDir, { recursive: true });
    const transcriptPath = join(
        runDir,
        `diagnose-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    );
    const logLine = (obj: unknown) =>
        appendFileSync(transcriptPath, JSON.stringify(obj) + '\n');

    const messages: Anthropic.MessageParam[] = [
        {
            role: 'user',
            content: `Failing verification report:\n${failureReport}\n\nThe PR under review is the current git working-tree diff. Find the root cause.`,
        },
    ];

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const response = await client.messages.create({
            model,
            max_tokens: 8192,
            system: DIAGNOSE_SYSTEM_PROMPT + loadLessons(),
            tools: DIAGNOSE_TOOLS,
            messages,
        });
        logLine({ turn, role: 'assistant', content: response.content });
        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
        if (text.trim()) console.log(`\n[agent:${turn}] ${text.trim()}`);

        const toolUses = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (!toolUses.length) {
            messages.push(
                { role: 'assistant', content: response.content },
                { role: 'user', content: 'Continue investigating, or call finish.' },
            );
            continue;
        }
        messages.push({ role: 'assistant', content: response.content });
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUses) {
            if (toolUse.name === 'finish') {
                const input = toolUse.input as any;
                logLine({ turn, finish: input });
                return {
                    rootCause: input.root_cause,
                    file: input.file,
                    suggestedFix: input.suggested_fix,
                    confidence: input.confidence,
                    turns: turn,
                    transcriptPath,
                };
            }
            const input = toolUse.input as {
                command: string;
                timeout_seconds?: number;
            };
            console.log(`\n[bash:${turn}] $ ${input.command}`);
            const res = await sshExec(state, wrapCommand(state, input.command), {
                timeoutMs: (input.timeout_seconds ?? 300) * 1000,
            });
            console.log(
                `[bash:${turn}] exit ${res.exitCode} in ${Math.round(res.durationMs / 1000)}s`,
            );
            logLine({ turn, tool: 'bash', input, exitCode: res.exitCode });
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content:
                    `exit_code: ${res.exitCode}${res.timedOut ? ' (TIMED OUT)' : ''}\n` +
                    truncateForModel(
                        [res.stdout, res.stderr && `--- stderr ---\n${res.stderr}`]
                            .filter(Boolean)
                            .join('\n'),
                    ),
                is_error: res.exitCode !== 0,
            });
        }
        messages.push({ role: 'user', content: toolResults });
    }
    throw new Error(`Diagnosis hit the ${MAX_TURNS}-turn limit`);
}

const VALIDATE_SYSTEM_PROMPT = `You are Kody's PR-validation agent. You have root shell access (via the bash tool) to a VM where the customer repository is checked out at the repo root (commands start there, customer env exported). The working environment (toolchain, deps, build) is already set up. The pull request under review is the current git working-tree diff (git diff shows it); you also get the PR title and description.

Your mission: decide whether this PR introduces bugs — by ACTUALLY EXERCISING the affected behavior, not by code reading alone. Be ADVERSARIAL, not confirmatory: the PR description is the author's claim, possibly wrong or incomplete. Your job is to try to BREAK it, not to reproduce the happy path it describes.
1. Read the PR description and diff. List the behaviors it touches and every claim it makes.
2. For EACH claim, construct the input MOST LIKELY TO FALSIFY IT — deliberately hit the boundary the description hand-waves or excludes. Concretely:
   - When a claim says "X is handled correctly", test the value that would expose X being handled WRONG, not one that trivially passes.
   - When the diff transforms one side of a comparison but EXCLUDES the other (e.g. lowercases input but not the pattern; trims one field not the other; casts one operand), test whether the two sides are now INCONSISTENT — that asymmetry is the classic bug. Do not reuse an input that already satisfies both sides (e.g. a regex that already carries an 'i' flag hides a missing-'i' bug — use a pattern with an uppercase literal and lowercase-only input, and vice-versa).
   - Test the inverse/negated operator too (a bug in a predicate usually inverts into a false positive in its negation).
   - Cover empty/null/boundary and, for anything touching eval/templating/paths/auth, the malicious input (injection, traversal, scope bypass).
   Existing unit tests passing means little — they encode the OLD assumptions and rarely cover the new edge. Write NEW probes.
3. Execute the checks. Prefer end-to-end through the running app (API or UI — playwright+chromium available); a direct probe of the changed function (import the built/source module in a test/script) is acceptable and often the sharpest way to hit the exact edge. For any bug you report, show the executed repro (command + observed vs expected).
4. Call finish with verdict and bugs. Every bug: what you ran, expected vs actual, and the file/line responsible. Do NOT report style/hypotheticals you could not reproduce. A clean APPROVE is only valid if you actually TRIED the falsifying inputs and they behaved correctly — list them in the summary.

Rules: be economical with output (~12k chars visible per command). Long boots need generous waits. Kill any server you start when done (kill by pid file or port, never pkill -f). If the PR is fine, say so — a clean verdict with evidence of what you exercised is a valid outcome. Call finish exactly once.`;

/**
 * Redacted, diff-only reviewer. Prior art (empirically measured) shows that
 * an author's benign framing in the PR metadata cuts LLM vuln detection by
 * 16-93pp with a strong false-negative bias; the proven mitigation is to
 * withhold the PR's stated intent and force diff-only analysis. This prompt
 * gives the reviewer no title/description at all — only the code change —
 * and an explicit security-first, assume-nothing lens.
 */
const VALIDATE_REDACTED_SYSTEM_PROMPT = `You are Kody's independent PR-validation agent. You have root shell access (via the bash tool) to a VM where the customer repository is checked out at the repo root; the environment (toolchain, deps, build) is already set up. The change under review is the current git working-tree diff (git diff shows it). You are given NO title, NO description, and NO stated intent — deliberately. Do not speculate about what the author wanted. Judge ONLY what the code now does.

Your mission: determine whether this change is safe and correct — by EXERCISING the affected behavior, assuming nothing.
1. From the diff alone, identify every behavior the code now exhibits and, crucially, every guarantee it might now BREAK. If the diff touches anything security-relevant (auth, permissions, input validation, sanitization, SSRF/URL/host allow-or-block logic, path handling, crypto, deserialization, command/DB construction), your FIRST duty is to check whether that protection still holds — regardless of how reasonable the change looks.
2. For each such control, construct the input a malicious actor would use and verify the control still stops it: e.g. for URL/host filtering, try loopback (127.0.0.1), link-local / cloud metadata (169.254.169.254), and internal ranges; for auth, try acting as the wrong/lower-privilege principal; for path handling, try traversal (../); for injection, try a payload. Run it against the RUNNING app (API or UI) and observe. If a \`.kody/fixtures.md\` file exists at the repo root, READ IT FIRST — it documents pre-seeded test accounts and data (e.g. two users and a resource owned by one) with credentials, so you can perform a multi-principal attack (act as the wrong user) directly instead of building that state from scratch. Prefer the fixtures over re-seeding the database yourself.
3. A change that ALLOWS something previously blocked by a security control is a security regression even if it looks like a convenience/feature — name it as such (e.g. "reintroduces SSRF: X is now reachable"), with the executed repro and its concrete impact (what an attacker reaches).
4. DATA BUGS — the class static review and a bare HTTP 200 both miss. If the diff touches any data layer (SQL/ORM queries, filters/WHERE, JOINs, GROUP BY/aggregations/COUNT, pagination/ORDER BY, migrations, data transforms/serialization, upserts, soft-delete, tenant/user scoping of queries), the defect almost always only manifests WITH DATA — so you must create data and inspect the database, not just call the endpoint:
   a. SEED representative rows first: multiple tenants/users, boundary values (0, null, empty, duplicates, unicode), and rows that SHOULD and SHOULD NOT be returned. Use the app's own seed/factory/migration scripts if present, else create via the API/ORM, else INSERT directly.
   b. Exercise the changed path, then QUERY THE DATABASE DIRECTLY (psql / sqlite3 / mysql / mongosh — find the connection string in the env/config) and compare actual rows/counts to what you computed by hand. NEVER trust the endpoint's own response as proof of correctness — a wrong query returns wrong data with a 200. A counter that reads 5 when you created 3 visits, an aggregate off by the boundary row, a filter that drops matching rows — these only show in the DB.
   c. DATA LEAKAGE (query-level tenant isolation): seed rows for user/tenant A and user/tenant B, run the changed read/list as B, and verify B cannot see A's rows. A missing \`WHERE tenant_id = ?\` is a data breach even when auth passes.
   d. MIGRATIONS: run the migration forward on seeded data and check NO existing row is lost, truncated, or mistyped (column-by-column); check reversibility if a down migration exists.
5. Also cover correctness: falsifying inputs, negated operators, empty/boundary. Existing unit tests passing is weak evidence — they encode old assumptions; a diff that makes tests fail may mean the diff is wrong OR the tests are stale, so judge behavior directly, never defer to the test's expectation.
6. EXECUTION IS MANDATORY for any finding. Reasoning from the diff or from failing unit tests is NOT sufficient to report a finding as confirmed — you must OBSERVE the defect by running code. For a changed function, build the affected package and execute the real compiled code on the malicious input (e.g. \`node -e\` requiring the built module and calling the changed function / validator on the attack value, printing the actual result), or drive the running app end-to-end. Put the exact command and its real output in the finding's evidence. If you could only reason about a concern but not execute it, say so explicitly and mark it unconfirmed — do not present it as proven.
   STOP AT THE CHEAPEST CONCLUSIVE PROOF. Prefer isolating the changed unit (call the query/function directly via \`node -e\` / a REPL against the real DB and print the raw result) over a full authenticated UI/API flow. Once the isolated execution unambiguously shows the defect (e.g. the query returns \`[{"count(*)":3}]\` so the destructured \`count\` is undefined), that is sufficient — do NOT then spend many turns reproducing it through login/JWT/cookies/end-to-end. Reach for the full end-to-end flow only when the isolated result is genuinely ambiguous or the bug is inherently cross-layer. Budget your turns; fighting auth to gild an already-proven finding is wasted.
7. Call finish with verdict and findings. Every finding: the command you RAN, its real output, expected vs actual, file/line, and — for security — the concrete attacker impact. request_changes only for defects you reproduced by execution.

Rules: be economical (~12k chars/command). Generous waits for boots/builds. Kill servers you start by pid/port (never pkill -f). Call finish exactly once.`;

const VALIDATE_TOOLS: Anthropic.Tool[] = [
    TOOLS[0], // bash
    {
        name: 'finish',
        description: 'Report the validation verdict.',
        input_schema: {
            type: 'object',
            properties: {
                verdict: { type: 'string', enum: ['approve', 'request_changes'] },
                summary: { type: 'string', description: 'What was exercised and how.' },
                bugs: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            description: { type: 'string' },
                            evidence: { type: 'string', description: 'Executed repro: command(s), expected vs actual.' },
                            file: { type: 'string' },
                            severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
                        },
                        required: ['description', 'evidence', 'file', 'severity'],
                    },
                },
                lessons: { type: 'array', items: { type: 'string' } },
            },
            required: ['verdict', 'summary', 'bugs'],
        },
    },
];

export interface ValidateResult {
    verdict: string;
    summary: string;
    bugs: Array<{ description: string; evidence: string; file: string; severity: string }>;
    turns: number;
    transcriptPath: string;
}

export async function validatePr(
    state: PreviewState,
    pr: { title: string; description: string },
    opts: { model?: string; redact?: boolean } = {},
): Promise<ValidateResult> {
    const model = opts.model ?? getEnv('PREVIEW_AGENT_MODEL') ?? DEFAULT_MODEL;
    const isKimi = model.startsWith('kimi');
    const baseURL =
        getEnv('PREVIEW_AGENT_BASE_URL') ??
        (isKimi ? 'https://api.kimi.com/coding' : undefined);
    const apiKey =
        getEnv('PREVIEW_AGENT_API_KEY') ??
        (isKimi
            ? getEnv('KIMI_CODING_PLAN_KEY')
            : (getEnv('ANTHROPIC_API_KEY') ?? getEnv('BYOK_ANTHROPIC_API_KEY')));
    if (!apiKey) throw new Error(`No API key for model '${model}'`);
    const client = new Anthropic({ apiKey, baseURL });

    const runDir = join(RUNS_DIR, state.name);
    mkdirSync(runDir, { recursive: true });
    const transcriptPath = join(
        runDir,
        `validate-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
    );
    const logLine = (obj: unknown) =>
        appendFileSync(transcriptPath, JSON.stringify(obj) + '\n');

    const systemPrompt = opts.redact
        ? VALIDATE_REDACTED_SYSTEM_PROMPT
        : VALIDATE_SYSTEM_PROMPT;
    const firstMessage = opts.redact
        ? `The change under review is the current git working-tree diff (run 'git diff'). No description is provided by design. Analyze the diff, exercise the affected behavior on the running app, and call finish with your verdict.`
        : `PR title: ${pr.title}\n\nPR description:\n${pr.description}\n\nThe PR's changes are the current git working-tree diff. Validate this PR hands-on and call finish with your verdict.`;
    const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: firstMessage },
    ];
    let bounced = false; // harness-enforced execution grounding: one bounce max

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const response = await client.messages.create({
            model,
            max_tokens: 8192,
            system: systemPrompt + loadLessons(),
            tools: VALIDATE_TOOLS,
            messages,
        });
        logLine({ turn, role: 'assistant', content: response.content });
        const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
        if (text.trim()) console.log(`\n[agent:${turn}] ${text.trim()}`);

        const toolUses = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (!toolUses.length) {
            messages.push(
                { role: 'assistant', content: response.content },
                { role: 'user', content: 'Continue validating, or call finish.' },
            );
            continue;
        }
        messages.push({ role: 'assistant', content: response.content });
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUses) {
            if (toolUse.name === 'finish') {
                const input = toolUse.input as any;
                // Harness-enforced execution grounding: a critical/major finding
                // whose evidence reads as reasoning-not-execution (placeholder or
                // deferral markers) is bounced back once, demanding a real repro.
                // (Prompt-requested execution degrades for hard exploits; the
                // harness must gate on execution artifacts, not the model's word.)
                const unexecuted = (input.bugs ?? []).filter(
                    (b: any) =>
                        (b.severity === 'critical' || b.severity === 'major') &&
                        /\b(todo|need(s)? (to )?(exercise|test|verify|reproduce)|not (yet )?(exercised|reproduced|verified|tested)|would (likely |probably )?(succeed|work|allow|return)|should (succeed|work|allow|return)|couldn'?t (run|exec|verify)|unable to (run|exec|verify))\b/i.test(
                            `${b.evidence ?? ''} ${input.summary ?? ''}`,
                        ),
                );
                if (unexecuted.length && !bounced) {
                    bounced = true;
                    logLine({ turn, bouncedFinish: input });
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolUse.id,
                        is_error: true,
                        content:
                            `REJECTED: ${unexecuted.length} finding(s) are reported as reasoned-but-not-executed (e.g. "${(unexecuted[0].evidence ?? '').slice(0, 80)}"). A critical/major finding is not acceptable without an EXECUTED reproduction against the running app. Boot the app now, set up the minimal state the exploit needs (e.g. two users, a resource owned by one), perform the attack as the wrong principal, and capture the REAL command output showing it succeeded (and the control case that should fail). Then call finish with that observed output as evidence.`,
                    });
                    break;
                }
                appendLessons(input.lessons);
                logLine({ turn, finish: input });
                return {
                    verdict: input.verdict,
                    summary: input.summary,
                    bugs: input.bugs ?? [],
                    turns: turn,
                    transcriptPath,
                };
            }
            const input = toolUse.input as {
                command: string;
                timeout_seconds?: number;
            };
            console.log(`\n[bash:${turn}] $ ${input.command}`);
            const res = await sshExec(state, wrapCommand(state, input.command), {
                timeoutMs: (input.timeout_seconds ?? 300) * 1000,
            });
            console.log(
                `[bash:${turn}] exit ${res.exitCode} in ${Math.round(res.durationMs / 1000)}s`,
            );
            logLine({ turn, tool: 'bash', input, exitCode: res.exitCode });
            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content:
                    `exit_code: ${res.exitCode}${res.timedOut ? ' (TIMED OUT)' : ''}\n` +
                    truncateForModel(
                        [res.stdout, res.stderr && `--- stderr ---\n${res.stderr}`]
                            .filter(Boolean)
                            .join('\n'),
                    ),
                is_error: res.exitCode !== 0,
            });
        }
        if (toolResults.length) {
            messages.push({ role: 'user', content: toolResults });
        }
    }
    throw new Error(`Validation hit the ${MAX_TURNS}-turn limit`);
}

function resolveClient(model: string): { client: Anthropic; model: string } {
    const isKimi = model.startsWith('kimi');
    const baseURL =
        getEnv('PREVIEW_AGENT_BASE_URL') ??
        (isKimi ? 'https://api.kimi.com/coding' : undefined);
    const apiKey =
        getEnv('PREVIEW_AGENT_API_KEY') ??
        (isKimi
            ? getEnv('KIMI_CODING_PLAN_KEY')
            : (getEnv('ANTHROPIC_API_KEY') ?? getEnv('BYOK_ANTHROPIC_API_KEY')));
    if (!apiKey) throw new Error(`No API key for model '${model}'`);
    return { client: new Anthropic({ apiKey, baseURL }), model };
}

const FIX_PLAYBOOK_SYSTEM = `You repair a preview-environment playbook that FAILED to reproduce on a fresh VM. You are given the current playbook (YAML) and the exact step that failed with its output. Return a CORRECTED full playbook (same YAML shape: version, summary, requiredEnv, setup, services, build, test, healthcheck).

Rules and common fixes (apply what fits the failure):
- ROOT-CAUSE, don't symptom-patch. A "connection refused"/"couldn't connect" failure on a health check means the SERVICE ISN'T RUNNING — the fix is in the phase that STARTS the service (usually 'services' or 'setup'), NOT the health check. Do NOT just add more polling to the check; that never helps if the service already died. The cause is almost always that the service was started with 'nohup <svc> &' and each playbook command runs as a SEPARATE shell session, so the background process died. FIX THE START COMMAND: replace 'nohup <svc> > log 2>&1 &' with 'setsid bash -c '\"'\"'cd <dir>; <svc> > /tmp/svc.log 2>&1'\"'\"' < /dev/null &' so it survives the session, and keep a short wait/poll after it. Apply this to the services/setup command that launches the app, not to the test phase.
- The fresh VM only preinstalls git/curl/jq/docker/node/npm/corepack/playwright. If a command uses pnpm/yarn/a global CLI that isn't there, prepend the install/enable step (e.g. 'corepack enable') to setup.
- Remove spurious host build steps for docker-based apps (the containers are the build).
- 'command not found' (exit 127) = a missing prerequisite; add it. 'connection refused' on a health check = the service isn't running (background process died — use setsid, or start it in the same command). 'No tests found' / bad flag = fix the exact test invocation.
- Do not weaken checks to make them pass; fix the cause. Keep everything that already worked.

Output ONLY the corrected YAML, no prose, no code fences.`;

/**
 * Single-shot playbook repair: given a failing playbook + the failing step,
 * ask the model for a corrected playbook. Used by the auto-harden loop.
 */
export async function fixPlaybook(
    playbookYaml: string,
    failure: { phase: string; command: string; exitCode: number; output: string },
    opts: { model?: string } = {},
): Promise<Playbook> {
    const model = opts.model ?? getEnv('PREVIEW_AGENT_MODEL') ?? DEFAULT_MODEL;
    const { client } = resolveClient(model);
    const userMsg =
        `Current playbook:\n\n${playbookYaml}\n\n` +
        `FAILED step (phase '${failure.phase}', exit ${failure.exitCode}):\n$ ${failure.command}\n\n` +
        `Output:\n${truncateForModel(failure.output, 6000)}\n\n` +
        `Return the corrected full playbook YAML.`;
    const response = await client.messages.create({
        model,
        max_tokens: 16384,
        system: FIX_PLAYBOOK_SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
    });
    let text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    // Prefer a fenced ```yaml block if present.
    const fence = text.match(/```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i);
    if (fence) text = fence[1].trim();
    else text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    // If the model prefixed prose, cut to the first top-level playbook key.
    const keyStart = text.search(/^(version|summary|requiredEnv|setup|services|build|test|healthcheck):/m);
    if (keyStart > 0) text = text.slice(keyStart);
    if (!text) {
        throw new Error(
            `fixPlaybook: model returned no usable YAML (raw length ${response.content.length} blocks)`,
        );
    }
    try {
        return parsePlaybook(text);
    } catch (e: any) {
        throw new Error(`fixPlaybook: could not parse repaired playbook (${e.message}). First 200 chars: ${text.slice(0, 200)}`);
    }
}

export interface PlaybookPatch {
    phase: string;
    old_contains: string;
    new_command: string;
    reason: string;
}

const FIX_PATCH_SYSTEM = `A preview-environment playbook FAILED to reproduce on a fresh VM. You are given the full playbook (YAML) and the exact failing step + output. Return a MINIMAL PATCH: change exactly ONE command so the ROOT CAUSE is fixed. Do NOT rewrite the playbook — a single surgical edit only, so phases that already passed are never disturbed.

Return ONLY a JSON object (no prose, no fences):
{"phase":"<setup|services|build|test|healthcheck>","old_contains":"<a distinctive substring of the ONE command to change>","new_command":"<the full replacement command>","reason":"<one line>"}

Phases run in this FIXED order: setup → build → services → test → healthcheck. So a service in 'services' already has whatever 'setup'/'build' produced (deps installed, migrations run, assets built). Do NOT embed install/build/migrate into the service start command — if those are missing, patch the 'build' or 'setup' phase instead. Make the SMALLEST edit that fixes the cause; never bundle multiple concerns into one command.

NEVER invent a command/script that may not exist (e.g. do NOT add 'npm run build' unless the failure output proves that script exists and is required). Inventing a nonexistent script just adds a new failing step and wastes an attempt. Fix only what the failure output actually shows; if you're unsure a script exists, don't add it.

Root-cause guidance:
- "connection refused"/"couldn't connect" or a health-poll timeout means the service didn't come up. Diagnose WHY from the service's own log, not by rewriting the start command. Most common causes and where to patch:
  * The health check is a bare 'curl <url>' with no wait → patch the failing TEST command into a readiness poll on the SAME url: for i in $(seq 1 60); do curl -fsS <url> 2>/dev/null | grep -q '<expected>' && exit 0; sleep 1; done; exit 1  (keep the same url/expected).
  * A file-backed DB (e.g. SQLite db/data.sqlite) whose directory doesn't exist → patch the BUILD command that migrates to first 'mkdir -p <dir> && ' the migrate.
  * A missing build/deps → patch the BUILD phase, not services.
  Pick ONE cause and make ONE minimal edit; the loop will re-run and surface the next cause if any.
- exit 127 "command not found" = a missing prerequisite; patch the FIRST setup command to install/enable it (e.g. prefix 'corepack enable && ').
- "No tests found"/bad flag = fix the exact test invocation.
- Pick old_contains to uniquely identify ONE command (use ~30+ distinctive chars). new_command must be complete and runnable. Never weaken a check to force a pass.`;

/**
 * Patch-based playbook repair: returns a single surgical edit instead of a
 * whole-playbook rewrite (which thrashes / breaks passing phases / truncates).
 */
export async function fixPlaybookPatch(
    playbookYaml: string,
    failure: { phase: string; command: string; exitCode: number; output: string },
    opts: { model?: string; availableScripts?: string[] } = {},
): Promise<PlaybookPatch> {
    const model = opts.model ?? getEnv('PREVIEW_AGENT_MODEL') ?? DEFAULT_MODEL;
    const { client } = resolveClient(model);
    const scriptsNote = opts.availableScripts?.length
        ? `\nThe repo's package.json defines ONLY these npm scripts: ${opts.availableScripts.join(', ')}. Do NOT reference any run-script outside this list (e.g. only add 'npm run build' if 'build' is listed).\n`
        : '';
    const userMsg =
        `Full playbook:\n\n${playbookYaml}\n${scriptsNote}\n` +
        `FAILED step (phase '${failure.phase}', exit ${failure.exitCode}):\n$ ${failure.command}\n\n` +
        `Output:\n${truncateForModel(failure.output, 5000)}\n\n` +
        `Return the minimal JSON patch.`;
    // Retry once if the model returns no usable JSON (occasionally empty).
    let text = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await client.messages.create({
            model,
            max_tokens: 2048,
            system: FIX_PATCH_SYSTEM,
            messages: [
                { role: 'user', content: userMsg },
                ...(attempt > 0
                    ? ([{ role: 'assistant', content: '{' }] as Anthropic.MessageParam[])
                    : []),
            ],
        });
        text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
        if (attempt > 0 && text && !text.startsWith('{')) text = '{' + text;
        if (/\{[\s\S]*\}/.test(text)) break;
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`fixPlaybookPatch: no JSON in response after retry: ${text.slice(0, 150)}`);
    const patch = JSON.parse(jsonMatch[0]) as PlaybookPatch;
    if (!patch.phase || !patch.old_contains || !patch.new_command) {
        throw new Error(`fixPlaybookPatch: incomplete patch: ${JSON.stringify(patch)}`);
    }
    return patch;
}

export { dumpPlaybook };
