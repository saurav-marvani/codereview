import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { resolveScopedRun } from '@libs/sandbox/infrastructure/providers/affected';
import { VmSandboxService } from '@libs/sandbox/infrastructure/providers/vm-sandbox.service';
import {
    PreviewEnvAgentService,
    PreviewExecResult,
} from '@libs/sandbox/infrastructure/services/preview-env-agent.service';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';
import { CloneParamsResolverService } from '../services/clone-params-resolver.service';
import {
    buildDiffFromChangedFiles,
    findingsToSuggestions,
} from '../services/preview-env-findings';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Preview-environment stage — COMPLEMENTARY to the normal review. When a repo
 * opts in via the committed `environment:` config, this stage (independent of
 * the e2b sandbox the normal review uses for file tools) provisions its OWN
 * ephemeral VM, injects the app's secrets, boots the app from the playbook
 * (scoped to the PR's affected slice on giant monorepos), and runs the
 * preview-env bug-finding agent — which EXECUTES the PR to reproduce SSRF/IDOR,
 * wrong DB queries, price tampering, runtime regressions. Its findings are
 * mapped to CodeSuggestion and appended to `context.validSuggestions`, so they
 * flow through the SAME downstream (dedup → comments → critical gating) as the
 * normal review, each carrying its executed proof. Focus-aware via
 * `context.reviewDirective`. Non-fatal: any failure logs and the review
 * continues without the preview signal. Always tears the VM down.
 */
const PHASE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

@Injectable()
export class RunPreviewEnvStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'RunPreviewEnvStage';
    readonly label = 'Running Preview Environment';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(RunPreviewEnvStage.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly cloneParamsResolver: CloneParamsResolverService,
        private readonly agent: PreviewEnvAgentService,
        // Injected (not `new`-ed) so the stage is testable and the VM lifecycle
        // is mockable. This is the COMPLEMENTARY VM — separate from the global
        // sandbox provider (e2b), which the normal review keeps using.
        private readonly vmSvc: VmSandboxService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const env = context.codeReviewConfig?.environment;
        if (!env?.enabled) return context;

        const vmSvc = this.vmSvc;
        if (!vmSvc.isAvailable()) {
            this.logger.log({
                message: 'Preview env enabled but no VM token configured (PREVIEW_VM_TOKEN/HCLOUD_TOKEN); skipping',
                context: this.stageName,
            });
            return context;
        }
        const apiKey = this.agentApiKey();
        if (!apiKey) {
            this.logger.warn({
                message: 'Preview env enabled but no agent LLM key configured; skipping',
                context: this.stageName,
            });
            return context;
        }
        if (!context.changedFiles?.length) return context;

        const isCli = context.origin === 'cli';
        const cliContext = isCli ? (context as unknown as CliReviewPipelineContext) : undefined;

        let vm: SandboxInstance | undefined;
        try {
            const cloneInfo = await this.cloneParamsResolver.resolve(context, cliContext);
            if (!cloneInfo) return context;

            vm = await vmSvc.createSandboxWithRepo({
                cloneUrl: cloneInfo.url,
                authToken: cloneInfo.authToken,
                authUsername: cloneInfo.authUsername,
                branch: cloneInfo.branch,
                baseBranch: cloneInfo.baseBranch,
                prNumber: cloneInfo.prNumber,
                platform: cloneInfo.platform,
                checkoutSha: cloneInfo.checkoutSha,
                sandboxMetadata: this.snapshotMetadata(context),
            });

            // Inject the app's secrets (the .env the booted app needs).
            const secrets = await this.resolveSecrets(context, env.requiredEnv);
            if (Object.keys(secrets).length) {
                const envFile = Object.entries(secrets)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n');
                await vm.writeFile('/opt/kody/customer.env', envFile);
            }

            const { ok, phases, scopeLabel } = await this.bootPlaybook(vm, env, context);

            // Run the bug-finding agent (execution-based, focus-aware).
            const exec = async (
                command: string,
                timeoutMs?: number,
            ): Promise<PreviewExecResult> => {
                const r = await vm!.run(command, { timeoutMs });
                return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode };
            };
            const model = this.configService.get<string>('PREVIEW_AGENT_MODEL') || DEFAULT_MODEL;
            const agentRes = await this.agent.run({
                apiKey,
                model,
                baseURL: model.startsWith('kimi')
                    ? 'https://api.kimi.com/coding'
                    : this.configService.get<string>('PREVIEW_AGENT_BASE_URL'),
                exec,
                diff: buildDiffFromChangedFiles(context.changedFiles),
                focus: context.reviewDirective,
            });

            const suggestions = findingsToSuggestions(agentRes.findings, context.reviewDirective);
            this.logger.log({
                message: `Preview env done (playbook ${ok ? 'ok' : 'failed'}, scope ${scopeLabel}, ${agentRes.findings.length} finding(s) → ${suggestions.length} after focus)`,
                context: this.stageName,
            });

            return this.updateContext(context, (draft) => {
                draft.validSuggestions = [
                    ...(draft.validSuggestions ?? []),
                    ...suggestions,
                ];
                draft.previewEnvSignal = {
                    ran: true,
                    ok,
                    scope: scopeLabel,
                    phases,
                };
            });
        } catch (error) {
            this.logger.error({
                message: 'Preview env stage threw; continuing review without it',
                context: this.stageName,
                error,
            });
            return context;
        } finally {
            if (vm) await vm.cleanup().catch(() => undefined);
        }
    }

    private async bootPlaybook(
        vm: SandboxInstance,
        env: NonNullable<CodeReviewPipelineContext['codeReviewConfig']>['environment'],
        context: CodeReviewPipelineContext,
    ): Promise<{
        ok: boolean;
        scopeLabel: string;
        phases: NonNullable<CodeReviewPipelineContext['previewEnvSignal']>['phases'];
    }> {
        const changedFiles = (context.changedFiles ?? []).map((f) => f.filename).filter(Boolean);
        const base = `origin/${env?.scope?.affected?.base ?? 'main'}`;
        const scoped = resolveScopedRun(env?.scope, changedFiles, base);
        const scopeLabel = scoped?.reason ?? 'full';

        // Playbook entries may be plain strings OR {name,type,command} objects
        // (the detect agent emits process-type services as objects). Normalize
        // to a command string; services get setsid-backgrounded.
        const phaseList: Array<{ phase: string; commands: Array<string | null> }> = [
            { phase: 'setup', commands: (env?.setup ?? []).map(normalizeCmd) },
            { phase: 'build', commands: (scoped ? scoped.build : env?.build ?? []).map(normalizeCmd) },
            {
                phase: 'services',
                commands: (env?.services ?? []).map((e) => {
                    const c = normalizeCmd(e);
                    return c ? wrapService(c) : null;
                }),
            },
            { phase: 'test', commands: (scoped ? scoped.test : env?.test ?? []).map(normalizeCmd) },
            { phase: 'healthcheck', commands: (env?.healthcheck ?? []).map(normalizeCmd) },
        ];

        const phases: NonNullable<CodeReviewPipelineContext['previewEnvSignal']>['phases'] = [];
        let ok = true;
        for (const { phase, commands } of phaseList) {
            for (const command of commands) {
                if (!command) continue;
                const r = await vm.run(command, { timeoutMs: PHASE_TIMEOUT_MS });
                phases.push({
                    phase,
                    command,
                    exitCode: r.exitCode,
                    outputTail: (r.stdout + r.stderr).slice(-2000),
                });
                if (r.exitCode !== 0) {
                    ok = false;
                    break;
                }
            }
            if (!ok) break;
        }
        return { ok, scopeLabel, phases };
    }

    private agentApiKey(): string | undefined {
        return (
            this.configService.get<string>('PREVIEW_AGENT_API_KEY') ||
            this.configService.get<string>('ANTHROPIC_API_KEY') ||
            undefined
        );
    }

    private snapshotMetadata(context: CodeReviewPipelineContext): Record<string, string> {
        // A per-repo golden-snapshot id would be resolved here (Phase 2 warm
        // boot). Left to config for the alpha; empty = cold boot.
        const repoId = context.repository?.id ?? '';
        const img = this.configService.get<string>(`PREVIEW_SNAPSHOT_${repoId}`);
        return img ? { snapshotImage: img } : {};
    }

    /**
     * Resolve the app secrets to inject. Alpha: from a config JSON keyed by
     * repo id (PREVIEW_ENV_SECRETS = {"<repoId>": {"KEY":"val"}}). Production:
     * an encrypted per-repo store (reuse the BYOK organizationParameters +
     * crypto pattern) — task tracked separately.
     */
    private async resolveSecrets(
        context: CodeReviewPipelineContext,
        requiredEnv?: string[],
    ): Promise<Record<string, string>> {
        const raw = this.configService.get<string>('PREVIEW_ENV_SECRETS');
        if (!raw) return {};
        try {
            const all = JSON.parse(raw) as Record<string, Record<string, string>>;
            const forRepo = all[context.repository?.id ?? ''] ?? {};
            if (!requiredEnv?.length) return forRepo;
            return Object.fromEntries(
                Object.entries(forRepo).filter(([k]) => requiredEnv.includes(k)),
            );
        } catch {
            return {};
        }
    }
}

/**
 * Background a long-running service so the exec returns instead of hanging.
 * setsid (not nohup) survives the exec's session; redirect OUTSIDE the bash -c
 * so the ssh channel's fds are freed (hard-won from the experiment).
 */
function wrapService(command: string): string {
    const escaped = command.replace(/'/g, `'\\''`);
    return `setsid bash -c '${escaped}' > /tmp/kody-svc.log 2>&1 < /dev/null & sleep 4`;
}

/**
 * A playbook entry is either a command string or an object carrying a
 * `command` field ({name,type:'process',command} for services,
 * {description,command} for annotated steps). Reduce to the command string;
 * anything else (declarative image specs, etc.) → null (skipped).
 */
function normalizeCmd(entry: unknown): string | null {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof (entry as any).command === 'string') {
        return (entry as any).command;
    }
    return null;
}
