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
import { PreviewEnvSecretsService } from '../services/preview-env-secrets.service';
import { PreviewEnvInfraService } from '../services/preview-env-infra.service';
import { PreviewEnvSnapshotService } from '../services/preview-env-snapshot.service';
import {
    parseRuntimeYaml,
    resolveRuntimePlaybook,
    RUNTIME_YAML_PATH,
} from '../services/runtime-playbook.service';
import { randomUUID } from 'crypto';
import {
    RuntimeRunRecord,
    redactPhases,
    redactSecrets,
    redactTranscript,
} from '../services/preview-env-run';
import { RuntimeRunRepository } from '../../infrastructure/adapters/repositories/runtimeRun.repository';
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
        // The encrypted per-repo secrets vault (settings UI → VM env).
        private readonly secretsService: PreviewEnvSecretsService,
        // Org-level "which cloud" config (self-hosted BYO-cloud from the UI).
        private readonly infraService: PreviewEnvInfraService,
        // Golden-snapshot registry for warm boot (skip cold install/build).
        private readonly snapshotService: PreviewEnvSnapshotService,
        // Durable store for the full run record (the PR-side viewer reads it).
        private readonly runRepository: RuntimeRunRepository,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const env = context.codeReviewConfig?.environment;
        if (!env?.enabled) return context;

        // Trigger gating: default is ON-DEMAND ('command') — a VM per PR has
        // real cost/latency, so unless the repo opted into 'auto', the stage
        // only runs when this run explicitly asked for it (@kody runtime on
        // the PR / --runtime on the CLI).
        const trigger = env.trigger ?? 'command';
        if (trigger !== 'auto' && !context.runtimeRequested) {
            this.logger.log({
                message: `Kody Runtime enabled with trigger '${trigger}' but not requested for this run; skipping`,
                context: this.stageName,
            });
            return context;
        }

        const vmSvc = this.vmSvc;
        // Org-level cloud config (self-hosted BYO-cloud) takes precedence over
        // the server-level env token; either one makes the stage runnable.
        const infra = context.organizationAndTeamData
            ? await this.infraService
                  .resolveInfra(context.organizationAndTeamData)
                  .catch(() => null)
            : null;
        if (!infra && !vmSvc.isAvailable()) {
            this.logger.log({
                message: 'Preview env enabled but no VM token configured (org infra config or PREVIEW_VM_TOKEN/HCLOUD_TOKEN); skipping',
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
        const startedAt = new Date().toISOString();
        try {
            const cloneInfo = await this.cloneParamsResolver.resolve(context, cliContext);
            if (!cloneInfo) return context;

            const snapshotImage = await this.resolveSnapshotImage(context, env);
            vm = await vmSvc.createSandboxWithRepo(
                {
                    cloneUrl: cloneInfo.url,
                    authToken: cloneInfo.authToken,
                    authUsername: cloneInfo.authUsername,
                    branch: cloneInfo.branch,
                    baseBranch: cloneInfo.baseBranch,
                    prNumber: cloneInfo.prNumber,
                    platform: cloneInfo.platform,
                    checkoutSha: cloneInfo.checkoutSha,
                    sandboxMetadata: snapshotImage ? { snapshotImage } : {},
                },
                infra ?? undefined,
            );

            // A committed `.kody/runtime.yml` is the single source of truth for
            // HOW to run (repo wins over the UI config; no merge). Activation
            // (enabled/trigger) stays a UI/org decision — already gated above.
            let effectiveEnv = env;
            try {
                const raw = await vm.readFile(RUNTIME_YAML_PATH);
                if (raw && raw.trim()) {
                    const resolved = resolveRuntimePlaybook(parseRuntimeYaml(raw), env);
                    effectiveEnv = resolved.config ?? env;
                    this.logger.log({
                        message: `Kody Runtime playbook source: ${resolved.source} (${RUNTIME_YAML_PATH} present)`,
                        context: this.stageName,
                    });
                }
            } catch (error) {
                this.logger.warn({
                    message: `Ignoring ${RUNTIME_YAML_PATH} (${(error as Error)?.message ?? error}); falling back to the UI config`,
                    context: this.stageName,
                });
            }

            // Inject the app's secrets (the .env the booted app needs).
            const secrets = await this.resolveSecrets(context, effectiveEnv.requiredEnv);
            if (Object.keys(secrets).length) {
                const envFile = Object.entries(secrets)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n');
                await vm.writeFile('/opt/kody/customer.env', envFile);
            }

            const { ok, phases, scopeLabel } = await this.bootPlaybook(vm, effectiveEnv, context);

            // Self-warm: freeze a COLD boot whose EXPENSIVE half succeeded (setup
            // + build: deps installed, images built, DB migrated) into a golden
            // image so the NEXT PR on this repo warm-boots in seconds instead of
            // re-running the whole cold install/build. Gated on the BUILD, NOT
            // the healthcheck: the snapshot bakes the build, and a strict runtime
            // healthcheck (e.g. an API still applying migrations → 000) must not
            // block caching it — the app is started fresh on every boot anyway,
            // and warm-boot's baked-migrated DB makes that healthcheck pass fast.
            // Captured BEFORE the agent so the base stays clean; skipped once a
            // fresh snapshot exists; opt-in; non-fatal.
            const buildOk = phases
                .filter((p) => p.phase === 'setup' || p.phase === 'build')
                .every((p) => p.exitCode === 0);
            if (!snapshotImage && buildOk) {
                await this.maybeCaptureSnapshot(vm, context, env).catch((error) =>
                    this.logger.warn({
                        message: 'Golden-snapshot capture failed (non-fatal)',
                        context: this.stageName,
                        error,
                    }),
                );
            }

            // Run the bug-finding agent (execution-based, focus-aware).
            const exec = async (
                command: string,
                timeoutMs?: number,
            ): Promise<PreviewExecResult> => {
                const r = await vm!.run(command, { timeoutMs });
                return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode };
            };
            // Drop the PR diff on the VM so the agent can `git apply -R` it for
            // base-vs-head differential testing (see prompt point 4b).
            await vm
                .writeFile(
                    '/opt/kody/pr.diff',
                    buildDiffFromChangedFiles(context.changedFiles),
                )
                .catch(() => undefined);
            const model = this.configService.get<string>('PREVIEW_AGENT_MODEL') || DEFAULT_MODEL;
            const agentRes = await this.agent.run({
                apiKey,
                model,
                // Explicit base-URL always wins (e.g. Moonshot pay-per-token
                // Anthropic surface); only fall back to the coding-plan endpoint
                // for kimi models when nothing is configured.
                baseURL:
                    this.configService.get<string>('PREVIEW_AGENT_BASE_URL') ||
                    (model.startsWith('kimi')
                        ? 'https://api.kimi.com/coding'
                        : undefined),
                exec,
                diff: buildDiffFromChangedFiles(context.changedFiles),
                focus: context.reviewDirective,
                // Heavy apps (register + drive many screens) need more headroom
                // than the 60-turn default; tunable per deployment.
                maxTurns:
                    Number(this.configService.get<string>('PREVIEW_AGENT_MAX_TURNS')) ||
                    undefined,
            });

            const runId = randomUUID();
            const runUrl = this.runViewerUrl(runId);
            const suggestions = findingsToSuggestions(
                agentRes.findings,
                context.reviewDirective,
                context.changedFiles,
                runUrl,
            );
            const offDiffCount = suggestions.filter((s) => s.postPrLevel).length;
            this.logger.log({
                message: `Preview env done (playbook ${ok ? 'ok' : 'failed'}, scope ${scopeLabel}, ${agentRes.findings.length} finding(s) → ${suggestions.length} suggestion(s); ${offDiffCount} off-diff [no changed line → may fail lines-mismatch])`,
                context: this.stageName,
            });

            // Strip the internal `postPrLevel` marker before the suggestions
            // enter the shared downstream. On-diff findings are anchored to a
            // real changed line (post inline cleanly); off-diff ones keep the
            // line-1 anchor and degrade gracefully in the comment manager
            // (3-attempt line-adjust → marked FAILED_LINES_MISMATCH + persisted
            // to Mongo, never silently dropped). The count is logged above.
            const clean = suggestions.map(({ postPrLevel, ...s }) => s);

            // Assemble the full, user-facing run record — everything the model
            // did + the environment output — with the injected secret VALUES
            // scrubbed everywhere (they appear in env/output). This is what the
            // PR-side viewer renders so the reviewer can see 100% of the run.
            const serviceLog = await vm
                .readFile('/tmp/kody-svc.log')
                .catch(() => '');
            const runtimeRun: RuntimeRunRecord = {
                runId,
                ran: true,
                ok,
                scope: scopeLabel,
                phases: redactPhases(phases, secrets),
                serviceLog: serviceLog
                    ? redactSecrets(serviceLog.slice(-20_000), secrets)
                    : undefined,
                transcript: redactTranscript(agentRes.transcript ?? [], secrets),
                summary: redactSecrets(agentRes.summary ?? '', secrets),
                findingsCount: agentRes.findings.length,
                turns: agentRes.turns,
                model,
                startedAt,
                finishedAt: new Date().toISOString(),
            };

            // Persist durably so the PR-side viewer can replay 100% of the run.
            // Non-fatal: a store hiccup must not fail the review.
            if (context.organizationAndTeamData?.organizationId) {
                await this.runRepository
                    .save({
                        runId,
                        organizationId: context.organizationAndTeamData.organizationId,
                        teamId: context.organizationAndTeamData.teamId,
                        repositoryId: context.repository?.id,
                        prNumber: context.pullRequest?.number,
                        record: runtimeRun,
                    })
                    .catch((error) =>
                        this.logger.warn({
                            message: 'Failed to persist runtime run record',
                            context: this.stageName,
                            error,
                        }),
                    );
            }

            return this.updateContext(context, (draft) => {
                draft.validSuggestions = [
                    ...(draft.validSuggestions ?? []),
                    ...clean,
                ];
                draft.previewEnvSignal = {
                    ran: true,
                    ok,
                    scope: scopeLabel,
                    phases,
                };
                draft.runtimeRun = runtimeRun;
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
                // The `services` phase is fire-and-forget: each service is
                // setsid-backgrounded, and backgrounding a long-running process
                // over SSH returns a spurious non-zero (255) even when the app
                // came up fine. Never gate readiness on it — the healthcheck is
                // the real gate (a crashed service fails the curl). Gating here
                // marked healthy runs as "playbook failed" and skipped the
                // healthcheck entirely.
                if (r.exitCode !== 0 && phase !== 'services') {
                    ok = false;
                    break;
                }
            }
            if (!ok) break;
        }
        return { ok, scopeLabel, phases };
    }

    /** The web viewer URL for a run, appended to findings so the reviewer can
     *  open the full session (transcript + logs) from the PR. */
    private runViewerUrl(runId: string): string | undefined {
        const base = this.configService.get<string>('API_FRONTEND_URL');
        return base ? `${base.replace(/\/$/, '')}/runtime-run/${runId}` : undefined;
    }

    private agentApiKey(): string | undefined {
        return (
            this.configService.get<string>('PREVIEW_AGENT_API_KEY') ||
            this.configService.get<string>('ANTHROPIC_API_KEY') ||
            undefined
        );
    }

    /**
     * The golden-snapshot image to warm-boot from, or undefined for a cold
     * boot. Prefers the per-repo registry (a snapshot whose fingerprint still
     * matches the current playbook), falling back to a static config override
     * (PREVIEW_SNAPSHOT_<repoId>) for ops/local use. Building/refreshing the
     * snapshot is a separate trigger — the review path only CONSUMES it, so a
     * missing/stale snapshot just means this PR cold-boots (never blocks).
     */
    private async resolveSnapshotImage(
        context: CodeReviewPipelineContext,
        env: NonNullable<CodeReviewPipelineContext['codeReviewConfig']>['environment'],
    ): Promise<string | undefined> {
        const repoId = context.repository?.id;
        if (context.organizationAndTeamData && repoId) {
            // v1 fingerprint = playbook only. Lockfile-SHA invalidation (rebuild
            // when deps change) is the follow-up — computeKey already accepts it.
            const key = this.snapshotService.computeKey(env);
            const fresh = await this.snapshotService
                .resolveFresh(context.organizationAndTeamData, repoId, key)
                .catch(() => null);
            if (fresh) {
                this.logger.log({
                    message: `Warm boot from snapshot ${fresh.imageId} (key ${key})`,
                    context: this.stageName,
                });
                return fresh.imageId;
            }
        }
        return this.configService.get<string>(`PREVIEW_SNAPSHOT_${repoId ?? ''}`) || undefined;
    }

    /**
     * Freeze a successful cold boot into a golden image and record it, so the
     * next PR on this repo warm-boots instead of re-running the cold
     * install/build. Opt-in (PREVIEW_SNAPSHOT_CAPTURE=true), best-effort, and
     * one-time per playbook fingerprint — once a fresh snapshot exists the next
     * run warm-boots and never reaches here. Uses the SAME fingerprint (`env`)
     * as resolveSnapshotImage so resolve and capture agree, and GCs the
     * superseded image.
     */
    private async maybeCaptureSnapshot(
        vm: SandboxInstance,
        context: CodeReviewPipelineContext,
        env: NonNullable<CodeReviewPipelineContext['codeReviewConfig']>['environment'],
    ): Promise<void> {
        const repoId = context.repository?.id;
        if (
            this.configService.get<string>('PREVIEW_SNAPSHOT_CAPTURE') !== 'true' ||
            !vm.snapshot ||
            !context.organizationAndTeamData ||
            !repoId
        ) {
            return;
        }
        const key = this.snapshotService.computeKey(env);
        this.logger.log({
            message: `Capturing golden snapshot for ${repoId} (key ${key})…`,
            context: this.stageName,
        });
        // Flush pending writes to disk before the (crash-consistent) image is
        // taken — otherwise a running app's half-written files (e.g. a truncated
        // package.json in node_modules) get baked in and break the warm boot.
        await vm.run('sync', { timeoutMs: 60_000 }).catch(() => undefined);
        const imageId = await vm.snapshot(`kody-runtime ${repoId} ${key}`);
        const previous = await this.snapshotService.record(
            context.organizationAndTeamData,
            repoId,
            { imageId, key, region: this.configService.get<string>('PREVIEW_VM_REGION') },
        );
        this.logger.log({
            message: `Golden snapshot ${imageId} recorded for ${repoId} (key ${key}); next PR warm-boots`,
            context: this.stageName,
        });
        if (previous?.imageId && previous.imageId !== imageId && vm.deleteImage) {
            await vm.deleteImage(previous.imageId).catch(() => undefined);
        }
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
        // Preferred: the encrypted per-repo vault (configured in the settings
        // UI). Reads decrypted values only here, at injection time.
        const repoId = context.repository?.id;
        if (context.organizationAndTeamData && repoId) {
            const fromVault = await this.secretsService
                .resolveSecrets(context.organizationAndTeamData, repoId, requiredEnv)
                .catch(() => ({}));
            if (Object.keys(fromVault).length) return fromVault;
        }
        // Fallback: a config JSON (PREVIEW_ENV_SECRETS) for local/ops use.
        const raw = this.configService.get<string>('PREVIEW_ENV_SECRETS');
        if (!raw) return {};
        try {
            const all = JSON.parse(raw) as Record<string, Record<string, string>>;
            const forRepo = all[repoId ?? ''] ?? {};
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
