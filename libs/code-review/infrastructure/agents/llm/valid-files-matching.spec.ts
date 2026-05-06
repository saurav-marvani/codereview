import { normalizeRepoPath } from './coverage-ledger';

/**
 * Reproduces the validFiles matching logic from base-code-review-agent.provider.ts:
 *
 *   const validFiles = new Set(
 *       input.changedFiles.map((f) => normalizeRepoPath(f.filename)),
 *   );
 *   return !!s.relevantFile && validFiles.has(normalizeRepoPath(s.relevantFile));
 *
 * Tests confirm that path normalization handles all 4 Git providers.
 */

function buildValidFilesSet(filenames: string[]): Set<string> {
    return new Set(filenames.map((f) => normalizeRepoPath(f)));
}

function matchesSuggestion(
    validFiles: Set<string>,
    relevantFile: string | undefined,
): boolean {
    return !!relevantFile && validFiles.has(normalizeRepoPath(relevantFile));
}

describe('validFiles path matching across Git providers', () => {
    describe('GitHub', () => {
        it('matches paths without leading slash', () => {
            const validFiles = buildValidFilesSet([
                'src/components/Button.tsx',
                'src/utils/helpers.ts',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/components/Button.tsx'),
            ).toBe(true);
            expect(
                matchesSuggestion(validFiles, 'src/utils/helpers.ts'),
            ).toBe(true);
        });

        it('rejects non-existent files', () => {
            const validFiles = buildValidFilesSet([
                'src/components/Button.tsx',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/components/Other.tsx'),
            ).toBe(false);
        });
    });

    describe('GitLab', () => {
        it('matches paths without leading slash', () => {
            const validFiles = buildValidFilesSet([
                'app/models/user.rb',
                'spec/models/user_spec.rb',
            ]);
            expect(
                matchesSuggestion(validFiles, 'app/models/user.rb'),
            ).toBe(true);
        });
    });

    describe('Azure Repos', () => {
        it('matches when changedFiles have leading slash and suggestion does not', () => {
            const validFiles = buildValidFilesSet([
                '/Kodus.Api/Exceptions/ExceptionHandler.php',
                '/Kodus.Api/Entities/User.php',
            ]);
            expect(
                matchesSuggestion(
                    validFiles,
                    'Kodus.Api/Exceptions/ExceptionHandler.php',
                ),
            ).toBe(true);
            expect(
                matchesSuggestion(
                    validFiles,
                    'Kodus.Api/Entities/User.php',
                ),
            ).toBe(true);
        });

        it('matches when both have leading slash', () => {
            const validFiles = buildValidFilesSet([
                '/Kodus.Api/Exceptions/ExceptionHandler.php',
            ]);
            expect(
                matchesSuggestion(
                    validFiles,
                    '/Kodus.Api/Exceptions/ExceptionHandler.php',
                ),
            ).toBe(true);
        });

        it('matches when changedFiles have no slash but suggestion has leading slash', () => {
            const validFiles = buildValidFilesSet([
                'Kodus.Api/Exceptions/ExceptionHandler.php',
            ]);
            expect(
                matchesSuggestion(
                    validFiles,
                    '/Kodus.Api/Exceptions/ExceptionHandler.php',
                ),
            ).toBe(true);
        });

        it('matches with multiple leading slashes', () => {
            const validFiles = buildValidFilesSet([
                '///src/Program.php',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/Program.php'),
            ).toBe(true);
        });
    });

    describe('Bitbucket', () => {
        it('matches standard paths', () => {
            const validFiles = buildValidFilesSet([
                'src/main/java/com/example/App.java',
            ]);
            expect(
                matchesSuggestion(
                    validFiles,
                    'src/main/java/com/example/App.java',
                ),
            ).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('rejects undefined relevantFile', () => {
            const validFiles = buildValidFilesSet(['src/file.ts']);
            expect(matchesSuggestion(validFiles, undefined)).toBe(false);
        });

        it('rejects empty string relevantFile', () => {
            const validFiles = buildValidFilesSet(['src/file.ts']);
            expect(matchesSuggestion(validFiles, '')).toBe(false);
        });

        it('normalizes backslashes to forward slashes', () => {
            const validFiles = buildValidFilesSet([
                'src\\components\\Button.tsx',
            ]);
            expect(
                matchesSuggestion(validFiles, 'src/components/Button.tsx'),
            ).toBe(true);
        });

        it('trims whitespace from paths', () => {
            const validFiles = buildValidFilesSet([
                '  src/file.ts  ',
            ]);
            expect(matchesSuggestion(validFiles, 'src/file.ts')).toBe(true);
        });

        it('handles mixed providers in the same set', () => {
            const validFiles = buildValidFilesSet([
                '/azure-style/file.php',
                'github-style/file.ts',
                'gitlab-style/file.rb',
            ]);
            expect(
                matchesSuggestion(validFiles, 'azure-style/file.php'),
            ).toBe(true);
            expect(
                matchesSuggestion(validFiles, 'github-style/file.ts'),
            ).toBe(true);
            expect(
                matchesSuggestion(validFiles, 'gitlab-style/file.rb'),
            ).toBe(true);
        });
    });
});
