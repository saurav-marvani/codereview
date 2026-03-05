export type BusinessValidationCommandMode = 'pull_request' | 'local_diff';

export interface BusinessValidationModeInput {
    files?: string[];
    prUrl?: string;
    prNumber?: number;
    repoId?: string;
    repo?: string;
    taskUrl?: string;
    taskId?: string;
    staged?: boolean;
    commit?: string;
    branch?: string;
}

export interface BusinessValidationModeResolution {
    mode: BusinessValidationCommandMode;
    hasPrContext: boolean;
    hasLocalScopeOptions: boolean;
}

export function resolveBusinessValidationMode(
    input: BusinessValidationModeInput,
): BusinessValidationModeResolution {
    const hasPrUrl = !!input.prUrl;
    const hasPrNumber = typeof input.prNumber === 'number';
    const hasPrContext = hasPrUrl || hasPrNumber;
    const hasLocalScopeOptions =
        (input.files?.length ?? 0) > 0 ||
        !!input.staged ||
        !!input.commit ||
        !!input.branch;

    if (hasPrUrl && hasPrNumber) {
        throw new Error('Provide only one of --pr-url or --pr-number.');
    }

    if (hasPrNumber && !input.repoId && !input.repo) {
        throw new Error('When using --pr-number, provide --repo-id or --repo.');
    }

    if (input.taskUrl && input.taskId) {
        throw new Error('Provide only one of --task-url or --task-id.');
    }

    if (hasPrContext && hasLocalScopeOptions) {
        throw new Error(
            'Local diff scope options (--staged/--commit/--branch/[files]) cannot be used with --pr-url/--pr-number.',
        );
    }

    if (hasPrContext) {
        return {
            mode: 'pull_request',
            hasPrContext,
            hasLocalScopeOptions,
        };
    }

    if (!hasLocalScopeOptions) {
        throw new Error(
            'Choose a mode: PR (--pr-url or --pr-number with --repo-id/--repo) or local diff (--staged/--commit/--branch/[files]).',
        );
    }

    return {
        mode: 'local_diff',
        hasPrContext,
        hasLocalScopeOptions,
    };
}
