import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@libs/core/log/logger';

/**
 * The preview-env bug-finding agent, ported from the standalone preview-env
 * experiment (experiments/preview-env `validatePr`). It runs an agentic loop
 * with a single `bash` tool executed INSIDE the booted VM, so it finds bugs by
 * EXECUTING the PR — reproducing SSRF/IDOR, wrong DB queries/counts, price
 * tampering, runtime regressions — not by reasoning over the diff.
 *
 * Decoupled from the VM/DI: the caller passes an `exec` bound to the running
 * sandbox and the resolved LLM key. Findings come back with the exact command
 * run + real output as proof.
 */
export interface PreviewExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export interface PreviewFinding {
    description: string;
    /** Executed repro: the command(s) run + real output, expected vs actual. */
    evidence: string;
    file: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface PreviewAgentParams {
    apiKey: string;
    model: string;
    baseURL?: string;
    /** Run a shell command inside the booted VM (repo root, env sourced). */
    exec: (command: string, timeoutMs?: number) => Promise<PreviewExecResult>;
    /** The PR under review, as a unified diff. */
    diff: string;
    /** @kody review focus directive (context.reviewDirective), if any. */
    focus?: string;
    maxTurns?: number;
}

export interface PreviewAgentResult {
    findings: PreviewFinding[];
    summary: string;
    turns: number;
}

const SYSTEM_PROMPT = `You are Kody's preview-environment validation agent. You have a \`bash\` tool that runs commands INSIDE a VM where the customer's repository is checked out and the app is already BOOTED (services running, DB migrated). The pull request under review is applied to the working tree — you are given its diff. You are given NO author title/description/intent — judge ONLY what the code now does.

Mission: determine whether this change is safe and correct by EXERCISING the affected behavior, assuming nothing.
1. From the diff, identify every behavior the code now exhibits and every guarantee it might BREAK. If it touches anything security-relevant (auth, permissions, input validation, SSRF/URL/host allow-block logic, path handling, crypto, deserialization, command/DB construction), your FIRST duty is to verify the protection still holds — construct the malicious input and run it against the RUNNING app (loopback 127.0.0.1 / metadata 169.254.169.254 for SSRF, wrong/lower-privilege principal for auth, ../ for paths, a payload for injection).
2. DATA BUGS: if the diff touches queries/filters/JOINs/aggregations/pagination/migrations/tenant-scoping, SEED representative rows, exercise the path, then QUERY THE DATABASE DIRECTLY (psql/sqlite3/mysql/mongosh — find the connection string in the env) and compare actual rows/counts to what you computed by hand. Never trust the endpoint's 200. Check query-level tenant isolation (seed users A+B, read as B, verify B can't see A's rows) and migration data-safety.
3. A change that ALLOWS something previously blocked is a security regression even if it looks like a feature — name it (e.g. "reintroduces SSRF: X reachable") with the executed repro and concrete impact.
4. EXECUTION IS MANDATORY. Reasoning from the diff is NOT sufficient — OBSERVE the defect by running code. Prefer isolating the changed unit (call it via node/python/etc against the real DB and print the raw result) over a full authenticated flow; stop at the cheapest conclusive proof. Put the exact command + its real output in every finding's evidence.
5. Call finish exactly once. Be economical.

WHAT COUNTS AS A FINDING — read carefully:
- A finding is a DEFECT you REPRODUCED by execution: the code does something wrong, unsafe, broken, or incorrect, and you have the command + real output that shows it.
- NEVER report a confirmation as a finding. "The tests pass", "the math is correct", "the catalog fetch works", "behaves as expected", "no issue found" are NOT findings — they are the ABSENCE of a finding. Put that reassurance in \`summary\` and leave \`findings\` empty.
- An empty \`findings\` array is the correct, expected result for a correct PR. Returning [] is a success, not a failure — do NOT invent low-severity findings to fill the array.
- Before adding anything to \`findings\`, ask: "does my evidence show something WRONG?" If the evidence shows something RIGHT, it does not belong in \`findings\`.
- Severity reflects real impact of a real defect. If you're tempted to file "low" just to have something, that's the signal it isn't a finding — drop it.
- A pre-existing defect in code the PR touches is reportable, but say so and only if you reproduced concrete wrong behavior (not a style/opinion).`;

const TOOLS: Anthropic.Tool[] = [
    {
        name: 'bash',
        description: 'Run a shell command inside the booted VM (repo root, customer env sourced).',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string' },
                timeout_seconds: { type: 'number' },
            },
            required: ['command'],
        },
    },
    {
        name: 'finish',
        description:
            'Finish the review. `findings` holds ONLY reproduced defects; if the PR is correct, pass an empty `findings` array and explain in `summary`.',
        input_schema: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    description:
                        'What you exercised and concluded. Confirmations that things WORK go here (never in findings).',
                },
                findings: {
                    type: 'array',
                    description:
                        'Reproduced DEFECTS only — something the code does WRONG, with executed proof. Empty when the PR is correct. Never a confirmation that something works.',
                    items: {
                        type: 'object',
                        properties: {
                            description: { type: 'string', description: 'The defect: what is wrong and its impact.' },
                            evidence: { type: 'string', description: 'Executed repro: command(s), expected vs actual — must show WRONG behavior.' },
                            file: { type: 'string' },
                            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                        },
                        required: ['description', 'evidence', 'file', 'severity'],
                    },
                },
            },
            required: ['summary', 'findings'],
        },
    },
];

