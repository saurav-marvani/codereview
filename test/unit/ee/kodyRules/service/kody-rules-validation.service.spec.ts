import { KodyRulesValidationService } from '@libs/ee/kodyRules/service/kody-rules-validation.service';
import {
    IKodyRule,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

const shouldLimitResourcesMock = jest.fn();

jest.mock('@libs/ee/configs/environment', () => ({
    environment: {
        API_CLOUD_MODE: true,
    },
}));

const createRule = (
    overrides: Partial<IKodyRule> = {},
): Partial<IKodyRule> => ({
    uuid: overrides.uuid || Math.random().toString(36).slice(2),
    title: overrides.title || 'Title',
    rule: overrides.rule || 'Rule',
    type: overrides.type || KodyRulesType.STANDARD,
    status: overrides.status || KodyRulesStatus.ACTIVE,
    repositoryId: overrides.repositoryId || 'repo-1',
    directoryId: overrides.directoryId,
    path: overrides.path,
    inheritance: overrides.inheritance || {
        inheritable: true,
        include: [],
        exclude: [],
    },
    createdAt: overrides.createdAt || new Date('2026-01-01T00:00:00.000Z'),
});

describe('KodyRulesValidationService', () => {
    let service: KodyRulesValidationService;

    beforeEach(() => {
        shouldLimitResourcesMock.mockReset();
        service = new KodyRulesValidationService({
            shouldLimitResources: shouldLimitResourcesMock,
        } as any);
    });

    describe('validateRulesLimit', () => {
        it('returns true when resource limits are not enforced', async () => {
            shouldLimitResourcesMock.mockResolvedValue(false);

            const result = await service.validateRulesLimit(
                { organizationId: 'org-1' } as any,
                999,
            );

            expect(result).toBe(true);
        });

        it('returns false when enforced limit is exceeded', async () => {
            shouldLimitResourcesMock.mockResolvedValue(true);

            const result = await service.validateRulesLimit(
                { organizationId: 'org-1' } as any,
                11,
            );

            expect(result).toBe(false);
        });
    });

    describe('filterKodyRules', () => {
        it('returns standard and memory rules separated in createdAt order', () => {
            const rules = [
                createRule({
                    uuid: 'global-standard',
                    repositoryId: 'global',
                    type: KodyRulesType.STANDARD,
                    rule: 'global standard rule',
                    createdAt: new Date('2026-01-03T00:00:00.000Z'),
                }),
                createRule({
                    uuid: 'repo-memory',
                    repositoryId: 'repo-1',
                    type: KodyRulesType.MEMORY,
                    rule: 'repo memory rule',
                    createdAt: new Date('2026-01-02T00:00:00.000Z'),
                }),
                createRule({
                    uuid: 'repo-standard',
                    repositoryId: 'repo-1',
                    type: KodyRulesType.STANDARD,
                    rule: 'repo standard rule',
                    createdAt: new Date('2026-01-01T00:00:00.000Z'),
                }),
                createRule({
                    uuid: 'inactive',
                    status: KodyRulesStatus.PENDING,
                }),
            ];

            const result = service.filterKodyRules(rules, 'repo-1');

            expect(result.standardRules.map((rule) => rule.uuid)).toEqual([
                'repo-standard',
                'global-standard',
            ]);
            expect(result.memoryRules.map((rule) => rule.uuid)).toEqual([
                'repo-memory',
            ]);
        });

        it('removes duplicates by rule text', () => {
            const rules = [
                createRule({
                    uuid: 'first',
                    rule: 'duplicated',
                    repositoryId: 'repo-1',
                }),
                createRule({
                    uuid: 'second',
                    rule: 'duplicated',
                    repositoryId: 'global',
                }),
            ];

            const result = service.filterKodyRules(rules, 'repo-1');

            expect(result.standardRules).toHaveLength(1);
            expect(result.standardRules[0].uuid).toBe('first');
        });
    });

    describe('Inheritance behavior — proving the "INHERITED: DIRECTORY" leak', () => {
        // Reproduces the exact shape the client reported for b207a89c
        // (Logging Best Practices): rule attached to directoryId
        // cf5284b4-... with the default inheritance shape.
        const b207a89c = (): Partial<IKodyRule> =>
            createRule({
                uuid: 'b207a89c-924b-4a0a-8070-2e860293b537',
                title: 'Logging Best Practices',
                repositoryId: '769144833',
                directoryId: 'cf5284b4-2510-464a-9eca-98efbf121d04',
                path: '**/*',
                inheritance: {
                    inheritable: true,
                    include: [], // <-- the client's default shape
                    exclude: [],
                },
            });

        it('passes the inheritance check when viewing from OWN directory (cf5284b4)', () => {
            const result = service.getKodyRulesForFile(
                'qantilever/src/foo.kt',
                [b207a89c()],
                {
                    repositoryId: '769144833',
                    directoryId: 'cf5284b4-2510-464a-9eca-98efbf121d04',
                },
            );
            expect(result.map((r) => r.uuid)).toContain(
                'b207a89c-924b-4a0a-8070-2e860293b537',
            );
        });

        it('PROVES THE LEAK: same rule also passes when viewing from a DIFFERENT directory (314f34ff)', () => {
            // This is the exact "INHERITED: DIRECTORY" behavior the client
            // complained about — rule from cf5284b4 leaks into 314f34ff
            // context because inheritance.include is empty which reads as
            // "inherit everywhere" (NOT "inherit nowhere").
            const result = service.getKodyRulesForFile(
                'applications/backoffice-bff/src/foo.java',
                [b207a89c()],
                {
                    repositoryId: '769144833',
                    directoryId: '314f34ff-2d1e-47e0-8765-2bb3f1a8564d',
                },
            );
            expect(result.map((r) => r.uuid)).toContain(
                'b207a89c-924b-4a0a-8070-2e860293b537',
            );
        });

        it('STOPS the leak when include is set to ONLY the own directoryId', () => {
            // If we had defaulted `include: [directoryId]` instead of
            // `include: []`, the rule would stay pinned to its own
            // directory. This is the design change we would need to make.
            const pinned: Partial<IKodyRule> = {
                ...b207a89c(),
                inheritance: {
                    inheritable: true,
                    include: ['cf5284b4-2510-464a-9eca-98efbf121d04'],
                    exclude: [],
                },
            };

            const resultInOwnDir = service.getKodyRulesForFile(
                'qantilever/src/foo.kt',
                [pinned],
                {
                    repositoryId: '769144833',
                    directoryId: 'cf5284b4-2510-464a-9eca-98efbf121d04',
                },
            );
            const resultInOtherDir = service.getKodyRulesForFile(
                'applications/backoffice-bff/src/foo.java',
                [pinned],
                {
                    repositoryId: '769144833',
                    directoryId: '314f34ff-2d1e-47e0-8765-2bb3f1a8564d',
                },
            );

            expect(resultInOwnDir).toHaveLength(1);
            expect(resultInOtherDir).toHaveLength(0);
        });
    });

    describe('Bug 1 regression — rule from .cursorrules in subdirectory does not leak to unrelated paths', () => {
        // Reproduces quintoandar PR #24870 (backend-services repo 769144833):
        // rule 32dfa554-6238-4b19-84f8-17330f6abe94 was imported from
        // applications/backoffice-bff/.cursorrules and incorrectly applied to
        // applications/sales-flow/api/src/main/java/.../TaskRepository.java.

        const javaSpringArchRule = (pathValue: string): Partial<IKodyRule> =>
            createRule({
                uuid: '32dfa554-6238-4b19-84f8-17330f6abe94',
                title: 'Java/Spring Architectural, Naming, and Dependency Conventions',
                rule: 'Enforce hexagonal architecture conventions from .cursorrules',
                repositoryId: '769144833',
                path: pathValue,
                // sourcePath tracks where the rule came from; today it is informational-only
                // see libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service.ts
                // where sourcePath is set on the DTO but never consulted in matching.
            });

        const salesFlowFile =
            'applications/sales-flow/api/src/main/java/br/com/quintoandar/salesflow/api/task/facade/TaskFacade.java';
        const backofficeBffFile =
            'applications/backoffice-bff/src/main/java/com/example/service/UserServiceImpl.java';

        it('DEMONSTRATES THE BUG: rule with raw "**/*" path still matches files outside the source subdirectory', () => {
            // Pre-fix shape — the path the sync used to persist: unscoped "**/*".
            // Asserting the current (buggy) behavior so if we ever re-introduce it the test catches it.
            const rules = [javaSpringArchRule('**/*')];

            const result = service.getKodyRulesForFile(salesFlowFile, rules, {
                repositoryId: '769144833',
            });

            expect(result.map((r) => r.uuid)).toContain(
                '32dfa554-6238-4b19-84f8-17330f6abe94',
            );
        });

        it('PROVES THE FIX: rule scoped to the source subdirectory does NOT match sales-flow files', () => {
            // Post-fix shape — scopePathToSourceDirectory in kodyRulesSync.service.ts
            // now persists "applications/backoffice-bff/**/*" for a .cursorrules that lives there.
            const rules = [
                javaSpringArchRule('applications/backoffice-bff/**/*'),
            ];

            const result = service.getKodyRulesForFile(salesFlowFile, rules, {
                repositoryId: '769144833',
            });

            expect(result.map((r) => r.uuid)).not.toContain(
                '32dfa554-6238-4b19-84f8-17330f6abe94',
            );
        });

        it('PROVES THE FIX: scoped rule still matches files inside its own subdirectory', () => {
            const rules = [
                javaSpringArchRule('applications/backoffice-bff/**/*'),
            ];

            const result = service.getKodyRulesForFile(backofficeBffFile, rules, {
                repositoryId: '769144833',
            });

            expect(result.map((r) => r.uuid)).toContain(
                '32dfa554-6238-4b19-84f8-17330f6abe94',
            );
        });
    });

    describe('getMemoryRulesForContext', () => {
        it('returns only active memory rules matching repository and path context', () => {
            const rules = [
                createRule({
                    uuid: 'global-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'global',
                    path: 'src/**',
                }),
                createRule({
                    uuid: 'repo-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'repo-1',
                    path: 'src/components/**',
                }),
                createRule({
                    uuid: 'repo-standard',
                    type: KodyRulesType.STANDARD,
                    repositoryId: 'repo-1',
                }),
                createRule({
                    uuid: 'inactive-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'repo-1',
                    status: KodyRulesStatus.PENDING,
                }),
            ];

            const result = service.getMemoryRulesForContext(
                'src/components',
                rules,
                {
                    repositoryId: 'repo-1',
                },
            );

            expect(result.map((rule) => rule.uuid)).toEqual([
                'global-memory',
                'repo-memory',
            ]);
        });

        it('ignores directory filter when repository is not provided', () => {
            const rules = [
                createRule({
                    uuid: 'dir-1-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'repo-1',
                    directoryId: 'dir-1',
                }),
                createRule({
                    uuid: 'dir-2-memory',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'repo-1',
                    directoryId: 'dir-2',
                }),
            ];

            const result = service.getMemoryRulesForContext(null, rules, {
                directoryId: 'dir-1',
            });

            expect(result.map((rule) => rule.uuid)).toEqual([
                'dir-1-memory',
                'dir-2-memory',
            ]);
        });

        it('respects inheritance include and exclude in repository context', () => {
            const rules = [
                createRule({
                    uuid: 'excluded',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'global',
                    inheritance: {
                        inheritable: true,
                        include: [],
                        exclude: ['repo-1'],
                    },
                }),
                createRule({
                    uuid: 'included',
                    type: KodyRulesType.MEMORY,
                    repositoryId: 'global',
                    inheritance: {
                        inheritable: true,
                        include: ['repo-1'],
                        exclude: [],
                    },
                }),
            ];

            const result = service.getMemoryRulesForContext(null, rules, {
                repositoryId: 'repo-1',
            });

            expect(result.map((rule) => rule.uuid)).toEqual(['included']);
        });
    });
});
