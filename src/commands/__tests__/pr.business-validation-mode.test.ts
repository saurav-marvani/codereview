import { describe, expect, it } from 'vitest';

import { resolveBusinessValidationMode } from '../pr.business-validation-mode.js';

describe('resolveBusinessValidationMode', () => {
    it('resolves pull_request mode when prUrl is provided', () => {
        const resolved = resolveBusinessValidationMode({
            prUrl: 'https://github.com/acme/repo/pull/10',
        });

        expect(resolved.mode).toBe('pull_request');
    });

    it('resolves pull_request mode when prNumber and repository are provided', () => {
        const resolved = resolveBusinessValidationMode({
            prNumber: 10,
            repoId: '123',
        });

        expect(resolved.mode).toBe('pull_request');
    });

    it('resolves local_diff mode when staged is provided', () => {
        const resolved = resolveBusinessValidationMode({
            staged: true,
        });

        expect(resolved.mode).toBe('local_diff');
    });

    it('fails when PR and local diff options are mixed', () => {
        expect(() =>
            resolveBusinessValidationMode({
                prUrl: 'https://github.com/acme/repo/pull/10',
                staged: true,
            }),
        ).toThrow(
            'Local diff scope options (--staged/--commit/--branch/[files]) cannot be used with --pr-url/--pr-number.',
        );
    });

    it('fails when prNumber is provided without repository context', () => {
        expect(() =>
            resolveBusinessValidationMode({
                prNumber: 10,
            }),
        ).toThrow('When using --pr-number, provide --repo-id or --repo.');
    });

    it('fails when both taskUrl and taskId are provided', () => {
        expect(() =>
            resolveBusinessValidationMode({
                staged: true,
                taskUrl: 'https://linear.app/acme/issue/KC-10',
                taskId: 'KC-10',
            }),
        ).toThrow('Provide only one of --task-url or --task-id.');
    });

    it('fails when no PR or local diff scope is provided', () => {
        expect(() =>
            resolveBusinessValidationMode({
                taskId: 'KC-10',
            }),
        ).toThrow(
            'Choose a mode: PR (--pr-url or --pr-number with --repo-id/--repo) or local diff (--staged/--commit/--branch/[files]).',
        );
    });
});
