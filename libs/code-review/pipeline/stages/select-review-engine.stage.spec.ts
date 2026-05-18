import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { FEATURE_KEYS } from '@libs/feature-gate/domain/feature-keys';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import {
    AGENT_BRANCH_STAGE_NAMES,
    EE_BRANCH_STAGE_NAMES,
} from '../strategy/engine-branches.const';
import { SelectReviewEngineStage } from './select-review-engine.stage';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const EE = [...EE_BRANCH_STAGE_NAMES].sort();
const AGENT = [...AGENT_BRANCH_STAGE_NAMES].sort();

const makeContext = (
    overrides: Partial<CodeReviewPipelineContext> = {},
): CodeReviewPipelineContext =>
    ({
        statusInfo: { status: AutomationStatus.IN_PROGRESS },
        pipelineVersion: '1.0',
        errors: [],
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
        repository: { id: 'repo-9', name: 'my-app' },
        pullRequest: { number: 1 },
        preliminaryFiles: [
            { filename: 'apps/web/src/foo.ts' },
            { filename: 'libs/core/util.ts' },
        ],
        codeReviewConfig: {
            directoryFolders: [
                { id: 'dir-web', name: 'web', path: 'apps/web' },
                { id: 'dir-core', name: 'core', path: 'libs/core' },
            ],
        },
        pipelineMetadata: {},
        ...overrides,
    }) as any;

describe('SelectReviewEngineStage', () => {
    let featureGate: { isEnabled: jest.Mock };
    let organizationService: { getReleaseTrack: jest.Mock };
    let stage: SelectReviewEngineStage;

    beforeEach(() => {
        featureGate = { isEnabled: jest.fn().mockResolvedValue(true) };
        organizationService = {
            getReleaseTrack: jest.fn().mockResolvedValue('alpha'),
        };
        stage = new SelectReviewEngineStage(
            featureGate as any,
            organizationService as any,
        );
    });

    afterEach(() => {
        delete process.env.API_AGENT_REVIEW_ENABLED;
    });

    it('is marked as silent so the UI never shows it', () => {
        expect(stage.silent).toBe(true);
    });

    describe('env override', () => {
        it('forces agent mode and bypasses flag evaluation when API_AGENT_REVIEW_ENABLED=true', async () => {
            process.env.API_AGENT_REVIEW_ENABLED = 'true';

            const result = await stage.execute(makeContext());

            expect(featureGate.isEnabled).not.toHaveBeenCalled();
            expect(result.pipelineMetadata?.useAgentEngine).toBe(true);
            expect([...(result.statusInfo.skipStages ?? [])].sort()).toEqual(
                EE,
            );
        });

        it('also recognizes API_AGENT_REVIEW_ENABLED=1', async () => {
            process.env.API_AGENT_REVIEW_ENABLED = '1';

            const result = await stage.execute(makeContext());

            expect(featureGate.isEnabled).not.toHaveBeenCalled();
            expect(result.pipelineMetadata?.useAgentEngine).toBe(true);
        });
    });

    describe('default (no touched directories)', () => {
        it('selects agent mode when there are no configured directoryFolders', async () => {
            const ctx = makeContext({
                codeReviewConfig: { directoryFolders: [] } as any,
            });

            const result = await stage.execute(ctx);

            expect(featureGate.isEnabled).not.toHaveBeenCalled();
            expect(result.pipelineMetadata?.useAgentEngine).toBe(true);
            expect([...(result.statusInfo.skipStages ?? [])].sort()).toEqual(
                EE,
            );
        });

        it('selects agent mode when no changed file falls in any configured folder', async () => {
            const ctx = makeContext({
                preliminaryFiles: [{ filename: 'docs/readme.md' }] as any,
            });

            const result = await stage.execute(ctx);

            expect(featureGate.isEnabled).not.toHaveBeenCalled();
            expect(result.pipelineMetadata?.useAgentEngine).toBe(true);
        });
    });

    describe('per-directory check (any-opt-out)', () => {
        it('evaluates the flag once per touched directory using the repositoryDirectory composite key', async () => {
            featureGate.isEnabled.mockResolvedValue(true);

            await stage.execute(makeContext());

            expect(featureGate.isEnabled).toHaveBeenCalledTimes(2);
            const keys = featureGate.isEnabled.mock.calls
                .map((c) => c[1].groups.repositoryDirectory)
                .sort();
            expect(keys).toEqual(['repo-9:dir-core', 'repo-9:dir-web']);
        });

        it('passes ONLY the repositoryDirectory group — no repository-only or directory-only groups', async () => {
            featureGate.isEnabled.mockResolvedValue(true);

            await stage.execute(makeContext());

            for (const [, ctx] of featureGate.isEnabled.mock.calls) {
                expect(Object.keys(ctx.groups)).toEqual([
                    'repositoryDirectory',
                ]);
            }
        });

        it('selects agent mode and does NOT probe when the context has no repositoryId', async () => {
            const ctx = makeContext({
                repository: { name: 'orphan' } as any,
            });

            const result = await stage.execute(ctx);

            expect(featureGate.isEnabled).not.toHaveBeenCalled();
            expect(result.pipelineMetadata?.useAgentEngine).toBe(true);
        });

        it('selects agent mode when every touched directory is enabled', async () => {
            featureGate.isEnabled.mockResolvedValue(true);

            const result = await stage.execute(makeContext());

            expect(result.pipelineMetadata?.useAgentEngine).toBe(true);
            expect([...(result.statusInfo.skipStages ?? [])].sort()).toEqual(
                EE,
            );
        });

        it('drops to EE mode when ANY touched directory denies', async () => {
            featureGate.isEnabled
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false);

            const result = await stage.execute(makeContext());

            expect(result.pipelineMetadata?.useAgentEngine).toBe(false);
            expect([...(result.statusInfo.skipStages ?? [])].sort()).toEqual(
                AGENT,
            );
        });

        it('short-circuits the loop on the first denial', async () => {
            featureGate.isEnabled.mockResolvedValueOnce(false);

            await stage.execute(makeContext());

            expect(featureGate.isEnabled).toHaveBeenCalledTimes(1);
        });

        it('treats a directory probe failure as not-opted-out (continues the loop instead of forcing EE)', async () => {
            featureGate.isEnabled
                .mockRejectedValueOnce(new Error('PostHog 5xx'))
                .mockResolvedValueOnce(true);

            const result = await stage.execute(makeContext());

            expect(featureGate.isEnabled).toHaveBeenCalledTimes(2);
            expect(result.pipelineMetadata?.useAgentEngine).toBe(true);
        });

        it('still drops to EE when a later directory denies after an earlier probe failed', async () => {
            featureGate.isEnabled
                .mockRejectedValueOnce(new Error('PostHog 5xx'))
                .mockResolvedValueOnce(false);

            const result = await stage.execute(makeContext());

            expect(result.pipelineMetadata?.useAgentEngine).toBe(false);
        });

        it('falls back to teamId as identifier when organizationId is missing and skips getReleaseTrack', async () => {
            featureGate.isEnabled.mockResolvedValue(true);
            const ctx = makeContext({
                organizationAndTeamData: { teamId: 'team-1' } as any,
            });

            await stage.execute(ctx);

            expect(organizationService.getReleaseTrack).not.toHaveBeenCalled();
            expect(featureGate.isEnabled).toHaveBeenCalledWith(
                FEATURE_KEYS.agentReview,
                expect.objectContaining({ identifier: 'team-1' }),
            );
        });
    });
});
