/**
 * Tests that V3 guards on existing stages work correctly.
 * Stages should skip when codeReviewVersion === V3_AGENT,
 * and run normally otherwise.
 */
import { CodeReviewVersion } from '@/core/domain/enums/code-review.enum';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

jest.mock('exa-js', () => ({ default: jest.fn() }), { virtual: true });

// Minimal context factory
const makeContext = (
    version?: CodeReviewVersion,
    extras?: Record<string, any>,
) =>
    ({
        codeReviewConfig: version ? { codeReviewVersion: version } : undefined,
        changedFiles: [{ filename: 'src/index.ts' }],
        pullRequest: { number: 1 },
        organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        origin: 'github',
        ...extras,
    }) as any;

describe('V3 guards on existing stages', () => {
    describe('ProcessFilesReview', () => {
        it('should skip when V3_AGENT', async () => {
            // Dynamic import to avoid heavy dependency resolution at top level
            const mod =
                await import('@/code-review/pipeline/stages/process-files-review.stage');
            const stage = Object.create(mod.ProcessFilesReview.prototype);
            // Minimal mocks for the stage to not crash on guard check
            stage.logger = {
                log: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            };

            const ctx = makeContext(CodeReviewVersion.V3_AGENT);
            const result = await stage.executeStage(ctx);

            expect(result).toBe(ctx); // returned unchanged
            expect(stage.logger.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('v3-agent'),
                }),
            );
        });

        it('should NOT skip when v2', async () => {
            const mod =
                await import('@/code-review/pipeline/stages/process-files-review.stage');
            const stage = Object.create(mod.ProcessFilesReview.prototype);
            stage.logger = {
                log: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            };

            const ctx = makeContext(CodeReviewVersion.v2, {
                changedFiles: [],
            });
            // With v2 and no files, it should hit the "no files" guard, not the V3 guard
            const _result = await stage.executeStage(ctx);

            expect(stage.logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('No files'),
                }),
            );
        });
    });

    describe('GatherDocumentationContextStage', () => {
        it('should skip when V3_AGENT', async () => {
            const mod =
                await import('@/code-review/pipeline/stages/gather-documentation-context.stage');
            const stage = Object.create(
                mod.GatherDocumentationContextStage.prototype,
            );
            stage.logger = {
                log: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            };

            const ctx = makeContext(CodeReviewVersion.V3_AGENT);
            const result = await stage.executeStage(ctx);

            expect(result).toBe(ctx);
            expect(stage.logger.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('v3-agent'),
                }),
            );
        });
    });

    describe('CollectCrossFileContextStage', () => {
        it('should skip when V3_AGENT', async () => {
            const mod =
                await import('@/code-review/pipeline/stages/collect-cross-file-context.stage');
            const stage = Object.create(
                mod.CollectCrossFileContextStage.prototype,
            );
            stage.logger = {
                log: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            };

            const ctx = makeContext(CodeReviewVersion.V3_AGENT);
            const result = await stage.executeStage(ctx);

            expect(result).toBe(ctx);
            expect(stage.logger.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('v3-agent'),
                }),
            );
        });
    });

    describe('AgentReviewStage', () => {
        it('should skip when NOT V3_AGENT', async () => {
            const mod =
                await import('@/code-review/pipeline/stages/agent-review.stage');
            const stage = Object.create(mod.AgentReviewStage.prototype);
            stage.logger = {
                log: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            };

            const ctx = makeContext(CodeReviewVersion.v2);
            const result = await stage.executeStage(ctx);

            expect(result).toBe(ctx);
        });

        it('should skip when no codeReviewConfig', async () => {
            const mod =
                await import('@/code-review/pipeline/stages/agent-review.stage');
            const stage = Object.create(mod.AgentReviewStage.prototype);
            stage.logger = {
                log: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            };

            const ctx = makeContext(undefined);
            const result = await stage.executeStage(ctx);

            expect(result).toBe(ctx);
        });
    });
});
