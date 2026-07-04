import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
const MAX_TURNS = 80;

const SYSTEM_PROMPT = `You are Kody's environment-detection agent. You have root shell access (via the bash tool) to a fresh Ubuntu 24.04 VM with Docker, docker compose, git, curl and jq preinstalled. A customer's repository has been cloned; every bash command you run already starts at the repository root with the customer's env file (if provided) exported.

Your mission, in order:
1. EXPLORE: understand the project — language(s), package manager, frameworks, services it depends on (databases, queues, caches), how it is built and tested. Read manifests (package.json, pyproject.toml, go.mod, Gemfile, pom.xml, Makefile, docker-compose*.yml, Dockerfile, CI workflows under .github/workflows or similar — CI configs are the best source of truth for how to build and test).
2. PROVISION: install the required toolchain versions (use official installers or apt; mise/nvm/pyenv if versions are pinned). Start required backing services — prefer the repo's own docker-compose if present, otherwise run official Docker images (postgres, redis, etc.) with credentials matching what the app expects.
3. BOOT: install dependencies, run migrations/seeds if needed, build the project.
4. VERIFY — actually USE the environment, don't just boot it:
   a. Run the repo's test suite if one exists (or a meaningful subset if huge — prefer unit tests first). A partially failing suite can still be success if failures are clearly pre-existing/flaky and the environment itself works.
   b. ALWAYS also exercise the application's core user flows end-to-end against the running app: make real requests that create/read data (e.g. for an API: POST a resource, GET it back, verify the response body; follow redirects; check side effects landed in the database). Each check must be a real assertion — a command that exits non-zero when the expected behavior does not happen (curl + grep/jq -e, psql -c + grep, etc.). "The server is up" is NOT verification.
5. Call finish with a playbook capturing the *reproducible* path you found. The playbook's test phase must contain those executable assertions (suite + functional flows), so a future run proves the environment WORKS, not merely boots.

Rules:
- Missing env vars: check which are required (env.example, config loaders, CI). Use values from the customer env file when present; invent safe local defaults only for infrastructure you started yourself (e.g. DATABASE_URL pointing at your own postgres container). Never invent third-party API credentials — if a test needs them and they're absent, note it in the playbook summary and skip those tests.
- Be economical with output: pipe long output through tail/head, use --quiet flags. You see at most ~12k chars per command.
- Long installs/builds are fine, but set a generous timeout_seconds when you expect them.
- If something fails, read the error and fix the environment; do not brute-force retry the same command.
- The playbook you emit must work on a FRESH identical VM: include every command that was actually required (toolchain install, services, deps, build, test), in the phases setup/services/build/test. Commands run at the repo root with the customer env sourced. Do not include exploration commands.
- requiredEnv lists env var NAMES the customer must supply (never values).

Call finish exactly once, when you either succeeded or are certain you cannot proceed (success=false, explain why in summary).`;

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

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        const response = await client.messages.create({
            model,
            max_tokens: 8192,
            system: SYSTEM_PROMPT,
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
                };
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

export { dumpPlaybook };
