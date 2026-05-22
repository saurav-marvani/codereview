import {
    buildRepositoryDirectoryKey,
    REPOSITORY_DIRECTORY_KEY_SEPARATOR,
} from './repository-directory-key';

describe('buildRepositoryDirectoryKey', () => {
    it('joins repositoryId and directoryId with the documented separator', () => {
        expect(buildRepositoryDirectoryKey('repo-9', 'dir-42')).toBe(
            'repo-9:dir-42',
        );
    });

    it('uses the exported separator constant', () => {
        const key = buildRepositoryDirectoryKey('a', 'b');
        expect(key).toContain(REPOSITORY_DIRECTORY_KEY_SEPARATOR);
    });

    it('handles UUID-shaped ids', () => {
        expect(
            buildRepositoryDirectoryKey(
                'd67b8ea5-50d5-4dc3-b8e8-c73748ab489a',
                '0809af99-88c3-422d-876d-e01fa5f0fce5',
            ),
        ).toBe(
            'd67b8ea5-50d5-4dc3-b8e8-c73748ab489a:0809af99-88c3-422d-876d-e01fa5f0fce5',
        );
    });
});
