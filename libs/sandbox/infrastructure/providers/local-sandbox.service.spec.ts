import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PlatformType } from '@libs/core/domain/enums';
import { LocalSandboxService } from './local-sandbox.service';

/**
 * buildAuthHeader is the git-over-HTTPS Authorization builder used when the
 * local sandbox clones a repo. The Bitbucket branch is the regression guard
 * for #1168: Atlassian API tokens (ATATT…) authenticate to git ONLY with the
 * literal username `x-bitbucket-api-token-auth`, NOT the account email/username
 * the REST API accepts. Getting this wrong yields a silent anonymous clone and
 * `fatal: could not read Username`.
 */
describe('LocalSandboxService.buildAuthHeader', () => {
    const service = new LocalSandboxService({} as any);
    // Private method — exercise it directly.
    const build = (platform: PlatformType, token: string, username?: string) =>
        (service as any).buildAuthHeader(platform, token, username) as string;

    const decode = (header: string) =>
        Buffer.from(
            header.replace('Authorization: Basic ', ''),
            'base64',
        ).toString('utf8');

    it('uses x-access-token for GitHub', () => {
        expect(decode(build(PlatformType.GITHUB, 'ghtok'))).toBe(
            'x-access-token:ghtok',
        );
    });

    it('uses oauth2 for GitLab and Azure', () => {
        expect(decode(build(PlatformType.GITLAB, 'gltok'))).toBe(
            'oauth2:gltok',
        );
        expect(decode(build(PlatformType.AZURE_REPOS, 'aztok'))).toBe(
            'oauth2:aztok',
        );
    });

    describe('Bitbucket (#1168)', () => {
        it('uses x-bitbucket-api-token-auth for Atlassian API tokens (ATATT…), ignoring the stored email/username', () => {
            const header = build(
                PlatformType.BITBUCKET,
                'ATATT3xFfGF0token',
                'gabriel.malinosqui@kodus.io', // REST-API identity — must NOT be used for git
            );
            expect(decode(header)).toBe(
                'x-bitbucket-api-token-auth:ATATT3xFfGF0token',
            );
        });

        it('uses the account username for classic app passwords', () => {
            expect(
                decode(
                    build(PlatformType.BITBUCKET, 'classicapppw', 'kodususer'),
                ),
            ).toBe('kodususer:classicapppw');
        });

        it('still works for an API token even when no username is provided', () => {
            expect(decode(build(PlatformType.BITBUCKET, 'ATATTabc'))).toBe(
                'x-bitbucket-api-token-auth:ATATTabc',
            );
        });

        it('throws for a classic app password with no username (cannot build valid git auth)', () => {
            expect(() => build(PlatformType.BITBUCKET, 'classicpw')).toThrow(
                /Bitbucket authentication requires/i,
            );
        });
    });
});

describe('LocalSandboxService sandbox file access', () => {
    let dir: string;
    let outsideDir: string;
    let sandbox: {
        readFile: (path: string) => Promise<string>;
        writeFile: (path: string, content: string) => Promise<void>;
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-sandbox-files-'));
        outsideDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'kodus-sandbox-outside-'),
        );
        const svc = new LocalSandboxService({} as any);
        sandbox = (svc as any).buildSandboxFileAccess(dir);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('reads a repo-relative file', async () => {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
        await expect(sandbox.readFile('a.txt')).resolves.toBe('hello');
    });

    it('writes a repo-relative file and creates parent directories', async () => {
        await sandbox.writeFile('sub/b.txt', 'world');
        expect(fs.readFileSync(path.join(dir, 'sub/b.txt'), 'utf-8')).toBe(
            'world',
        );
    });

    it('rejects absolute read paths outside the repo', async () => {
        await expect(sandbox.readFile('/etc/passwd')).rejects.toThrow(
            /Absolute paths are not allowed/,
        );
    });

    it('rejects absolute write paths outside the repo', async () => {
        await expect(sandbox.writeFile('/etc/passwd', 'x')).rejects.toThrow(
            /Absolute paths are not allowed/,
        );
    });

    it('accepts absolute paths that resolve inside the repo (read)', async () => {
        const absPath = path.join(dir, 'a.txt');
        fs.writeFileSync(absPath, 'hello');
        await expect(sandbox.readFile(absPath)).resolves.toBe('hello');
    });

    it('accepts absolute paths that resolve inside the repo (write)', async () => {
        const absPath = path.join(dir, 'sub', 'c.txt');
        await sandbox.writeFile(absPath, 'content');
        expect(fs.readFileSync(absPath, 'utf-8')).toBe('content');
    });

    it('rejects absolute paths with .. traversal even under repoDir', async () => {
        const escapePath = dir + '/../outside';
        await expect(sandbox.readFile(escapePath)).rejects.toThrow(
            /Path traversal using ".." is not allowed/,
        );
    });

    it('rejects absolute write paths with .. traversal even under repoDir', async () => {
        const escapePath = dir + '/../outside';
        await expect(sandbox.writeFile(escapePath, 'x')).rejects.toThrow(
            /Path traversal using ".." is not allowed/,
        );
    });

    it('rejects .. traversal reads', async () => {
        await expect(sandbox.readFile('../outside.txt')).rejects.toThrow(
            /Path traversal using "\.\." is not allowed/,
        );
    });

    it('rejects .. traversal writes', async () => {
        await expect(sandbox.writeFile('../outside.txt', 'x')).rejects.toThrow(
            /Path traversal using "\.\." is not allowed/,
        );
    });

    it('rejects reading through a symlink that escapes the repo', async () => {
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'secret');
        fs.symlinkSync(outsideFile, path.join(dir, 'escape-link'));
        await expect(sandbox.readFile('escape-link')).rejects.toThrow(
            /Symlink detected/,
        );
    });

    it('rejects writing through a symlinked parent directory', async () => {
        fs.symlinkSync(outsideDir, path.join(dir, 'linkdir'));
        await expect(
            sandbox.writeFile('linkdir/nested/file.txt', 'x'),
        ).rejects.toThrow(/Symlink/);
    });

    it('rejects overwriting a symlinked target file', async () => {
        const outsideFile = path.join(outsideDir, 'target.txt');
        fs.writeFileSync(outsideFile, 'secret');
        fs.symlinkSync(outsideFile, path.join(dir, 'linkfile.txt'));
        await expect(sandbox.writeFile('linkfile.txt', 'x')).rejects.toThrow(
            /Symlink/,
        );
    });

    it('writes a new file under an existing safe parent directory', async () => {
        fs.mkdirSync(path.join(dir, 'safe'));
        await sandbox.writeFile('safe/new.txt', 'ok');
        expect(fs.readFileSync(path.join(dir, 'safe/new.txt'), 'utf-8')).toBe(
            'ok',
        );
    });
});
