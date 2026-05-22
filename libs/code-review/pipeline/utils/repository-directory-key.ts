/**
 * Composite group key for the PostHog `repositoryDirectory` group type
 * — pairs a repository id with one of its configured directory ids so
 * the agent-review opt-out can target a directory *within a specific
 * repo*, not directory ids in the abstract.
 *
 * The script in `scripts/set-agent-review-directory-optout.ts` builds
 * the same keys when populating the PostHog flag; both sides must agree
 * on the separator.
 */
export const REPOSITORY_DIRECTORY_KEY_SEPARATOR = ':';

export function buildRepositoryDirectoryKey(
    repositoryId: string,
    directoryId: string,
): string {
    return `${repositoryId}${REPOSITORY_DIRECTORY_KEY_SEPARATOR}${directoryId}`;
}
