import { EnvironmentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * Giant-project scoping. Given a PR's changed files and the repo's
 * `environment.scope`, resolve the build/test commands to run for JUST the
 * affected slice of a monorepo instead of the whole thing. Returns null when
 * scoping can't apply (no scope / no changed files / no component matched) so
 * the caller falls back to the full build/test phases.
 *
 * Ported from the preview-env experiment (measured live on n8n: a leaf-package
 * change rebuilds ~4-11 of 70 packages). Pure logic, no I/O.
 */
export interface ScopedRun {
    reason: string;
    build: string[];
    test: string[];
}

/** Minimal glob → RegExp (supports **, *, literals). */
export function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                re += '.*';
                i++;
                if (glob[i + 1] === '/') i++;
            } else {
                re += '[^/]*';
            }
        } else if ('.+?^${}()|[]\\'.includes(c)) {
            re += '\\' + c;
        } else {
            re += c;
        }
    }
    return new RegExp('^' + re + '$');
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
    return globs.some((g) => globToRegExp(g).test(path));
}

export function resolveScopedRun(
    scope: EnvironmentConfig['scope'] | undefined,
    changedFiles: string[],
    base: string,
): ScopedRun | null {
    if (!scope || !changedFiles.length) return null;

    // Preferred: the monorepo tool's own affected graph (turbo/nx/pnpm).
    if (scope.affected?.build?.length || scope.affected?.test?.length) {
        const sub = (cmds: string[] | undefined) =>
            (cmds ?? []).map((c) => c.split('{base}').join(base));
        return {
            reason: `affected via ${scope.affected.tool ?? 'monorepo tool'} against ${base}`,
            build: sub(scope.affected.build),
            test: sub(scope.affected.test),
        };
    }

    // Fallback: declared path→component map — union every matched component.
    if (scope.components?.length) {
        const hit = scope.components.filter((comp) =>
            changedFiles.some((f) => matchesAnyGlob(f, comp.paths)),
        );
        if (!hit.length) return null;
        return {
            reason: `components: ${hit.map((c) => c.name).join(', ')}`,
            build: hit.flatMap((c) => c.build ?? []),
            test: hit.flatMap((c) => c.test ?? []),
        };
    }

    return null;
}
