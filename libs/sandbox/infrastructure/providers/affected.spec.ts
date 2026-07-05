import { EnvironmentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { globToRegExp, matchesAnyGlob, resolveScopedRun } from './affected';

describe('giant-project scoping (affected.ts)', () => {
    describe('globToRegExp / matchesAnyGlob', () => {
        it('matches ** across path separators', () => {
            expect(matchesAnyGlob('packages/cli/src/x.ts', ['packages/cli/**'])).toBe(true);
        });
        it('does not match a different package', () => {
            expect(matchesAnyGlob('packages/core/y.ts', ['packages/cli/**'])).toBe(false);
        });
        it('single * does not cross a slash', () => {
            expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
            expect(globToRegExp('src/*.ts').test('src/nested/a.ts')).toBe(false);
        });
        it('escapes regex metacharacters in literals', () => {
            expect(matchesAnyGlob('a.b.ts', ['a.b.ts'])).toBe(true);
            expect(matchesAnyGlob('axb.ts', ['a.b.ts'])).toBe(false);
        });
    });

    describe('resolveScopedRun — affected mode', () => {
        const scope: EnvironmentConfig['scope'] = {
            affected: {
                tool: 'turbo',
                build: ['turbo run build --filter=...[{base}]'],
                test: ['turbo run test --filter=...[{base}]'],
            },
        };
        it('substitutes {base} and reports the tool', () => {
            const r = resolveScopedRun(scope, ['packages/cli/x.ts'], 'origin/main');
            expect(r).not.toBeNull();
            expect(r!.build).toEqual(['turbo run build --filter=...[origin/main]']);
            expect(r!.reason).toContain('turbo');
        });
    });

    describe('resolveScopedRun — components mode', () => {
        const scope: EnvironmentConfig['scope'] = {
            components: [
                { name: 'backend', paths: ['packages/cli/**', 'packages/core/**'], build: ['b-build'], test: ['b-test'] },
                { name: 'ui', paths: ['packages/editor-ui/**'], build: ['ui-build'], test: [] },
            ],
        };
        it('selects only the touched component', () => {
            const r = resolveScopedRun(scope, ['packages/cli/a.ts'], 'x');
            expect(r!.reason).toBe('components: backend');
            expect(r!.build).toEqual(['b-build']);
        });
        it('unions multiple touched components', () => {
            const r = resolveScopedRun(scope, ['packages/cli/a.ts', 'packages/editor-ui/b.vue'], 'x');
            expect(r!.reason).toBe('components: backend, ui');
            expect(r!.build).toEqual(['b-build', 'ui-build']);
        });
        it('returns null (→ full build) when no component matches', () => {
            expect(resolveScopedRun(scope, ['docs/z.md'], 'x')).toBeNull();
        });
    });

    describe('resolveScopedRun — guards', () => {
        it('returns null with no scope', () => {
            expect(resolveScopedRun(undefined, ['a.ts'], 'x')).toBeNull();
        });
        it('returns null with no changed files', () => {
            expect(resolveScopedRun({ components: [{ name: 'x', paths: ['**'] }] }, [], 'x')).toBeNull();
        });
    });
});
