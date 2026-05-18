import { PullRequestsService } from './pullRequests.service';

/**
 * Regression tests for issue #1107 — `aggregateAndSaveDataStructure`
 * timing out on PRs with thousands of changed files.
 *
 * The pre-fix code (see git history for `handleExistingPullRequest`)
 * looped serially over `changedFiles`, calling
 * `findFileWithSuggestions` + `updateFile` + N × `addSuggestionToFile`
 * per file. A PR with a few thousand files produced tens of thousands
 * of `findOneAndUpdate`s, every one of them rewriting a Mongo document
 * already approaching the 16MB cap. Every webhook timed out at 180s,
 * and the next event repeated the same wasted work.
 *
 * The fix has two parts:
 *  - A "gate" in `aggregateAndSaveDataStructure` that skips PRs above
 *    `MAX_FILES_PER_SAVE` so a runaway PR cannot wedge the worker.
 *  - A rewrite of `handleExistingPullRequest` to build one in-memory
 *    op list and dispatch a single chunked `bulkWrite` through
 *    `bulkApplyFileChanges`, then recompute totals from a server-side
 *    aggregation rather than re-reading the doc.
 *
 * These tests are designed to fail loudly if either half regresses.
 */
describe('PullRequestsService — #1107 bulk file changes', () => {
    let service: PullRequestsService;
    let pullRequestsRepository: {
        findByNumberAndRepositoryName: jest.Mock;
        findByNumberAndRepositoryId: jest.Mock;
        findFileWithSuggestions: jest.Mock;
        addFileToPullRequest: jest.Mock;
        addSuggestionToFile: jest.Mock;
        updateFile: jest.Mock;
        bulkApplyFileChanges: jest.Mock;
        computeFileTotals: jest.Mock;
        newSubDocumentId: jest.Mock;
        update: jest.Mock;
    };

    const stubRepository = {
        id: 'repo-uuid-stable',
        name: 'kodus-app',
    };
    const stubOrg = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };
    const stubPR = {
        number: 42,
        user: undefined,
        reviewers: undefined,
        assignees: undefined,
    };

    let idCounter = 0;
    const nextId = () => `oid-${++idCounter}`;

    function makeExistingFile(path: string, overrides: Partial<any> = {}) {
        return {
            id: nextId(),
            path,
            filename: path.split('/').pop() ?? path,
            sha: 'sha-prev',
            previousName: '',
            status: 'modified',
            createdAt: new Date('2026-05-01').toISOString(),
            updatedAt: new Date('2026-05-01').toISOString(),
            suggestions: [],
            added: 1,
            deleted: 1,
            changes: 2,
            ...overrides,
        };
    }

    function makeChangedFile(filename: string, overrides: Partial<any> = {}) {
        return {
            filename,
            sha: 'sha-new',
            status: 'modified',
            additions: 10,
            deletions: 4,
            changes: 14,
            patch: '@@ ... synthetic ...',
            ...overrides,
        };
    }

    beforeEach(() => {
        idCounter = 0;
        pullRequestsRepository = {
            findByNumberAndRepositoryName: jest.fn(),
            findByNumberAndRepositoryId: jest.fn(),
            findFileWithSuggestions: jest.fn(),
            addFileToPullRequest: jest.fn(),
            addSuggestionToFile: jest.fn(),
            updateFile: jest.fn(),
            bulkApplyFileChanges: jest.fn().mockResolvedValue({
                attempted: 0,
                modified: 0,
                errors: [],
            }),
            computeFileTotals: jest.fn().mockResolvedValue({
                totalAdded: 0,
                totalDeleted: 0,
                totalChanges: 0,
            }),
            newSubDocumentId: jest.fn(() => nextId()),
            update: jest.fn(async (entity: any, patch: any) => ({
                ...entity,
                ...patch,
            })),
        };

        service = new PullRequestsService(
            pullRequestsRepository as any,
            {} as any,
        );

        // Silence the logger so test output stays clean.
        (service as any).logger = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        };
    });

    function callHandleExisting(args: {
        existingPR: any;
        changedFiles: any[];
        prioritized?: any[];
        unused?: any[];
    }): Promise<any> {
        return (service as any).handleExistingPullRequest(
            args.existingPR,
            { ...stubPR },
            stubRepository,
            args.changedFiles,
            args.prioritized ?? [],
            args.unused ?? [],
            stubOrg,
        );
    }

    // ─────────────────────────────────────────────────────────
    // A) Gate behavior (aggregateAndSaveDataStructure entry point)
    // ─────────────────────────────────────────────────────────

    describe('gate — MAX_FILES_PER_SAVE', () => {
        it('returns null and never touches the repository when changedFiles exceeds the threshold', async () => {
            // We patch the inner method so the gate's decision is what
            // determines whether anything is called. If the gate
            // regressed, `aggregateAndSaveInternal` would fire.
            const internalSpy = jest
                .spyOn(service as any, 'aggregateAndSaveInternal')
                .mockResolvedValue({ ok: true });

            const oversized = Array.from({ length: 5001 }, (_, i) =>
                makeChangedFile(`src/big-${i}.ts`),
            );

            const result = await service.aggregateAndSaveDataStructure(
                stubPR as any,
                stubRepository as any,
                oversized,
                [],
                [],
                'github' as any,
                stubOrg as any,
                [],
            );

            expect(result).toBeNull();
            expect(internalSpy).not.toHaveBeenCalled();
            expect(
                pullRequestsRepository.bulkApplyFileChanges,
            ).not.toHaveBeenCalled();
        });

        it('lets PRs at or below the threshold through', async () => {
            const internalSpy = jest
                .spyOn(service as any, 'aggregateAndSaveInternal')
                .mockResolvedValue({ ok: true });

            const okSized = Array.from({ length: 5000 }, (_, i) =>
                makeChangedFile(`src/ok-${i}.ts`),
            );

            await service.aggregateAndSaveDataStructure(
                stubPR as any,
                stubRepository as any,
                okSized,
                [],
                [],
                'github' as any,
                stubOrg as any,
                [],
            );

            expect(internalSpy).toHaveBeenCalledTimes(1);
        });
    });

    // ─────────────────────────────────────────────────────────
    // B) handleExistingPullRequest — bulkWrite path
    // ─────────────────────────────────────────────────────────

    describe('handleExistingPullRequest — small PR (mixed update + add)', () => {
        it('emits one updateFile op per existing file and one addFile op per new file, plus addSuggestions where suggestions exist', async () => {
            const existingFiles = [
                makeExistingFile('src/keep-a.ts'),
                makeExistingFile('src/keep-b.ts'),
            ];
            const existingPR = {
                uuid: 'pr-uuid-1',
                files: existingFiles,
            };

            const changedFiles = [
                makeChangedFile('src/keep-a.ts'), // update
                makeChangedFile('src/keep-b.ts'), // update + suggestion
                makeChangedFile('src/new-c.ts'), // add
                makeChangedFile('src/new-d.ts'), // add + suggestion
            ];

            const prioritized = [
                {
                    id: 'sug-1',
                    relevantFile: 'src/keep-b.ts',
                    suggestionContent: 'fix',
                },
                {
                    id: 'sug-2',
                    relevantFile: 'src/new-d.ts',
                    suggestionContent: 'fix',
                },
            ];

            await callHandleExisting({
                existingPR,
                changedFiles,
                prioritized,
            });

            expect(
                pullRequestsRepository.bulkApplyFileChanges,
            ).toHaveBeenCalledTimes(1);
            const [prUuidArg, orgIdArg, opsArg] =
                pullRequestsRepository.bulkApplyFileChanges.mock.calls[0];

            expect(prUuidArg).toBe('pr-uuid-1');
            expect(orgIdArg).toBe('org-1');

            const kinds = opsArg.map((op: any) => op.kind);
            // 2 updateFile + 1 addSuggestions (for keep-b) + 2 addFile
            // (for new-c, new-d) + 1 addSuggestions inlined into the
            // new-d's `addFile` (suggestions array is part of the file
            // doc when it's brand new — no separate op needed).
            expect(kinds.filter((k: string) => k === 'updateFile')).toHaveLength(2);
            expect(kinds.filter((k: string) => k === 'addFile')).toHaveLength(2);
            expect(
                kinds.filter((k: string) => k === 'addSuggestions'),
            ).toHaveLength(1);

            // The addSuggestions op must target the existing file's id,
            // not the filename, so the positional $ operator can match.
            const addSugOp = opsArg.find(
                (op: any) => op.kind === 'addSuggestions',
            );
            expect(addSugOp.fileId).toBe(existingFiles[1].id);

            // The new-d addFile must carry the suggestion inline.
            const newDOp = opsArg.find(
                (op: any) => op.kind === 'addFile' && op.file.path === 'src/new-d.ts',
            );
            expect(newDOp.file.suggestions).toHaveLength(1);
        });

        it('writes totals from server-side aggregation, not from in-memory projection', async () => {
            // Deliberately have the aggregation return *different*
            // numbers than what the projection would have produced.
            // If the service ever switches back to trusting the local
            // map, this test will catch it because the persisted
            // totals will not match the aggregation's output.
            pullRequestsRepository.computeFileTotals.mockResolvedValue({
                totalAdded: 999,
                totalDeleted: 111,
                totalChanges: 1110,
            });

            const existingPR = {
                uuid: 'pr-uuid-2',
                files: [makeExistingFile('src/a.ts')],
            };

            await callHandleExisting({
                existingPR,
                changedFiles: [makeChangedFile('src/a.ts')],
            });

            expect(pullRequestsRepository.computeFileTotals).toHaveBeenCalledWith(
                'pr-uuid-2',
                'org-1',
            );
            const [, patch] = pullRequestsRepository.update.mock.calls[0];
            expect(patch.totalAdded).toBe(999);
            expect(patch.totalDeleted).toBe(111);
            expect(patch.totalChanges).toBe(1110);
        });

        it('does not call any of the N+1 helpers — they are the regression surface', async () => {
            const existingPR = {
                uuid: 'pr-uuid-3',
                files: [makeExistingFile('src/a.ts')],
            };

            await callHandleExisting({
                existingPR,
                changedFiles: [
                    makeChangedFile('src/a.ts'),
                    makeChangedFile('src/b.ts'),
                ],
            });

            expect(
                pullRequestsRepository.findFileWithSuggestions,
            ).not.toHaveBeenCalled();
            expect(
                pullRequestsRepository.addFileToPullRequest,
            ).not.toHaveBeenCalled();
            expect(
                pullRequestsRepository.addSuggestionToFile,
            ).not.toHaveBeenCalled();
            expect(
                pullRequestsRepository.updateFile,
            ).not.toHaveBeenCalled();
            // The single final totals update is the only `update`
            // expected in the entire flow.
            expect(pullRequestsRepository.update).toHaveBeenCalledTimes(1);
        });
    });

    describe('handleExistingPullRequest — medium PR (500 files)', () => {
        it('builds proportional ops and a single bulkApplyFileChanges call', async () => {
            const existingFiles = Array.from({ length: 100 }, (_, i) =>
                makeExistingFile(`src/old-${i}.ts`),
            );
            const existingPR = {
                uuid: 'pr-uuid-medium',
                files: existingFiles,
            };

            const changedFiles = [
                ...existingFiles.map((f) => makeChangedFile(f.path)),
                ...Array.from({ length: 400 }, (_, i) =>
                    makeChangedFile(`src/new-${i}.ts`),
                ),
            ];

            await callHandleExisting({ existingPR, changedFiles });

            expect(
                pullRequestsRepository.bulkApplyFileChanges,
            ).toHaveBeenCalledTimes(1);
            const ops =
                pullRequestsRepository.bulkApplyFileChanges.mock.calls[0][2];

            expect(
                ops.filter((op: any) => op.kind === 'updateFile').length,
            ).toBe(100);
            expect(
                ops.filter((op: any) => op.kind === 'addFile').length,
            ).toBe(400);
        });
    });

    // ─────────────────────────────────────────────────────────
    // C) Defensive behavior
    // ─────────────────────────────────────────────────────────

    describe('defensive guards', () => {
        it('returns null and skips bulkWrite when organizationId is missing on both organizationAndTeamData and existingPR', async () => {
            // Multi-tenant isolation: without an org context we can't
            // safely scope the bulkWrite filters, so refuse the call
            // rather than risk targeting another tenant's doc.
            await (service as any).handleExistingPullRequest(
                { uuid: 'pr-uuid-no-org', files: [] },
                { number: 1 },
                stubRepository,
                [makeChangedFile('src/a.ts')],
                [],
                [],
                {} as any, // no organizationId
            );

            expect(
                pullRequestsRepository.bulkApplyFileChanges,
            ).not.toHaveBeenCalled();
            expect(
                pullRequestsRepository.computeFileTotals,
            ).not.toHaveBeenCalled();
        });

        it('falls back to existingPR.organizationId when organizationAndTeamData is missing it', async () => {
            // Hardening: the entity always carries organizationId
            // (required: true on schema). Use it as the source of
            // truth if the caller forgot to thread the value through.
            const existingPR = {
                uuid: 'pr-uuid-fallback',
                organizationId: 'org-from-entity',
                files: [],
            };

            await (service as any).handleExistingPullRequest(
                existingPR,
                { number: 1 },
                stubRepository,
                [makeChangedFile('src/a.ts')],
                [],
                [],
                {} as any, // org missing on the context
            );

            expect(
                pullRequestsRepository.bulkApplyFileChanges,
            ).toHaveBeenCalledTimes(1);
            const [, orgIdArg] =
                pullRequestsRepository.bulkApplyFileChanges.mock.calls[0];
            expect(orgIdArg).toBe('org-from-entity');
            expect(
                pullRequestsRepository.computeFileTotals,
            ).toHaveBeenCalledWith('pr-uuid-fallback', 'org-from-entity');
        });

        it('returns null and skips bulkWrite when existingPR has no uuid', async () => {
            await callHandleExisting({
                existingPR: { files: [] },
                changedFiles: [makeChangedFile('src/a.ts')],
            });

            expect(
                pullRequestsRepository.bulkApplyFileChanges,
            ).not.toHaveBeenCalled();
        });

        it('skips existing files missing id or path instead of producing ops with undefined fileId', async () => {
            const existingPR = {
                uuid: 'pr-uuid-defensive',
                files: [
                    makeExistingFile('src/good.ts'),
                    { ...makeExistingFile('src/no-id.ts'), id: undefined },
                    { ...makeExistingFile('src/no-path.ts'), path: undefined },
                ],
            };

            await callHandleExisting({
                existingPR,
                changedFiles: [
                    // Hits good → updateFile
                    makeChangedFile('src/good.ts'),
                    // Hits no-id by path → since no-id was skipped from the
                    // index, this becomes an addFile, not an updateFile
                    // with `fileId: undefined`.
                    makeChangedFile('src/no-id.ts'),
                ],
            });

            const ops =
                pullRequestsRepository.bulkApplyFileChanges.mock.calls[0][2];
            const updateOps = ops.filter(
                (op: any) => op.kind === 'updateFile',
            );
            for (const op of updateOps) {
                expect(op.fileId).toBeDefined();
                expect(op.fileId).not.toBeNull();
            }
        });

        it('de-duplicates changedFiles by filename so two ops do not target the same files.$.id in one chunk', async () => {
            const existingPR = {
                uuid: 'pr-uuid-dup',
                files: [makeExistingFile('src/dup.ts')],
            };

            await callHandleExisting({
                existingPR,
                changedFiles: [
                    makeChangedFile('src/dup.ts'),
                    makeChangedFile('src/dup.ts'),
                    makeChangedFile('src/dup.ts'),
                ],
            });

            const ops =
                pullRequestsRepository.bulkApplyFileChanges.mock.calls[0][2];
            const updateOps = ops.filter(
                (op: any) => op.kind === 'updateFile',
            );
            expect(updateOps).toHaveLength(1);
        });

        it('skips changedFiles entries missing `filename`', async () => {
            const existingPR = {
                uuid: 'pr-uuid-missing',
                files: [],
            };

            await callHandleExisting({
                existingPR,
                changedFiles: [
                    { sha: 'x' }, // no filename
                    makeChangedFile('src/real.ts'),
                ],
            });

            const ops =
                pullRequestsRepository.bulkApplyFileChanges.mock.calls[0][2];
            expect(ops).toHaveLength(1);
            expect(ops[0].kind).toBe('addFile');
            expect(ops[0].file.path).toBe('src/real.ts');
        });

        it('does not call bulkApplyFileChanges when there are zero ops', async () => {
            const existingPR = {
                uuid: 'pr-uuid-empty',
                files: [],
            };

            await callHandleExisting({
                existingPR,
                changedFiles: [],
            });

            expect(
                pullRequestsRepository.bulkApplyFileChanges,
            ).not.toHaveBeenCalled();
            // Totals must still be recomputed — empty changes can
            // happen on a webhook for status-only updates, and we
            // want the PR's persisted totals to stay correct even
            // then.
            expect(
                pullRequestsRepository.computeFileTotals,
            ).toHaveBeenCalledWith('pr-uuid-empty', 'org-1');
        });
    });

    // ─────────────────────────────────────────────────────────
    // D) Error reporting from bulkWrite
    // ─────────────────────────────────────────────────────────

    describe('bulk write error reporting', () => {
        it('logs at error level when bulkApplyFileChanges returns errors, but still updates totals from ground truth', async () => {
            pullRequestsRepository.bulkApplyFileChanges.mockResolvedValue({
                attempted: 2,
                modified: 1,
                errors: [
                    { opIndex: 1, code: 11000, message: 'duplicate key' },
                ],
            });
            pullRequestsRepository.computeFileTotals.mockResolvedValue({
                totalAdded: 5,
                totalDeleted: 5,
                totalChanges: 10,
            });

            const existingPR = {
                uuid: 'pr-uuid-errors',
                files: [makeExistingFile('src/a.ts')],
            };

            const logger = (service as any).logger;

            await callHandleExisting({
                existingPR,
                changedFiles: [
                    makeChangedFile('src/a.ts'),
                    makeChangedFile('src/b.ts'),
                ],
            });

            expect(logger.error).toHaveBeenCalled();
            // Despite the partial failure, the totals update still
            // runs — leaving the doc in a coherent state.
            expect(pullRequestsRepository.update).toHaveBeenCalled();
            const [, patch] =
                pullRequestsRepository.update.mock.calls[0];
            expect(patch.totalAdded).toBe(5);
        });
    });
});
