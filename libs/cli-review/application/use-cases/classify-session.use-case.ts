import { createLogger } from '@kodus/flow';
import {
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import {
    CliSessionClassifiedDecision,
    CliSessionDecisionType,
} from '@libs/cli-review/domain/types/cli-session-capture.types';
import { SessionEventRepository } from '@libs/cli-review/infrastructure/repositories/session-event.repository';
import { SessionEventModel } from '@libs/cli-review/infrastructure/repositories/schemas/session-event.model';

const LLMDecisionSchema = z.object({
    type: z.enum([
        'architectural_decision',
        'convention',
        'tradeoff',
        'implementation_detail',
        'tooling',
        'other',
    ]),
    decision: z.string().min(1).max(600),
    rationale: z.string().max(1000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    evidence: z.array(z.string().max(300)).max(5).optional(),
});

const LLMDecisionExtractionSchema = z.object({
    decisions: z.array(LLMDecisionSchema).max(12),
});

interface AggregatedSession {
    agentType?: string;
    gitRemote?: string;
    prompts: string[];
    toolCalls: string[];
    filesModified: string[];
    filesRead: string[];
    commands: string[];
    subagents: Array<{ type?: string; task?: string }>;
}

@Injectable()
export class ClassifySessionUseCase {
    private readonly logger = createLogger(ClassifySessionUseCase.name);

    constructor(
        private readonly sessionEventRepository: SessionEventRepository,
        private readonly promptRunnerService: PromptRunnerService,
    ) {}

    async execute(sessionEndEventUuid: string): Promise<void> {
        const sessionEndEvent =
            await this.sessionEventRepository.findByUuid(sessionEndEventUuid);

        if (!sessionEndEvent) {
            this.logger.warn({
                message: 'Session end event not found for classification',
                context: ClassifySessionUseCase.name,
                metadata: { sessionEndEventUuid },
            });
            return;
        }

        if (sessionEndEvent.type !== 'session_end') {
            await this.sessionEventRepository.markClassificationSkipped(
                sessionEndEventUuid,
                `Unsupported event type: ${sessionEndEvent.type}`,
            );
            return;
        }

        const allEvents = await this.sessionEventRepository.findBySessionId(
            sessionEndEvent.sessionId,
            sessionEndEvent.organizationId,
        );

        const aggregated = this.aggregateEvents(allEvents);

        if (!this.hasUsefulContent(aggregated)) {
            await this.sessionEventRepository.markClassificationSkipped(
                sessionEndEventUuid,
                'No textual context for classification',
            );
            return;
        }

        await this.sessionEventRepository.markClassificationProcessing(
            sessionEndEventUuid,
        );

        try {
            const decisions = await this.extractWithLLM(aggregated);
            if (decisions.length > 0) {
                await this.sessionEventRepository.markClassificationCompleted(
                    sessionEndEventUuid,
                    decisions,
                    'llm',
                );
                return;
            }

            const fallback = this.extractWithHeuristics(aggregated);
            await this.sessionEventRepository.markClassificationCompleted(
                sessionEndEventUuid,
                fallback,
                fallback.length > 0 ? 'heuristic' : 'empty',
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'LLM classification failed for session, using fallback',
                context: ClassifySessionUseCase.name,
                metadata: {
                    sessionEndEventUuid,
                    error: this.safeErrorMessage(error),
                },
            });

            try {
                const fallback = this.extractWithHeuristics(aggregated);
                await this.sessionEventRepository.markClassificationCompleted(
                    sessionEndEventUuid,
                    fallback,
                    fallback.length > 0 ? 'heuristic-fallback' : 'empty',
                );
            } catch (fallbackError) {
                await this.sessionEventRepository.markClassificationFailed(
                    sessionEndEventUuid,
                    this.safeErrorMessage(fallbackError),
                );
            }
        }
    }

    private aggregateEvents(events: SessionEventModel[]): AggregatedSession {
        const aggregated: AggregatedSession = {
            prompts: [],
            toolCalls: [],
            filesModified: [],
            filesRead: [],
            commands: [],
            subagents: [],
        };

        for (const event of events) {
            const p = event.payload || {};

            switch (event.type) {
                case 'session_start':
                    aggregated.agentType = p.agentType as string | undefined;
                    aggregated.gitRemote = p.gitRemote as string | undefined;
                    break;

                case 'turn_start':
                    if (typeof p.prompt === 'string' && p.prompt.trim()) {
                        aggregated.prompts.push(p.prompt as string);
                    }
                    break;

                case 'turn_end':
                    if (Array.isArray(p.toolCalls)) {
                        for (const tc of p.toolCalls) {
                            if (typeof tc === 'string') {
                                aggregated.toolCalls.push(tc);
                            } else if (tc?.toolName || tc?.tool) {
                                const name = tc.toolName ?? tc.tool;
                                aggregated.toolCalls.push(
                                    tc.summary
                                        ? `${name}: ${tc.summary}`
                                        : name,
                                );
                            }
                        }
                    }
                    if (Array.isArray(p.filesModified)) {
                        for (const fm of p.filesModified) {
                            if (typeof fm === 'string') {
                                aggregated.filesModified.push(fm);
                            } else if (fm?.path) {
                                aggregated.filesModified.push(fm.path);
                            }
                        }
                    }
                    if (Array.isArray(p.filesRead)) {
                        aggregated.filesRead.push(
                            ...(p.filesRead as string[]),
                        );
                    }
                    if (Array.isArray(p.commands)) {
                        aggregated.commands.push(
                            ...(p.commands as string[]),
                        );
                    }
                    break;

                case 'subagent_start':
                    aggregated.subagents.push({
                        type: p.subagentType as string | undefined,
                        task: p.taskDescription as string | undefined,
                    });
                    break;
            }
        }

        // Deduplicate file lists
        aggregated.filesModified = [...new Set(aggregated.filesModified)];
        aggregated.filesRead = [...new Set(aggregated.filesRead)];

        return aggregated;
    }

    private hasUsefulContent(aggregated: AggregatedSession): boolean {
        return (
            aggregated.prompts.length > 0 ||
            aggregated.toolCalls.length > 0 ||
            aggregated.filesModified.length > 0 ||
            aggregated.subagents.length > 0
        );
    }

    private async extractWithLLM(
        aggregated: AggregatedSession,
    ): Promise<CliSessionClassifiedDecision[]> {
        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            LLMModelProvider.CEREBRAS_GLM_47,
            LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
        );

        const systemPrompt = [
            'You are classifying a complete coding session into reusable decisions.',
            '',
            'Return ONLY JSON with shape:',
            '{ "decisions": [ { "type": "...", "decision": "...", "rationale": "...", "confidence": 0.0, "evidence": ["..."] } ] }',
            '',
            'Allowed decision types:',
            '- architectural_decision: high-level structure or system choice',
            '- convention: team style/naming/process convention',
            '- tradeoff: explicit compromise between options',
            '- implementation_detail: concrete technical implementation choice',
            '- tooling: tool or framework choice',
            '- other: valid but uncategorized decision',
            '',
            'Rules:',
            '- Extract only concrete choices, not generic statements.',
            '- Keep each "decision" concise and self-contained.',
            '- confidence must be between 0 and 1.',
            '- Consider the full session context: user prompts, tool calls, modified files, and subagents.',
            '- If nothing useful exists, return { "decisions": [] }.',
        ].join('\n');

        const userPayload = {
            agentType: aggregated.agentType || '',
            gitRemote: aggregated.gitRemote || '',
            prompts: aggregated.prompts.slice(0, 20),
            toolCalls: aggregated.toolCalls.slice(0, 50),
            filesModified: aggregated.filesModified.slice(0, 30),
            filesRead: aggregated.filesRead.slice(0, 20),
            commands: aggregated.commands.slice(0, 20),
            subagents: aggregated.subagents.slice(0, 10),
        };

        const result = await promptRunner
            .builder()
            .setParser(ParserType.ZOD, LLMDecisionExtractionSchema)
            .setLLMJsonMode(true)
            .setTemperature(0)
            .setPayload(userPayload)
            .addPrompt({
                role: PromptRole.SYSTEM,
                prompt: systemPrompt,
            })
            .addPrompt({
                role: PromptRole.USER,
                prompt: JSON.stringify(userPayload),
            })
            .setRunName('classifySession')
            .execute();

        const rawDecisions = result?.decisions ?? [];
        return rawDecisions.map((decision) => {
            const normalizedConfidence = this.normalizeConfidence(
                decision.confidence,
            );
            const normalizedType = decision.type as CliSessionDecisionType;

            return {
                type: normalizedType,
                decision: this.trim(decision.decision, 500),
                rationale: decision.rationale
                    ? this.trim(decision.rationale, 1000)
                    : undefined,
                confidence: normalizedConfidence,
                evidence: (decision.evidence || [])
                    .map((item) => this.trim(item, 300))
                    .filter(Boolean)
                    .slice(0, 5),
                autoPromoteCandidate: this.shouldAutoPromote(
                    normalizedType,
                    normalizedConfidence,
                ),
            };
        });
    }

    private extractWithHeuristics(
        aggregated: AggregatedSession,
    ): CliSessionClassifiedDecision[] {
        const sourceText = aggregated.prompts.join('\n');

        if (!sourceText) {
            return [];
        }

        const sentences = sourceText
            .split(/\n+|(?<=[.!?])\s+/g)
            .map((sentence) => sentence.trim())
            .filter(Boolean)
            .slice(0, 80);

        const candidateSentences = sentences.filter((sentence) =>
            /(decid|because|trade[- ]?off|prefer|chose|choose|adopt|use|convention|pattern|standard)/i.test(
                sentence,
            ),
        );

        const selected =
            candidateSentences.length > 0
                ? candidateSentences.slice(0, 8)
                : sentences.slice(0, 3);

        const evidence = aggregated.filesModified.slice(0, 3);

        return selected.map((sentence) => {
            const type = this.inferDecisionType(sentence);
            const confidence = candidateSentences.length > 0 ? 0.35 : 0.2;

            return {
                type,
                decision: this.trim(sentence, 500),
                confidence,
                evidence,
                autoPromoteCandidate: this.shouldAutoPromote(type, confidence),
            };
        });
    }

    private inferDecisionType(text: string): CliSessionDecisionType {
        const value = text.toLowerCase();

        if (
            /(architecture|architectural|layer|module|schema|database|queue|event|service boundary|system design)/.test(
                value,
            )
        ) {
            return 'architectural_decision';
        }

        if (/(convention|style|naming|format|lint|folder structure)/.test(value)) {
            return 'convention';
        }

        if (/(trade[- ]?off|versus|vs\.|instead of|however|but)/.test(value)) {
            return 'tradeoff';
        }

        if (
            /(tool|framework|library|package|cursor|codex|claude|cli|sdk|dependency)/.test(
                value,
            )
        ) {
            return 'tooling';
        }

        if (
            /(implement|refactor|validation|jwt|cache|middleware|repository|endpoint|handler)/.test(
                value,
            )
        ) {
            return 'implementation_detail';
        }

        return 'other';
    }

    private shouldAutoPromote(
        type: CliSessionDecisionType,
        confidence?: number,
    ): boolean {
        if (typeof confidence !== 'number') {
            return false;
        }

        return (
            confidence >= 0.7 &&
            ['architectural_decision', 'convention', 'tradeoff'].includes(type)
        );
    }

    private normalizeConfidence(value?: number): number | undefined {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            return undefined;
        }

        return Math.max(0, Math.min(1, value));
    }

    private trim(value: string, maxLength: number): string {
        if (!value) {
            return value;
        }

        return value.length <= maxLength
            ? value
            : `${value.slice(0, maxLength - 3)}...`;
    }

    private safeErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return 'Unknown error';
    }
}
