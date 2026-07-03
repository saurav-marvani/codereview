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
