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
 * Guards the team-authored error message (issue #1452): on a failed review the
 * stage resolves `pullRequestMessagesConfig.errorReviewMessage.content` and
 * forwards the trimmed template to commentManager.updateOverallComment as the
 * trailing `reviewErrorCustomMessage` arg — whenever it has content AND the
 * review actually failed. The template IS the message (the comment manager then
 * expands @errorReason); the presence of content is the switch, and empty/unset
 * content falls back to Kody's default error comment.
 */
describe('UpdateCommentsAndGenerateSummaryStage - custom error message', () => {
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
            {} as any,
        );
        return { stage, commentManagerService };
    };

    // No startReviewMessage/endReviewMessage → the `!endReviewMessage` branch
    // that calls updateOverallComment (the default summary path used on
    // failure). errorReviewMessage carries the team guidance.
    const failedContext = (
        errorReviewMessage: Record<string, unknown> | undefined,
    ) =>
        ({
            lastExecution: undefined,
            errors: [{ severity: 'critical' }],
            lastReviewError: { friendlyMessage: 'no BYOK provider configured' },
            codeReviewConfig: { languageResultPrompt: 'en-US' },
            repository: { id: 'r' },
            pullRequest: { number: 7 },
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            platformType: undefined,
            initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
            changedFiles: [],
            dryRun: { enabled: false },
            lineComments: [],
            pullRequestMessagesConfig: errorReviewMessage
                ? { errorReviewMessage }
                : {},
        }) as any;

    const lastArg = (mockFn: jest.Mock) => {
        const call = mockFn.mock.calls[0];
        return call[call.length - 1];
    };

    it('forwards the trimmed custom note on a failed review', async () => {
        const { stage, commentManagerService } = makeStage();

        await (stage as any).executeStage(
            failedContext({
                status: PullRequestMessageStatus.ACTIVE,
                content: '  Reach out to @platform-support  ',
            }),
        );

        expect(commentManagerService.updateOverallComment).toHaveBeenCalledTimes(
            1,
        );
        // Trimmed note forwarded as the trailing reviewErrorCustomMessage string
        // (the comment manager appends it below the default comment).
        expect(lastArg(commentManagerService.updateOverallComment)).toBe(
            'Reach out to @platform-support',
        );
    });

    it('forwards content regardless of status (content is the switch)', async () => {
        const { stage, commentManagerService } = makeStage();

        // Status is vestigial for the error message — a non-empty content still
        // forwards even when a hand-written config leaves status OFF.
        await (stage as any).executeStage(
            failedContext({
                status: PullRequestMessageStatus.OFF,
                content: 'Reach out to @platform-support',
            }),
        );

        expect(lastArg(commentManagerService.updateOverallComment)).toBe(
            'Reach out to @platform-support',
        );
    });

    it('does not forward an empty message', async () => {
        const { stage, commentManagerService } = makeStage();

        await (stage as any).executeStage(
            failedContext({
                status: PullRequestMessageStatus.ACTIVE,
                content: '   ',
            }),
        );

        expect(
            lastArg(commentManagerService.updateOverallComment),
        ).toBeUndefined();
    });

    it('does not forward the message when the review did not fail', async () => {
        const { stage, commentManagerService } = makeStage();

        const context = failedContext({
            status: PullRequestMessageStatus.ACTIVE,
            content: 'Reach out to @platform-support',
        });
        context.errors = []; // no critical error → reviewFailed is false

        await (stage as any).executeStage(context);

        expect(
            lastArg(commentManagerService.updateOverallComment),
        ).toBeUndefined();
    });
});
