/**
 * T0 authoring-time compiler (issue #1449). Runs ONCE when a kody-rule is
 * created/edited: asks the LLM to compile the rule into a deterministic
 * detector, runs the compile-time gate, and — only if the gate passes —
 * persists the detector onto the rule. From then on that rule is checked at
 * review time by pure regex (no LLM). Best-effort: any failure leaves the rule
 * semantic, never blocks the save.
 *
 * Model: the customer's BYOK model (self-hosted requirement) with a system
 * fallback. The gate makes model quality safe — a weaker model just yields
 * fewer T0 rules, never a wrong detector.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { createLogger } from '@libs/core/log/logger';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { IKodyRuleDetectorCompiler } from '@libs/kodyRules/domain/contracts/kody-rule-detector-compiler.contract';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    compileRuleDetector,
    compilerOutputSchema,
    makeLLMRunCompiler,
    type CompilerOutput,
} from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler';

@Injectable()
export class KodyRuleDetectorCompilerService
    implements IKodyRuleDetectorCompiler
{
    private readonly logger = createLogger(
        KodyRuleDetectorCompilerService.name,
    );

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly permissionValidationService: PermissionValidationService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    /**
     * Compile the rule and persist the detector if the gate passes. Clears any
     * stale detector when an edited rule no longer compiles. Swallows errors
     * (the rule simply stays semantic) — this runs fire-and-forget after save.
     */
    async compileAndSave(
        organizationAndTeamData: OrganizationAndTeamData,
        ruleUuid: string,
        rule: Partial<IKodyRule>,
    ): Promise<{ compiled: boolean; declineReason?: string }> {
        try {
            const byokConfig =
                await this.permissionValidationService.getBYOKConfig(
                    organizationAndTeamData,
                );

            const runner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                LLMModelProvider.GEMINI_2_5_FLASH,
                LLMModelProvider.GEMINI_2_5_PRO,
                byokConfig,
            );

            const runCompiler = makeLLMRunCompiler(async ({ system, user }) => {
                const parsed = await runner
                    .builder()
                    .setParser(ParserType.ZOD, compilerOutputSchema)
                    .setLLMJsonMode(true)
                    .addPrompt({ role: PromptRole.SYSTEM, prompt: system })
                    .addPrompt({ role: PromptRole.USER, prompt: user })
                    .setRunName('kody-rules.detector-compiler')
                    .execute();
                return (parsed as CompilerOutput) ?? null;
            });

            const { detector, declineReason } = await compileRuleDetector(
                rule,
                runCompiler,
                { modelName: runner.executeMode },
            );

            const orgId = organizationAndTeamData.organizationId;
            if (detector) {
                await this.kodyRulesService.updateRuleDetector(
                    orgId,
                    ruleUuid,
                    detector,
                );
                this.logger.log({
                    message: `Compiled T0 detector for rule ${ruleUuid}`,
                    context: KodyRuleDetectorCompilerService.name,
                    metadata: { ruleUuid, pattern: detector.pattern },
                });
                return { compiled: true };
            }
            // Edited rule that used to be mechanical but no longer is:
            // clear the stale detector so review stops using it.
            if (rule.detector) {
                await this.kodyRulesService.updateRuleDetector(
                    orgId,
                    ruleUuid,
                    null,
                );
            }
            this.logger.log({
                message: `Rule ${ruleUuid} stays semantic (${declineReason})`,
                context: KodyRuleDetectorCompilerService.name,
                metadata: { ruleUuid, declineReason },
            });
            return { compiled: false, declineReason };
        } catch (error) {
            this.logger.warn({
                message: `Detector compile failed for rule ${ruleUuid}; rule stays semantic`,
                context: KodyRuleDetectorCompilerService.name,
                error,
                metadata: { ruleUuid },
            });
            return { compiled: false, declineReason: 'error' };
        }
    }
}
