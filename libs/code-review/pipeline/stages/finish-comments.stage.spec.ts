import { produce } from 'immer';
import { UpdateCommentsAndGenerateSummaryStage } from './finish-comments.stage';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';

/**
 * Guards the stage→commentManager seam that feeds the @agentPrompt
 * block: executeStage must forward `context.lineComments` as the (positional,
 * optional) lineComments argument to processEndReviewMessageTemplate. Reordering
 * or dropping that trailing arg wouldn't trip a typecheck — the class of silent
 * break that only an end-to-end assertion catches.
 */
describe('UpdateCommentsAndGenerateSummaryStage - lineComments forwarding', () => {
    const makeStage = () => {
        const commentManagerService = {
            processEndReviewMessageTemplate: jest
                .fn()
                .mockResolvedValue('rendered body'),
            updateOverallComment: jest.fn().mockResolvedValue(undefined),
            createComment: jest.fn().mockResolvedValue(undefined),
        } as any;
        const stage = new UpdateCommentsAndGenerateSummaryStage(
            commentManagerService,
            {} as any, // pullRequestManagerService — unused when summary is off
        );
        return { stage, commentManagerService };
    };

    const lineComments = [
        {
            comment: {
                path: 'src/x.ts',
                line: 4,
                body: {},
                suggestion: { llmPrompt: 'Fix it', improvedCode: '' },
            },
            deliveryStatus: 'sent',
        },
    ];

    const baseContext = (over: Record<string, unknown> = {}) =>
        ({
            lastExecution: undefined,
            errors: [],
            // No summary config → shouldGenerateOrUpdateSummary is false, so the
            // heavy generateSummaryPR branch is skipped entirely.
            codeReviewConfig: { languageResultPrompt: 'en-US' },
            repository: { id: 'r' },
            pullRequest: { number: 7 },
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            platformType: undefined,
            initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
            changedFiles: [],
            dryRun: { enabled: false },
            lineComments,
            // Both messages ACTIVE → the branch that calls
            // processEndReviewMessageTemplate.
            pullRequestMessagesConfig: {
                startReviewMessage: {
                    status: PullRequestMessageStatus.ACTIVE,
                    content: 'Review started',
                },
                endReviewMessage: {
                    status: PullRequestMessageStatus.ACTIVE,
                    content: 'Done!\n\n@agentPrompt',
                },
            },
            ...over,
        }) as any;

    it('forwards context.lineComments as the trailing arg to processEndReviewMessageTemplate', async () => {
        const { stage, commentManagerService } = makeStage();
        const context = baseContext();

        await (stage as any).executeStage(context);

        expect(
            commentManagerService.processEndReviewMessageTemplate,
        ).toHaveBeenCalledTimes(1);
        expect(
            commentManagerService.processEndReviewMessageTemplate,
        ).toHaveBeenCalledWith(
            'Done!\n\n@agentPrompt',
            context.changedFiles,
            context.organizationAndTeamData,
            7,
            context.codeReviewConfig,
            'en-US',
            undefined,
            lineComments,
        );
    });
});

/**
 * Guards the frozen-context error-recording path (issue #1452 matrix-gaps
 * item 3, same family as create-file-comments #c886e369a / agent-review
 * #1522). By the time this stage runs, an earlier stage has passed the
 * pipeline context through Immer's produce(), so `context` is DEEP-FROZEN
 * (auto-freeze). When PR-summary generation fails, the catch block used to
 * record the error via `context.errors = []` / `context.errors.push(...)` —
 * a direct mutation of the frozen context that throws "Cannot add property,
 * object is not extensible" and, INSIDE the catch, replaced the real summary
 * failure with a confusing frozen-mutation error and aborted the stage. The
 * fix records the error through updateContext(); this test freezes the
 * context exactly like production and asserts the error is recorded without
 * throwing.
 */
describe('UpdateCommentsAndGenerateSummaryStage - frozen-context error recording (regression)', () => {
    const makeStage = () => {
        const commentManagerService = {
            // Summary generation blows up → the catch that records the error.
            generateSummaryPR: jest
                .fn()
                .mockRejectedValue(new Error('summary boom')),
            updateSummarizationInPR: jest.fn().mockResolvedValue(undefined),
            // Reached after the summary catch (no endReviewMessage config).
            updateOverallComment: jest.fn().mockResolvedValue(undefined),
            createComment: jest.fn().mockResolvedValue(undefined),
            processEndReviewMessageTemplate: jest
                .fn()
                .mockResolvedValue('rendered body'),
        } as any;
        const stage = new UpdateCommentsAndGenerateSummaryStage(
            commentManagerService,
            {} as any,
        );
        return { stage, commentManagerService };
    };

    const summaryFailContext = () =>
        ({
            lastExecution: undefined, // isCommitRun=false
            // generatePRSummary=true → shouldGenerateOrUpdateSummary=true,
            // entering the try/catch whose failure path records the error.
            codeReviewConfig: {
                languageResultPrompt: 'en-US',
                summary: { generatePRSummary: true },
            },
            repository: { id: 'r' },
            pullRequest: { number: 7 },
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            platformType: undefined,
            initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
            changedFiles: [],
            dryRun: { enabled: false },
            lineComments: [],
            // A frozen, already-initialized errors array — the realistic
            // shape. The old code's `context.errors.push(...)` throws on it.
            errors: [],
        }) as any;

    it('records the summary failure without throwing when the context is Immer-frozen', async () => {
        const { stage } = makeStage();
        // produce(x, () => {}) deep-freezes exactly like the real pipeline.
        const frozenCtx = produce(summaryFailContext(), () => {});

        // The whole point: the OLD implementation threw here
        // ("Cannot add property N, object is not extensible") because the
        // catch mutated the frozen context/array in place.
        const result = await (stage as any).executeStage(frozenCtx);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].metadata.reason).toBe(
            'summary_generation_failed',
        );
    });

    it('appends to a frozen non-empty errors array without dropping the prior error', async () => {
        const { stage } = makeStage();
        const priorError = {
            stage: 'earlier-stage',
            error: new Error('earlier'),
            metadata: { reason: 'earlier_failure' },
        };
        const frozenCtx = produce(
            { ...summaryFailContext(), errors: [priorError] } as any,
            () => {},
        );

        const result = await (stage as any).executeStage(frozenCtx);

        // Both the pre-existing error and the newly-recorded summary error
        // survive — the updateContext path must not clobber the array.
        expect(result.errors).toHaveLength(2);
        expect(result.errors[0].metadata.reason).toBe('earlier_failure');
        expect(result.errors[1].metadata.reason).toBe(
            'summary_generation_failed',
        );
    });
});
