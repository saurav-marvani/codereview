import type { KodusSession, RunContext } from './types.js';
import { http, ensureOk } from './http.js';
import { pollUntil } from '../providers/base.js';

/**
 * Execution HEALTH assertion: the review's automation execution must end
 * in `success` — not `partial_error` ("completed with warnings", i.e. an
 * agent or auxiliary stage crashed) and not `error`.
 *
 * Why this exists: a review can still post findings while an entire agent
 * died (observed live: the finder crashing on malformed model output, 9
 * hits/hour on a customer instance, every scenario still green). Output
 * asserts don't see that; only the execution status does.
 */
export async function assertHealthyExecution(
    ctx: RunContext,
    session: KodusSession,
    prNumber: number,
): Promise<string> {
    // The execution row settles shortly after the completion comment is
    // delivered; poll briefly rather than racing it.
    const status = await pollUntil<string>(
        async () => {
            const resp = await http<any>(
                // Param name must match EnrichedPullRequestsQueryDto — the
                // API's global ValidationPipe has forbidNonWhitelisted, so an
                // unknown param (`prNumber`) is a deterministic HTTP 400.
                // That exact typo failed all four license-paid cells of the
                // 2026-07-11 release matrix.
                `${ctx.target.apiBaseUrl}/pull-requests/executions?pullRequestNumber=${prNumber}&limit=5`,
                {
                    headers: { Authorization: `Bearer ${session.accessToken}` },
                    timeoutMs: 30_000,
                },
            );
            ensureOk(resp, 'executions:list');
            const found = findExecutionStatus(resp.body, prNumber);
            // Keep polling while the execution is still settling.
            if (!found || found === 'pending' || found === 'in_progress') {
                return null;
            }
            return found;
        },
        { intervalSec: 5, timeoutSec: 90 },
    );

    ctx.assert(
        status !== null,
        `No settled automation execution found for PR #${prNumber} within 90s — cannot verify review health`,
    );
    ctx.assert(
        status === 'success',
        `Review of PR #${prNumber} completed UNHEALTHY: execution status is "${status}" ` +
            `(partial_error = an agent or auxiliary stage crashed and its work was silently dropped — ` +
            `the review may still have posted findings from the surviving agents). ` +
            `Check the worker logs for the failing stage/agent.`,
    );
    return status!;
}

/** Defensive walk: find the newest execution status for the PR number. */
function findExecutionStatus(node: unknown, prNumber: number): string | null {
    const hits: string[] = [];
    const walk = (n: unknown): void => {
        if (Array.isArray(n)) {
            for (const item of n) walk(item);
            return;
        }
        if (n && typeof n === 'object') {
            const obj = n as Record<string, unknown>;
            const num = obj.prNumber ?? obj.pullRequestNumber ?? obj.number;
            if (
                Number(num) === prNumber &&
                typeof obj.status === 'string' &&
                obj.status
            ) {
                hits.push(obj.status);
            }
            for (const v of Object.values(obj)) walk(v);
        }
    };
    walk(node);
    return hits[0] ?? null;
}
