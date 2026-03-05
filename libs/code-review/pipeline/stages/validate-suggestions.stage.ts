import { createLogger } from '@kodus/flow';
import {
    AST_ANALYSIS_SERVICE_TOKEN,
    IASTAnalysisService,
} from '@libs/code-review/domain/contracts/ASTAnalysisService.contract';
import {
    SUPPORTED_LANGUAGES,
    SyntaxCheckRequest,
    ValidationCandidate,
} from '@libs/code-review/domain/types/astValidate.type';
import posthog, { FEATURE_FLAGS } from '@libs/common/utils/posthog';
import { PlatformType } from '@libs/core/domain/enums';
import {
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { TaskStatus } from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';
import { applyEdit } from '@morphllm/morphsdk';
import { Inject, Injectable } from '@nestjs/common';
import { parsePatch } from 'diff';
import pLimit from 'p-limit';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { estimateTokens } from '@libs/code-review/infrastructure/adapters/services/utils/token-estimator';

@Injectable()
export class ValidateSuggestionsStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName: string = 'ValidateSuggestionsStage';
    private readonly logger = createLogger(ValidateSuggestionsStage.name);

    private readonly CONCURRENCY_LIMIT = 10;
    private readonly MAX_LINES_THRESHOLD = 15;
    private readonly MAX_CHARS_THRESHOLD = 1000;

    constructor(
        @Inject(AST_ANALYSIS_SERVICE_TOKEN)
        private readonly astAnalysisService: IASTAnalysisService,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!(await this.shouldRunStage(context))) return context;

        const {
            validSuggestions,
            changedFiles,
            organizationAndTeamData,
            pullRequest,
        } = context;
        const prNumber = pullRequest.number;

        try {
            const filtered = await this.filterSuggestions(
                validSuggestions,
                context,
            );

            if (filtered.length === 0) {
                this.logGeneral(
                    'All suggestions filtered out as too complex/long/incompatible',
                    {
                        organizationAndTeamData,
                        prNumber,
                    },
                );

                return context;
            }

            const maxInputTokens =
                context.codeReviewConfig?.byokConfig?.main?.maxInputTokens;

            const candidates = await this.prepareValidationCandidates(
                filtered,
                changedFiles,
                maxInputTokens,
            );

            if (candidates.length === 0) {
                this.logGeneral('No patched files generated for validation', {
                    validSuggestions,
                    changedFiles,
                    organizationAndTeamData,
                    prNumber,
                });

                return context;
            }

            const validIds = await this.performFullValidation(
                candidates,
                organizationAndTeamData,
                prNumber,
            );

            const updatedSuggestions = this.mapValidationResults(
                validSuggestions,
                candidates,
                validIds,
            );

            return this.updateContext(context, (draft) => {
                draft.validSuggestions = updatedSuggestions;
            });
        } catch (error) {
            this.logError('Error during validation process', error, {
                organizationAndTeamData,
                prNumber,
            });

            throw new Error(
                StageMessageHelper.error(
                    PipelineReasons.SUGGESTIONS.VALIDATION_FAILED.message,
                    error,
                ),
            );
        }
    }

    private async shouldRunStage(context: CodeReviewPipelineContext) {
        const {
            organizationAndTeamData,
            pullRequest,
            platformType,
            codeReviewConfig,
            validSuggestions,
            changedFiles,
        } = context;

        const prNumber = pullRequest.number;

        const featureFlag = await posthog.isFeatureEnabled(
            FEATURE_FLAGS.committableSuggestions,
            organizationAndTeamData.organizationId,
            organizationAndTeamData,
        );

        if (!featureFlag) {
            this.logGeneral('Committable suggestions feature is disabled', {
                organizationAndTeamData,
                prNumber,
            });

            return false;
        }

        if (!codeReviewConfig?.enableCommittableSuggestions) {
            this.logGeneral(
                'Committable suggestions feature is disabled in the configuration',
                {
                    organizationAndTeamData,
                    prNumber,
                },
            );

            return false;
        }

        if (platformType !== PlatformType.GITHUB) {
            this.logGeneral(
                'Skipping validation stage for non-GitHub platform',

                {
                    platformType,
                    prNumber,
                    organizationAndTeamData,
                },
            );

            return false;
        }

        if (!validSuggestions?.length || !changedFiles?.length) {
            this.logGeneral(
                'No valid suggestions or changed files to validate',

                {
                    organizationAndTeamData,
                    prNumber,
                    validSuggestionsCount: validSuggestions?.length || 0,
                    changedFilesCount: changedFiles?.length || 0,
                },
            );

            return false;
        }

        return true;
    }

    private async performFullValidation(
        candidates: ValidationCandidate[],
        orgData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<Set<string>> {
        const payload: SyntaxCheckRequest = {
            files: candidates.map(
                ({ id, encodedData, language, filePath }) => ({
                    id,
                    encodedData,
                    language,
                    filePath,
                }),
            ),
        };

        const { taskId } = await this.astAnalysisService.startValidate(payload);

        const taskRes = await this.astAnalysisService.awaitTask(
            taskId,
            orgData,
        );
        if (taskRes?.task?.status !== TaskStatus.TASK_STATUS_COMPLETED) {
            throw new Error(
                `Validation task ${taskId} incomplete: ${taskRes?.task?.status}`,
            );
        }

        const astResults = await this.astAnalysisService.getValidate(
            taskId,
            orgData,
        );
        if (!astResults) {
            throw new Error('No results returned from AST validation');
        }

        const validAstItems = astResults.results.filter(
            (r) => r.isValid && r.id,
        );
        const candidateMap = new Map(candidates.map((c) => [c.id, c]));

        const limit = pLimit(this.CONCURRENCY_LIMIT);
        const llmValidations = validAstItems.map((item) =>
            limit(async () => {
                const candidate = candidateMap.get(item.id);
                if (!candidate) {
                    this.logWarn(`No candidate found for AST valid item`, {
                        id: item.id,
                        filePath: item.filePath,
                        prNumber,
                        orgData,
                    });
                    return null;
                }

                const isValid = await this.validateWithLLM(
                    taskId,
                    candidate,
                    orgData,
                    prNumber,
                );
                return isValid ? item.id : null;
            }),
        );

        const llmResults = await Promise.allSettled(llmValidations);
        const validIds = llmResults
            .map((res) => (res.status === 'fulfilled' ? res.value : null))
            .filter((id): id is string => id !== null);

        return new Set(validIds);
    }

    private async validateWithLLM(
        taskId: string,
        candidate: ValidationCandidate,
        orgData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<boolean> {
        try {
            const code = Buffer.from(candidate.encodedData, 'base64').toString(
                'utf-8',
            );
            const res = await this.astAnalysisService.validateWithLLM(
                taskId,
                {
                    code,
                    filePath: candidate.filePath,
                    diff: candidate.diff,
                    language: candidate.language,
                },
                orgData,
                prNumber,
            );
            return !!res?.isValid;
        } catch (error) {
            this.logError('LLM validation error', error, { id: candidate.id });
            return false;
        }
    }

    private mapValidationResults(
        originalSuggestions: Partial<CodeSuggestion>[],
        candidates: ValidationCandidate[],
        validIds: Set<string>,
    ): Partial<CodeSuggestion>[] {
        const candidateMap = new Map(candidates.map((c) => [c.id, c]));

        return originalSuggestions.map((suggestion) => {
            if (!suggestion.id || !validIds.has(suggestion.id))
                return suggestion;

            const candidate = candidateMap.get(suggestion.id);
            if (!candidate) return suggestion;

            return {
                ...suggestion,
                isCommittable: true,
                validatedData: {
                    code: candidate.suggestion,
                    diff: candidate.diff,
                    lineStart: candidate.newLineStart,
                    lineEnd: candidate.newLineEnd,
                },
            };
        });
    }

    private getFormattedSuggestionFromDiff(diff: string): {
        code: string;
        startLine: number;
        endLine: number;
    } | null {
        const parsedDiff = parsePatch(diff);

        if (parsedDiff.length !== 1) {
            this.logWarn(
                'Suggestion diff affects multiple files, marking as complex.',

                { diff },
            );

            return null;
        }

        const fileDiff = parsedDiff[0];

        if (fileDiff.hunks.length !== 1) {
            this.logWarn(
                'Suggestion contains multiple hunks, marking as complex.',
                { diff },
            );

            return null;
        }

        const hunk = fileDiff.hunks[0];

        if (hunk.lines.length > this.MAX_LINES_THRESHOLD) {
            this.logWarn(
                'Suggestion hunk exceeds maximum line threshold, marking as complex.',
                {
                    linesCount: hunk.lines.length,
                    diff,
                },
            );

            return null;
        }

        const charCount = hunk.lines.reduce(
            (acc, line) => acc + line.trim().length,
            0,
        );

        if (charCount > this.MAX_CHARS_THRESHOLD) {
            this.logWarn(
                'Suggestion hunk exceeds maximum character threshold, marking as complex.',
                {
                    charCount: hunk.lines.reduce(
                        (acc, line) => acc + line.length,
                        0,
                    ),
                    diff,
                },
            );

            return null;
        }

        const suggestionLines: string[] = [];

        let currentLineNum = hunk.oldStart;
        let firstAddedLineNum: number | null = null;
        let lastAddedLineNum: number | null = null;

        for (const line of hunk.lines) {
            const indicator = line[0];

            if (indicator === '+') {
                if (!line.startsWith('+++')) {
                    suggestionLines.push(line.slice(1));
                }
            } else if (indicator === '-') {
                if (firstAddedLineNum === null) {
                    firstAddedLineNum = currentLineNum;
                }

                lastAddedLineNum = currentLineNum;

                currentLineNum++;
            } else if (indicator !== '\\') {
                currentLineNum++;
            }
        }

        if (firstAddedLineNum === null || lastAddedLineNum === null) {
            this.logWarn(
                'No added lines found in suggestion hunk, marking as complex.',
                { diff },
            );

            return null;
        }

        return {
            code: suggestionLines.join('\n'),
            startLine: firstAddedLineNum,
            endLine: lastAddedLineNum,
        };
    }

    private async filterSuggestions(
        suggestions: Partial<CodeSuggestion>[],
        context: CodeReviewPipelineContext,
    ): Promise<Partial<CodeSuggestion>[]> {
        const limit = pLimit(this.CONCURRENCY_LIMIT);

        const tasks = suggestions.map((suggestion) =>
            limit(async () => {
                const filePath = suggestion.relevantFile;
                const code = suggestion.improvedCode || '';
                const lines = code.split('\n').length;
                const chars = code.length;

                // Language Support Check
                if (!filePath || !this.isLanguageSupported(filePath)) {
                    this.logDiscard(
                        suggestion.id,
                        'Unsupported language',
                        { filePath },
                        context,
                    );
                    return null;
                }

                // Threshold Check
                if (
                    chars >= this.MAX_CHARS_THRESHOLD ||
                    lines >= this.MAX_LINES_THRESHOLD
                ) {
                    this.logDiscard(
                        suggestion.id,
                        'Threshold exceeded',
                        { lines, chars },
                        context,
                    );
                    return null;
                }

                // AST Simplicity Check
                try {
                    const { isSimple, reason } =
                        await this.astAnalysisService.checkSuggestionSimplicity(
                            context.organizationAndTeamData,
                            context.pullRequest.number,
                            suggestion,
                        );

                    if (isSimple) return suggestion;

                    this.logDiscard(
                        suggestion.id,
                        'Complex suggestion',
                        { reason },
                        context,
                    );
                    return null;
                } catch (error) {
                    this.logDiscard(
                        suggestion.id,
                        'Error during simplicity check',
                        {
                            error,
                        },
                        context,
                    );

                    return null;
                }
            }),
        );

        const results = await Promise.allSettled(tasks);
        return results
            .filter(
                (
                    r,
                ): r is PromiseFulfilledResult<Partial<CodeSuggestion> | null> =>
                    r.status === 'fulfilled',
            )
            .map((r) => r.value)
            .filter((s): s is Partial<CodeSuggestion> => !!s);
    }

    private async prepareValidationCandidates(
        suggestions: Partial<CodeSuggestion>[],
        files: FileChange[],
        maxInputTokens?: number,
    ): Promise<ValidationCandidate[]> {
        const limit = pLimit(this.CONCURRENCY_LIMIT);
        const grouped = this.groupSuggestionsByFile(suggestions, files);
        const tasks: Promise<ValidationCandidate | null>[] = [];

        for (const [filePath, { fileData, suggestions }] of Object.entries(
            grouped,
        )) {
            if (!this.isLanguageSupported(filePath) || !fileData?.fileContent)
                continue;

            // If maxInputTokens is configured and the file content exceeds
            // the budget, skip committable suggestions for this file.
            // Committable suggestions require the full file content and
            // cannot work with chunked content.
            if (maxInputTokens && maxInputTokens > 0) {
                const fileTokens = estimateTokens(fileData.fileContent);
                const effectiveBudget = Math.floor(maxInputTokens * 0.95);
                if (fileTokens > effectiveBudget) {
                    this.logGeneral(
                        `Skipping committable suggestions for ${filePath}: file content (${fileTokens} tokens) exceeds maxInputTokens budget (${effectiveBudget} tokens)`,
                        { filePath, fileTokens, effectiveBudget },
                    );
                    continue;
                }
            }

            for (const suggestion of suggestions) {
                tasks.push(
                    limit(async () =>
                        this.applySingleEdit(
                            suggestion,
                            filePath,
                            fileData.fileContent,
                        ),
                    ),
                );
            }
        }

        const results = await Promise.allSettled(tasks);
        return results
            .filter(
                (r): r is PromiseFulfilledResult<ValidationCandidate | null> =>
                    r.status === 'fulfilled',
            )
            .map((r) => r.value)
            .filter((v): v is ValidationCandidate => !!v);
    }

    private async applySingleEdit(
        suggestion: Partial<CodeSuggestion>,
        filePath: string,
        originalCode: string,
    ): Promise<ValidationCandidate | null> {
        if (!suggestion.id || !suggestion.improvedCode || !suggestion.llmPrompt)
            return null;

        try {
            const result = await applyEdit(
                {
                    originalCode,
                    codeEdit: suggestion.improvedCode,
                    instructions: suggestion.llmPrompt,
                    filepath: filePath,
                },
                { morphApiKey: process.env.API_MORPHLLM_API_KEY },
            );

            if (!result?.mergedCode) return null;

            const formatted = this.getFormattedSuggestionFromDiff(result.udiff);
            if (!formatted) return null;

            return {
                id: suggestion.id,
                filePath,
                encodedData: Buffer.from(result.mergedCode).toString('base64'),
                diff: result.udiff,
                suggestion: formatted.code,
                newLineStart: formatted.startLine,
                newLineEnd: formatted.endLine,
            };
        } catch (error) {
            this.logError('Failed to apply single edit', error, {
                suggestionId: suggestion.id,
                filePath,
            });

            return null;
        }
    }

    private isLanguageSupported(filename: string): boolean {
        const extension = filename.slice(filename.lastIndexOf('.'));
        return Object.values(SUPPORTED_LANGUAGES).some((lang) =>
            lang.extensions.includes(extension),
        );
    }

    private groupSuggestionsByFile(
        suggestions: Partial<CodeSuggestion>[],
        files: FileChange[],
    ) {
        const filesMap = new Map(files.map((file) => [file.filename, file]));
        return suggestions.reduce<{
            [path: string]: {
                fileData: FileChange;
                suggestions: Partial<CodeSuggestion>[];
            };
        }>((acc, suggestion) => {
            const path = suggestion.relevantFile!;
            if (!acc[path]) {
                const fileData = filesMap.get(path);
                if (fileData) acc[path] = { fileData, suggestions: [] };
            }
            if (acc[path]) acc[path].suggestions.push(suggestion);
            return acc;
        }, {});
    }

    private logDiscard(
        id: string | undefined,
        reason: string,
        meta: object,
        context: CodeReviewPipelineContext,
    ) {
        this.logger.log({
            message: `Discarding suggestion: ${reason}`,
            context: this.stageName,
            metadata: {
                suggestionId: id,
                pr: context.pullRequest.number,
                ...meta,
            },
        });
    }

    private logGeneral(message: string, metadata: object) {
        this.logger.log({ message, context: this.stageName, metadata });
    }

    private logWarn(message: string, metadata: object) {
        this.logger.warn({ message, context: this.stageName, metadata });
    }

    private logError(message: string, error: any, metadata: object) {
        this.logger.error({
            message,
            context: this.stageName,
            error,
            metadata,
        });
    }
}
