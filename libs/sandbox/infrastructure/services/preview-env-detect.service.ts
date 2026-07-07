import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import * as yaml from 'js-yaml';
import { createLogger } from '@libs/core/log/logger';
import { PreviewExecResult, RuntimeTurn } from './preview-env-agent.service';

/**
 * Devin-style environment-detection agent, ported from the standalone preview-env
 * experiment (experiments/preview-env `detectEnvironment`). Given a shell on a
 * fresh VM with the customer's repo cloned, it EXPLORES the repo, provisions the
 * toolchain + backing services, boots + verifies the app, and emits a
 * reproducible playbook (`.kody/runtime.yml` shape) the user can review + save.
 *
 * This powers the "Generate config" button: the human never hand-writes the
 * playbook — the agent drafts it from the real repo. Layer-clean: returns the
 * raw YAML string; the API/code-review layer validates it with the canonical
 * parser before persisting.
 */
export interface PreviewEnvDetectParams {
    apiKey: string;
    model: string;
    baseURL?: string;
    /** Run a shell command inside the VM (repo root, customer env sourced). */
    exec: (command: string, timeoutMs?: number) => Promise<PreviewExecResult>;
    /** Whether a customer env file was uploaded + exported into commands. */
    hasCustomerEnv?: boolean;
    maxTurns?: number;
}

export interface DetectedPlaybook {
    setup?: string[];
    build?: string[];
    services?: string[];
    test?: string[];
    healthcheck?: string[];
    requiredEnv?: string[];
    [k: string]: unknown;
}

export interface PreviewEnvDetectResult {
    success: boolean;
    summary: string;
    /** The playbook the agent emitted, as YAML (authoritative; save this). */
    playbookYaml: string | null;
    /** Light parse of the YAML for convenience (endpoint re-validates). */
    playbook: DetectedPlaybook | null;
    turns: number;
    transcript: RuntimeTurn[];
}

