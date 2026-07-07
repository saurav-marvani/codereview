import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { VmSandboxService } from '@libs/sandbox/infrastructure/providers/vm-sandbox.service';
import { PreviewEnvDetectService } from '@libs/sandbox/infrastructure/services/preview-env-detect.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PreviewEnvInfraService } from './preview-env-infra.service';
import {
    parseRuntimeYaml,
    dumpRuntimeYaml,
    RuntimeEnvironmentConfig,
    RUNTIME_YAML_PATH,
} from './runtime-playbook.service';

/**
 * Orchestrates the "Generate config" button: spin up an ephemeral VM with the
 * repo cloned, run the detect agent to draft a `.kody/runtime.yml` playbook,
 * validate it with the canonical parser, and return it for the user to review +
 * save (to the UI or commit as YAML). Always tears the VM down.
 *
 * This is expensive (a VM boot + an agent run, minutes) — the caller runs it
 * out-of-band and stores the result; the HTTP layer must not block on it.
 */
export interface GeneratePlaybookInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string; defaultBranch?: string };
    platformType: string;
    branch?: string;
}

export interface GeneratePlaybookResult {
    success: boolean;
    summary: string;
    /** The playbook as YAML — save this to the repo or import into the UI. */
    playbookYaml: string | null;
    /** The validated, canonical config object (null if the draft was invalid). */
    config: RuntimeEnvironmentConfig | null;
    /** Env var NAMES the app needs — tells the user what to put in the vault. */
    requiredEnv: string[];
    /** True when the agent booted the app and its healthcheck passed. */
    verified: boolean;
    error?: string;
}

@Injectable()
export class PreviewEnvGenerateService {
    private readonly logger = createLogger(PreviewEnvGenerateService.name);

    constructor(
        private readonly config: ConfigService,
        private readonly vmSvc: VmSandboxService,
        private readonly detectAgent: PreviewEnvDetectService,
        private readonly infraService: PreviewEnvInfraService,
        private readonly codeManagement: CodeManagementService,
    ) {}

    private agentApiKey(): string | undefined {
        return (
            this.config.get<string>('PREVIEW_AGENT_API_KEY') ||
            this.config.get<string>('API_ANTHROPIC_API_KEY') ||
            this.config.get<string>('ANTHROPIC_API_KEY')
        );
    }

    async generate(input: GeneratePlaybookInput): Promise<GeneratePlaybookResult> {
        const fail = (error: string): GeneratePlaybookResult => ({
            success: false,
            summary: '',
            playbookYaml: null,
            config: null,
            requiredEnv: [],
            verified: false,
            error,
        });

        const apiKey = this.agentApiKey();
        if (!apiKey) return fail('No agent LLM key configured (PREVIEW_AGENT_API_KEY).');

        const infra = await this.infraService
            .resolveInfra(input.organizationAndTeamData)
            .catch(() => null);
        if (!infra && !this.vmSvc.isAvailable()) {
            return fail('No VM token configured (org infra config or PREVIEW_VM_TOKEN).');
        }

        // Resolve the repo's clone URL + auth from the org's git integration.
        const cloneParams: any = await this.codeManagement.getCloneParams(
            {
                repository: input.repository as any,
                organizationAndTeamData: input.organizationAndTeamData,
            },
            input.platformType as any,
        );
        if (!cloneParams?.url) return fail('Could not resolve the repository clone URL.');

        const branch = input.branch || input.repository.defaultBranch;
        let vm: Awaited<ReturnType<VmSandboxService['createSandboxWithRepo']>> | undefined;
        try {
            vm = await this.vmSvc.createSandboxWithRepo(
                {
                    cloneUrl: cloneParams.url,
                    authToken: cloneParams.auth?.token || undefined,
                    authUsername: cloneParams.auth?.username || undefined,
                    branch,
                    baseBranch: branch,
                    platform: input.platformType as any,
                },
                infra ?? undefined,
            );

            const model =
                this.config.get<string>('PREVIEW_AGENT_MODEL') || 'claude-sonnet-5';
            const baseURL = this.config.get<string>('PREVIEW_AGENT_BASE_URL') || undefined;

            const detected = await this.detectAgent.detect({
                apiKey,
                model,
                baseURL,
                hasCustomerEnv: false,
                exec: async (command, timeoutMs) => {
                    const r = await vm!.run(command, { timeoutMs });
                    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode };
                },
            });

            if (!detected.playbookYaml) {
                return {
                    success: false,
                    summary: detected.summary,
                    playbookYaml: null,
                    config: null,
                    requiredEnv: [],
                    verified: false,
                    error: 'The detect agent could not produce a playbook.',
                };
            }

            // Authoritative validation with the canonical parser. Re-dump so the
            // YAML we hand back is normalized + guaranteed to round-trip.
            let config: RuntimeEnvironmentConfig | null = null;
            let playbookYaml = detected.playbookYaml;
            try {
                config = parseRuntimeYaml(detected.playbookYaml);
                playbookYaml = dumpRuntimeYaml(config);
            } catch (e: any) {
                this.logger.warn({
                    message: `Detect agent emitted an invalid ${RUNTIME_YAML_PATH}: ${e?.message ?? e}`,
                    context: PreviewEnvGenerateService.name,
                });
                return {
                    success: false,
                    summary: detected.summary,
                    playbookYaml: detected.playbookYaml,
                    config: null,
                    requiredEnv: [],
                    verified: false,
                    error: `Generated playbook failed validation: ${e?.message ?? e}`,
                };
            }

            return {
                success: true,
                summary: detected.summary,
                playbookYaml,
                config,
                requiredEnv: config.requiredEnv ?? [],
                verified: detected.success,
            };
        } catch (error: any) {
            this.logger.error({
                message: 'Playbook generation failed',
                context: PreviewEnvGenerateService.name,
                error,
            });
            return fail(String(error?.message ?? error));
        } finally {
            if (vm) await vm.cleanup().catch(() => undefined);
        }
    }
}
