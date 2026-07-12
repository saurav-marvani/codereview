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

/** One executed command in the agent's session (for the run transcript). */
export interface RuntimeCommand {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
}

/** One agent turn: what it reasoned + the commands it ran that turn. */
export interface RuntimeTurn {
    turn: number;
    reasoning: string;
    commands: RuntimeCommand[];
}

export interface PreviewAgentResult {
    findings: PreviewFinding[];
    summary: string;
    turns: number;
    /** Full replayable record of what the agent did — every command + output +
     *  the model's reasoning per turn. RAW (unredacted): the STAGE redacts the
     *  injected secret values before persisting, since only it holds them. */
    transcript: RuntimeTurn[];
}

const SYSTEM_PROMPT = `You are Kody's preview-environment validation agent. You have a \`bash\` tool that runs commands INSIDE a VM where the customer's repository is checked out, its dependencies installed, and its boot playbook has been run. Usually a service is already running (DB migrated) — but a pure-logic/library/validation PR may have NO long-running server. Spend AT MOST one command checking (\`ss -ltnp\` or a single curl); if nothing is listening and the diff is a library/logic change, do NOT keep hunting for a server and do NOT call it a boot failure — go straight to isolating and exercising the changed code unit (point 4). The pull request under review is applied to the working tree — you are given its diff. You are given NO author title/description/intent — judge ONLY what the code now does.

Mission: determine whether this change is safe and correct by EXERCISING the affected behavior, assuming nothing.
1. From the diff, identify every behavior the code now exhibits and every guarantee it might BREAK. If it touches anything security-relevant (auth, permissions, input validation, SSRF/URL/host allow-block logic, path handling, crypto, deserialization, command/DB construction), your FIRST duty is to verify the protection still holds — construct the malicious input and run it against the RUNNING app (loopback 127.0.0.1 / metadata 169.254.169.254 for SSRF, wrong/lower-privilege principal for auth, ../ for paths, a payload for injection).
2. DATA BUGS: if the diff touches queries/filters/JOINs/aggregations/pagination/migrations/tenant-scoping, SEED representative rows, exercise the path, then QUERY THE DATABASE DIRECTLY (psql/sqlite3/mysql/mongosh — find the connection string in the env) and compare actual rows/counts to what you computed by hand. Never trust the endpoint's 200. Check query-level tenant isolation (seed users A+B, read as B, verify B can't see A's rows) and migration data-safety.
3. A change that ALLOWS something previously blocked is a security regression even if it looks like a feature — name it (e.g. "reintroduces SSRF: X reachable") with the executed repro and concrete impact.
4. EXECUTION IS MANDATORY. Reasoning from the diff is NOT sufficient — OBSERVE the defect by running code. Prefer isolating the changed unit (call it via node/python/etc against the real DB and print the raw result) over a full authenticated flow; stop at the cheapest conclusive proof. Put the exact command + its real output in every finding's evidence.
4b. DIFFERENTIAL (base-vs-head) TESTING — your strongest tool for a REGRESSION, and the one you most often skip. You are judging a CHANGE, and you usually CANNOT know the intended behavior in isolation — so testing "is HEAD self-consistent?" passes buggy code that looks fine on its own. Instead ask "did HEAD's behavior CHANGE vs BASE, and is the change wrong?". The full PR diff is saved on the VM at \`/opt/kody/pr.diff\`. Procedure: (i) write your exercise as ONE repeatable script that prints raw output/DB rows; (ii) run it now (HEAD) and capture the output; (iii) \`cd <repo> && git apply -R /opt/kody/pr.diff\` to revert the changed files to BASE (pre-PR), run the SAME script, capture; (iv) \`git apply /opt/kody/pr.diff\` to restore HEAD. COMPARE the two outputs verbatim. A field non-null at BASE but null/empty/wrong at HEAD, a row count that dropped, an amount/flag that changed unexpectedly, an error that only HEAD throws — that is a REGRESSION even if HEAD looks internally consistent. CRUCIAL: exercise the READ path, not just the write path — CREATE/seed the record through the changed code, then QUERY it back and inspect the persisted/returned value; many regressions (wrong metadata, dropped relations, null fields, lost rows) ONLY appear when you read the result back, never in the write-side logic alone.
5. BOOT FAILURES ARE FINDINGS — but only a CRASH is. Distinguish two cases: (a) the playbook STARTED a service and it's now down (a service phase ran, /tmp/kody-svc*.log shows it started then died, or the port that was up is now closed) → that's a boot regression, investigate it (below). (b) the playbook has NO service phase because this is a library/logic/validation change → no server is EXPECTED; that is NOT a boot failure and NOT a finding — isolate and exercise the changed unit (point 4) and move on. Check /tmp/kody-svc*.log to tell them apart; do not manufacture a boot-failure finding from a repo that was never meant to start a server. When it IS a real crash: Do NOT trust the phase exit codes or conclude "environment issue": a setup/build step piped through \`| tail\`/\`| head\` reports success even when it failed. RE-RUN the build and start commands YOURSELF, directly and WITHOUT any pipe that hides the exit code (e.g. \`npm run migrate\`, \`node server.js\`, \`npm start\`), read the FULL stderr, and also read the service log (/tmp/kody-svc*.log). Then trace the first real error to the specific diff change — a migration that references a missing column, a renamed/removed export, a dependency that went ESM-only (ERR_REQUIRE_ESM), a newly-required env var with no value, a syntax error. Report it with the exact error output. Only conclude the environment is at fault (not a finding) after you have re-run the steps raw and confirmed the failure is unrelated to this diff.
6. FRONTEND IS IN SCOPE. If the diff touches UI code (templates, JSX/TSX/Vue/Svelte, client-side JS, static assets, HTML rendering, forms), exercise it in a REAL BROWSER, not just curl. Playwright + headless Chromium are provisioned on this VM under /opt/kody (if /opt/kody/pw-ready does not exist yet, the install is still running — check \`tail /opt/kody/pw-install.log\` and wait briefly). Write a Node script under /opt/kody (so \`require('playwright')\` resolves) and run it with \`node\`. Template:
\`\`\`js
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on('pageerror', e => console.log('PAGE-ERROR:', e.message));
  p.on('console', m => m.type() === 'error' && console.log('CONSOLE-ERROR:', m.text()));
  p.on('requestfailed', r => console.log('REQ-FAILED:', r.url(), r.failure()?.errorText));
  const resp = await p.goto('http://localhost:PORT/path');
  console.log('STATUS:', resp.status());
  // interact: p.fill/p.click/p.waitForSelector — then assert on text/DOM:
  console.log(await p.textContent('body'));
  await b.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
\`\`\`
Assert on rendered text/selectors and on the PAGE-ERROR / CONSOLE-ERROR / REQ-FAILED lines — a JS exception, a form that no longer submits, a blank render, a broken asset after this diff is a reproduced finding (script + output = evidence). Backend/API flows: keep exercising directly with curl and the DB. A UI-touching PR is not fully reviewed until the affected page was loaded in the browser.
7. Call finish exactly once. Be economical.

WHAT COUNTS AS A FINDING — read carefully:
- A finding is a DEFECT you REPRODUCED by execution: the code does something wrong, unsafe, broken, or incorrect, and you have the command + real output that shows it.
- NEVER report a confirmation as a finding. "The tests pass", "the math is correct", "the catalog fetch works", "behaves as expected", "no issue found" are NOT findings — they are the ABSENCE of a finding. Put that reassurance in \`summary\` and leave \`findings\` empty.
- An empty \`findings\` array is the correct, expected result for a correct PR. Returning [] is a success, not a failure — do NOT invent low-severity findings to fill the array.
- Before adding anything to \`findings\`, ask: "does my evidence show something WRONG?" If the evidence shows something RIGHT, it does not belong in \`findings\`.
- Severity reflects real impact of a real defect. If you're tempted to file "low" just to have something, that's the signal it isn't a finding — drop it.
- SCOPE: report ONLY defects this PR's change INTRODUCES or newly exhibits (a regression). A defect that already existed before this change — unchanged behavior the PR merely touches nearby — is OUT OF SCOPE: do not file it; note it in \`summary\` at most. To decide, ask "did THIS diff cause the wrong behavior?" — if the same bug reproduces on the base revision, it's pre-existing, not a finding.`;

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

        // Replayable record of the whole session (commands + output + reasoning).
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
            messages.push({ role: 'user', content: toolResults });
        }

        this.logger.warn({
            message: `Preview-env agent hit the ${maxTurns}-turn limit without finishing`,
            context: PreviewEnvAgentService.name,
        });
        return { findings: [], summary: `Hit ${maxTurns}-turn limit`, turns: maxTurns, transcript };
    }
}