const SYSTEM_PROMPT = `You are Kody's environment-detection agent. You have root shell access (via the bash tool) to a fresh Ubuntu 24.04 VM with Docker, docker compose, git, curl and jq preinstalled. A customer's repository has been cloned; every bash command you run already starts at the repository root with the customer's env file (if provided) exported.

Your mission, in order:
1. EXPLORE: understand the project — language(s), package manager, frameworks, services it depends on (databases, queues, caches), how it is built and tested. Read manifests (package.json, pyproject.toml, go.mod, Gemfile, pom.xml, Makefile, docker-compose*.yml, Dockerfile, CI workflows under .github/workflows — CI configs are the best source of truth for how to build and test).
2. PROVISION: install the required toolchain versions (official installers or apt; mise/nvm/pyenv if versions are pinned). Start required backing services — prefer the repo's own docker-compose if present, otherwise official Docker images (postgres, redis, etc.) with credentials matching what the app expects.
3. BOOT: install dependencies, run migrations/seeds if needed, build the project, start the app.
4. VERIFY — actually USE the environment, don't just boot it: run the repo's test suite if one exists, and exercise the app's core flow with a real assertion (curl + grep/jq -e that exits non-zero when the expected behavior does not happen). "The server is up" is NOT verification.
5. Call finish with a playbook capturing the *reproducible* path you found.

Rules:
- Missing env vars: check which are required (env.example, config loaders, CI). Use the customer env file when present; invent safe local defaults only for infrastructure you started yourself (e.g. DATABASE_URL pointing at your own postgres container). Never invent third-party API credentials — note them in the summary and skip those tests.
- Be economical: pipe long output through tail/head. You see at most ~12k chars per command. Set a generous timeout_seconds for long installs/builds.
- If something fails, read the error and fix the environment; do not brute-force retry the same command.
- CRITICAL — the playbook must work on a FRESH identical VM whose ONLY preinstalled tools are: git, curl, jq, docker, node, npm, corepack. NOTHING you install during exploration persists. So if you used pnpm/yarn/pipenv/poetry/a specific node version/a global CLI/a system lib, the FIRST thing your setup phase must do is install/enable it (e.g. \`corepack enable\` for pnpm, \`npm i -g yarn\`, apt-get for a system lib). The single most common failure is a playbook that opens with \`pnpm ...\` but never enabled pnpm — it dies with exit 127 on line 1.
- Prefer capturing what you ACTUALLY did: a step you ran that "just worked" is exactly the step most likely to be missing from your playbook. Never put a command in the playbook you did not run EXACTLY as written.
- Phases: setup (toolchain + deps + env prep), build (migrations/compile), services (start the app — you give the naive command, the runner backgrounds it), healthcheck (a curl that confirms readiness — the runner polls it), test (optional assertions). Commands run at the repo root with the customer env sourced. Do NOT include exploration commands.
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
                command: { type: 'string', description: 'The shell command to run.' },
                timeout_seconds: {
                    type: 'number',
                    description: 'Max seconds to wait (default 300). Use more for long installs/builds.',
                },
            },
            required: ['command'],
        },
    },
    {
        name: 'finish',
        description:
            'Emit the detected environment playbook and stop. Call exactly once.',
        input_schema: {
            type: 'object',
            properties: {
                success: {
                    type: 'boolean',
                    description: 'True if you booted + verified the app; false if you could not.',
                },
                summary: {
                    type: 'string',
                    description: 'What the project is, how the env works, and anything the user must supply (e.g. third-party creds).',
                },
                playbook_yaml: {
                    type: 'string',
                    description:
                        "The .kody/runtime.yml playbook as YAML: keys setup/build/services/healthcheck/test (each a list of shell command strings) + requiredEnv (list of env var NAMES). Only commands you actually ran, in an order that works on a fresh VM.",
                },
            },
            required: ['success', 'summary', 'playbook_yaml'],
        },
    },
];

@Injectable()
export class PreviewEnvDetectService {
    private readonly logger = createLogger(PreviewEnvDetectService.name);

    async detect(params: PreviewEnvDetectParams): Promise<PreviewEnvDetectResult> {
        const maxTurns = params.maxTurns ?? 40;
        const client = new Anthropic({ apiKey: params.apiKey, baseURL: params.baseURL });

        const envNote = params.hasCustomerEnv
            ? 'A customer env file was uploaded and is exported into every command.'
            : 'No customer env file was uploaded — invent safe local defaults for infrastructure you start yourself.';

        const messages: Anthropic.MessageParam[] = [
            {
                role: 'user',
                content: `Detect how to run this repository and emit a reproducible playbook. ${envNote}\nStart by exploring the repo root.`,
            },
        ];

        const transcript: RuntimeTurn[] = [];
        const reasoningText = (content: Anthropic.Message['content']): string =>
            content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
                .trim();

        for (let turn = 1; turn <= maxTurns; turn++) {
            const response = await client.messages.create({
                model: params.model,
                max_tokens: 8192,
                system: SYSTEM_PROMPT,
                tools: TOOLS,
                messages,
            });

            const record: RuntimeTurn = { turn, reasoning: reasoningText(response.content), commands: [] };
            transcript.push(record);

            const toolUses = response.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );
            if (!toolUses.length) {
                messages.push(
                    { role: 'assistant', content: response.content },
                    { role: 'user', content: 'Continue exploring/booting with the bash tool, or call finish.' },
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
                    let playbook: DetectedPlaybook | null = null;
                    try {
                        const doc = yaml.load(input.playbook_yaml ?? '');
                        if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
                            playbook = doc as DetectedPlaybook;
                        }
                    } catch (e: any) {
                        // Malformed YAML from the model → feed it back to fix once.
                        record.reasoning += `\n[invalid playbook YAML: ${e?.message ?? e}]`;
                        toolResults.push({
                            type: 'tool_result',
                            tool_use_id: toolUse.id,
                            content: `The playbook_yaml is not valid YAML: ${e?.message ?? e}. Fix it and call finish again.`,
                        });
                        continue;
                    }
                    return {
                        success: !!input.success,
                        summary: input.summary ?? '',
                        playbookYaml: input.playbook_yaml ?? null,
                        playbook,
                        turns: turn,
                        transcript,
                    };
                }
                const input = toolUse.input as { command: string; timeout_seconds?: number };
                let out: PreviewExecResult;
                const started = Date.now();
                try {
                    out = await params.exec(input.command, (input.timeout_seconds ?? 300) * 1000);
                } catch (e: any) {
                    out = { stdout: '', stderr: String(e?.message ?? e), exitCode: 1 };
                }
                record.commands.push({
                    command: input.command,
                    exitCode: out.exitCode,
                    stdout: (out.stdout ?? '').slice(0, 20_000),
                    stderr: (out.stderr ?? '').slice(0, 20_000),
                    durationMs: Date.now() - started,
                });
                const body = `exit=${out.exitCode}\n${(out.stdout + out.stderr).slice(0, 12_000)}`;
                toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: body });
            }
            if (toolResults.length) messages.push({ role: 'user', content: toolResults });
        }

        this.logger.warn({
            message: `Detect agent hit the ${maxTurns}-turn limit without finishing`,
            context: PreviewEnvDetectService.name,
        });
        return {
            success: false,
            summary: `Hit ${maxTurns}-turn limit without emitting a playbook`,
            playbookYaml: null,
            playbook: null,
            turns: maxTurns,
            transcript,
        };
    }
}
