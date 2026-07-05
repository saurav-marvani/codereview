import type { PlaybookScope } from './playbook.js';

/**
 * Giant-project scoping. Given a PR's changed files and a playbook `scope`,
 * resolve the build/test commands to run for JUST the affected slice of a
 * monorepo — instead of rebuilding/retesting the whole world every PR.
 *
 * Returns null when scoping can't be applied (no scope, no changed files, or
 * no component matched) so the caller falls back to the full build/test phases.
 */
export interface ScopedRun {
    /** Human-readable which-slice explanation for logs/PR comments. */
    reason: string;
    build: string[];
    test: string[];
}

/** Minimal glob → RegExp (supports **, *, and literal paths). */
export function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // ** matches across path separators
                re += '.*';
                i++;
                if (glob[i + 1] === '/') i++; // consume the slash after **
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
    scope: PlaybookScope | undefined,
    changedFiles: string[],
    base: string,
): ScopedRun | null {
    if (!scope || !changedFiles.length) return null;

    // Preferred: the monorepo tool's own affected graph (turbo/nx/pnpm). We
    // trust the tool to compute the affected set from the git diff — this is
    // the only thing that scales to a truly giant repo (no hand-kept map).
    if (scope.affected?.build?.length || scope.affected?.test?.length) {
        const sub = (cmds: string[] | undefined) =>
            (cmds ?? []).map((c) => c.replaceAll('{base}', base));
        return {
            reason: `affected via ${scope.affected.tool ?? 'monorepo tool'} against ${base}`,
            build: sub(scope.affected.build),
            test: sub(scope.affected.test),
        };
    }

    // Fallback: declared path→component map. Union every component whose paths
    // match a changed file, then run those components' build/test.
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
