import { KodyRulesSyncListener } from '@libs/kodyRules/infrastructure/adapters/listeners/kody-rules-sync.listener';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('KodyRulesSyncListener — handleIdeRulesSyncDisabled', () => {
    const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

    function buildListener() {
        const kodyRulesSyncService = {
            syncFromChangedFiles: jest.fn().mockResolvedValue(undefined),
            purgeAllIdeSyncRulesForRepository: jest.fn().mockResolvedValue(undefined),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue(null),
        };

        const listener = new KodyRulesSyncListener(
            kodyRulesSyncService as any,
            parametersService as any,
        );

        return { listener, kodyRulesSyncService };
    }

    it('purges IDE-synced rules when receiving ide-rules-sync.disabled event', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(kodyRulesSyncService.purgeAllIdeSyncRulesForRepository).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });
    });

    it('ignores the event when repositoryId is missing', async () => {
        const { listener, kodyRulesSyncService } = buildListener();

        await listener.handleIdeRulesSyncDisabled({
            organizationAndTeamData,
            repositoryId: undefined as any,
        });

        expect(kodyRulesSyncService.purgeAllIdeSyncRulesForRepository).not.toHaveBeenCalled();
    });
});