export class PreviewEnvAgentService {
    private readonly logger = createLogger(PreviewEnvAgentService.name);

    async run(params: PreviewAgentParams): Promise<PreviewAgentResult> {
        const client = new Anthropic({ apiKey: params.apiKey, baseURL: params.baseURL });
        const maxTurns = params.maxTurns ?? 60;

        const focusBlock = params.focus
            ? `\n\n<ReviewFocus>\nThe reviewer asked to focus on: ${params.focus}\nPrioritize findings in that area, but still report any critical security/data defect you reproduce.\n</ReviewFocus>`
            : '';

        const messages: Anthropic.MessageParam[] = [
            {
                role: 'user',
                content:
                    `The app is booted in this VM. Review the following PR diff by exercising it, then call finish.${focusBlock}\n\n<diff>\n${params.diff.slice(0, 60_000)}\n</diff>`,
            },
        ];

        for (let turn = 1; turn <= maxTurns; turn++) {
            const response = await client.messages.create({
                model: params.model,
                max_tokens: 8192,
                system: SYSTEM_PROMPT,
                tools: TOOLS,
                messages,
            });

            const toolUses = response.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );
            if (!toolUses.length) {
                messages.push(
                    { role: 'assistant', content: response.content },
                    { role: 'user', content: 'Continue exercising the PR with the bash tool, or call finish.' },
                );
                continue;
            }

            messages.push({ role: 'assistant', content: response.content });
            const toolResults: Anthropic.ToolResultBlockParam[] = [];

            for (const toolUse of toolUses) {
                if (toolUse.name === 'finish') {
                    const input = toolUse.input as { summary: string; findings: PreviewFinding[] };
                    return {
                        findings: (input.findings ?? []).filter((f) => f && f.description),
                        summary: input.summary ?? '',
                        turns: turn,
                    };
                }
                const input = toolUse.input as { command: string; timeout_seconds?: number };
                let out: PreviewExecResult;
                try {
                    out = await params.exec(input.command, (input.timeout_seconds ?? 300) * 1000);
                } catch (e: any) {
                    out = { stdout: '', stderr: String(e?.message ?? e), exitCode: 1 };
                }
                const body = `exit=${out.exitCode}\n${(out.stdout + out.stderr).slice(0, 12_000)}`;
                toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: body });
            }
            messages.push({ role: 'user', content: toolResults });
        }

        this.logger.warn({
            message: `Preview-env agent hit the ${maxTurns}-turn limit without finishing`,
            context: PreviewEnvAgentService.name,
        });
        return { findings: [], summary: `Hit ${maxTurns}-turn limit`, turns: maxTurns };
    }
}
