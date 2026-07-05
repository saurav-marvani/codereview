import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { resolveScopedRun } from '@libs/sandbox/infrastructure/providers/affected';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Preview-environment stage (Phase 3). When the repo opts in via the committed
 * `environment:` config AND the active sandbox is a real VM, boot & test the PR
 * in it: run the environment playbook (setup → build → services → test),
 * scoped to the PR's affected slice on giant monorepos, and record an EXECUTED
 * signal on the context for the reviewer to consume (evidence, not reasoning).
 *
 * Sits after CreateSandboxStage (which, under SANDBOX_PROVIDER=vm, produced a
 * VM sandbox) and before/around agentReview. Non-fatal: any failure logs and
 * leaves the review to continue without the executed signal.
 */
const PHASE_TIMEOUT_MS = 30 * 60_000;

@Injectable()
export class RunPreviewEnvStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'RunPreviewEnvStage';
    readonly label = 'Running Preview Environment';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(RunPreviewEnvStage.name);

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const env = context.codeReviewConfig?.environment;
        const sandbox = context.sandboxHandle;

        if (!env?.enabled) return context;
        if (!sandbox || sandbox.type !== 'vm') {
            this.logger.log({
                message: `Preview env enabled but active sandbox is ${sandbox?.type ?? 'none'} (needs a VM); skipping`,
                context: this.stageName,
            });
            return context;
        }

        const changedFiles = (context.changedFiles ?? [])
            .map((f) => f.filename)
            .filter(Boolean);
        const base = `origin/${sandbox.baseBranch ?? 'main'}`;
        const scoped = resolveScopedRun(env.scope, changedFiles, base);

        const build = scoped ? scoped.build : env.build ?? [];
        const test = scoped ? scoped.test : env.test ?? [];
        const scopeLabel = scoped?.reason ?? 'full';

        const phases: Array<{ phase: string; commands: string[] }> = [
            { phase: 'setup', commands: env.setup ?? [] },
            { phase: 'build', commands: build },
            { phase: 'services', commands: (env.services ?? []).map(wrapService) },
            { phase: 'test', commands: test },
            { phase: 'healthcheck', commands: env.healthcheck ?? [] },
        ];

        const results: NonNullable<
            CodeReviewPipelineContext['previewEnvSignal']
        >['phases'] = [];
        let ok = true;
        try {
            for (const { phase, commands } of phases) {
                for (const command of commands) {
                    const r = await sandbox.run(command, {
                        timeoutMs: PHASE_TIMEOUT_MS,
                    });
                    results.push({
                        phase,
                        command,
                        exitCode: r.exitCode,
                        outputTail: (r.stdout + r.stderr).slice(-2000),
                    });
                    if (r.exitCode !== 0) {
                        ok = false;
                        this.logger.warn({
                            message: `Preview env phase '${phase}' failed (exit ${r.exitCode})`,
                            context: this.stageName,
                            metadata: { command: command.slice(0, 200) },
                        });
                        break;
                    }
                }
                if (!ok) break;
            }
        } catch (error) {
            ok = false;
            this.logger.error({
                message: 'Preview env run threw; continuing review without executed signal',
                context: this.stageName,
                error,
            });
        }

        this.logger.log({
            message: `Preview env ${ok ? 'PASSED' : 'FAILED'} (scope: ${scopeLabel}, ${results.length} command(s))`,
            context: this.stageName,
        });

        return this.updateContext(context, (draft) => {
            draft.previewEnvSignal = { ran: true, ok, scope: scopeLabel, phases: results };
        });
    }
}

/**
 * Background a long-running service so the ssh exec returns instead of hanging.
 * setsid (not nohup) survives the exec's session; redirect OUTSIDE the bash -c
 * so the ssh channel's fds are freed (hard-won from the experiment).
 */
function wrapService(command: string): string {
    const escaped = command.replace(/'/g, `'\\''`);
    return `setsid bash -c '${escaped}' > /tmp/kody-svc.log 2>&1 < /dev/null & sleep 4`;
}
