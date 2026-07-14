import { PlatformType } from '@libs/core/domain/enums';

import { CloneParamsResolverService } from './clone-params-resolver.service';

/**
 * Regression coverage for issue #1541.
 *
 * A CLI review against a repository on a self-managed git host (GitLab
 * self-managed, Bitbucket Server, Gitea/Forgejo, GHES) used to clone from
 * github.com: the CLI can only infer a platform from well-known SaaS
 * hostnames, so `inferredPlatform` arrives undefined, the resolver defaulted
 * to GITHUB, and the GitHub clone params then overwrote the real remote with
 * `https://github.com/<fullName>`.
 */

const SELF_MANAGED_HOST = 'git.acme.com';
const GITLAB_TOKEN = 'glpat-self-managed';
const GITHUB_TOKEN = 'ghs-github-token';

const cliContext = (remote: string, inferredPlatform?: PlatformType) =>
    ({
        gitContext: { remote, branch: 'feature/x', inferredPlatform },
    }) as any;

const pipelineContext = () =>
    ({
        origin: 'cli',
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    }) as any;

/** Clone params shaped like the ones each real adapter returns. */
const paramsFor = (platform: PlatformType, fullName: string) => {
    switch (platform) {
        case PlatformType.GITHUB:
            return {
                url: `https://github.com/${fullName}`,
                provider: PlatformType.GITHUB,
                auth: { type: 'oauth', token: GITHUB_TOKEN },
            };
        case PlatformType.GITLAB:
            return {
                url: `https://${SELF_MANAGED_HOST}/${fullName}`,
                provider: PlatformType.GITLAB,
                auth: { type: 'token', token: GITLAB_TOKEN },
            };
        default:
            return null;
    }
};

describe('CloneParamsResolverService (CLI mode, self-managed host)', () => {
    const REMOTE = `https://${SELF_MANAGED_HOST}/group/repo.git`;

    let service: CloneParamsResolverService;
    let codeManagementService: {
        getCloneParams: jest.Mock;
        getCodeManagementPlatforms: jest.Mock;
    };

    beforeEach(() => {
        codeManagementService = {
            // This organization connected a self-managed GitLab, nothing else.
            getCodeManagementPlatforms: jest
                .fn()
                .mockResolvedValue([PlatformType.GITLAB]),
            getCloneParams: jest.fn(async (params: any, type?: PlatformType) =>
                paramsFor(type, params.repository.fullName),
            ),
        };

        service = new CloneParamsResolverService(codeManagementService as any);
    });

    it('does not clone from github.com when the platform cannot be inferred', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(REMOTE),
        );

        expect(result?.url).not.toContain('github.com');
        expect(new URL(result!.url).hostname).toBe(SELF_MANAGED_HOST);
    });

    it('does not assume GitHub when asking for clone params', async () => {
        await service.resolve(pipelineContext(), cliContext(REMOTE));

        const platformsAskedFor =
            codeManagementService.getCloneParams.mock.calls.map(([, type]) => type);

        expect(platformsAskedFor).not.toContain(PlatformType.GITHUB);
        expect(platformsAskedFor).toEqual([PlatformType.GITLAB]);
    });

    it('resolves the credentials of the connected integration', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(REMOTE),
        );

        expect(result?.authToken).toBe(GITLAB_TOKEN);
        expect(result?.platform).toBe(PlatformType.GITLAB);
    });

    it('still honors an explicitly inferred platform', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(REMOTE, PlatformType.GITLAB),
        );

        // Inferred from the hostname: no need to enumerate integrations.
        expect(
            codeManagementService.getCodeManagementPlatforms,
        ).not.toHaveBeenCalled();
        expect(new URL(result!.url).hostname).toBe(SELF_MANAGED_HOST);
    });

    it('resolves an scp-like SSH remote against the same host', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(`git@${SELF_MANAGED_HOST}:group/repo.git`),
        );

        expect(new URL(result!.url).hostname).toBe(SELF_MANAGED_HOST);
        expect(result?.authToken).toBe(GITLAB_TOKEN);
    });

    it('trusts a lone integration whose host differs from the remote', async () => {
        // Internal DNS alias / mirror / vanity hostname: the remote and the
        // configured integration name the same server differently. With a
        // single integration there is nothing to disambiguate against, and
        // rejecting it would regress a setup that works today.
        const result = await service.resolve(
            pipelineContext(),
            cliContext('https://git-mirror.acme.com/group/repo.git'),
        );

        expect(result?.authToken).toBe(GITLAB_TOKEN);
        expect(result?.platform).toBe(PlatformType.GITLAB);
    });

    it('skips the sandbox when the organization has no integration at all', async () => {
        codeManagementService.getCodeManagementPlatforms.mockResolvedValue([]);

        const result = await service.resolve(
            pipelineContext(),
            cliContext(REMOTE),
        );

        expect(result).toBeNull();
        expect(codeManagementService.getCloneParams).not.toHaveBeenCalled();
    });
});

/**
 * A team can hold more than one active code-management integration: nothing
 * deactivates the previous one on connect, there is no unique constraint on
 * (org, team, category), and getTypeIntegration resolves it with a findOne
 * carrying no ORDER BY. The remote's host is the only thing that says which
 * integration a CLI review actually belongs to.
 */
describe('CloneParamsResolverService (team with several integrations)', () => {
    let service: CloneParamsResolverService;
    let codeManagementService: {
        getCloneParams: jest.Mock;
        getCodeManagementPlatforms: jest.Mock;
    };

    beforeEach(() => {
        codeManagementService = {
            // GitHub was connected first and would win an unordered findOne.
            getCodeManagementPlatforms: jest
                .fn()
                .mockResolvedValue([PlatformType.GITHUB, PlatformType.GITLAB]),
            getCloneParams: jest.fn(async (params: any, type?: PlatformType) =>
                paramsFor(type, params.repository.fullName),
            ),
        };

        service = new CloneParamsResolverService(codeManagementService as any);
    });

    it('picks the integration that serves the remote host', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(`https://${SELF_MANAGED_HOST}/group/repo.git`),
        );

        expect(new URL(result!.url).hostname).toBe(SELF_MANAGED_HOST);
        expect(result?.platform).toBe(PlatformType.GITLAB);
        expect(result?.authToken).toBe(GITLAB_TOKEN);
    });

    it('picks GitHub for a github.com remote in the same organization', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext('https://github.com/group/repo.git'),
        );

        expect(new URL(result!.url).hostname).toBe('github.com');
        expect(result?.platform).toBe(PlatformType.GITHUB);
        expect(result?.authToken).toBe(GITHUB_TOKEN);
    });

    it('never hands back credentials from the non-matching integration', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext(`https://${SELF_MANAGED_HOST}/group/repo.git`),
        );

        expect(result?.authToken).not.toBe(GITHUB_TOKEN);
    });

    it('skips the sandbox when no integration serves the remote host', async () => {
        const result = await service.resolve(
            pipelineContext(),
            cliContext('https://git.elsewhere.com/group/repo.git'),
        );

        // Every token on file authenticates against another platform. Better
        // no sandbox than a wrong one — the review still runs without it.
        expect(result).toBeNull();
    });
});

/**
 * The mechanism must not be GitHub-shaped: every platform resolves the same
 * way, through the organization's connected integration.
 */
describe('CloneParamsResolverService (platform coverage)', () => {
    const cases = [
        {
            name: 'GitLab self-managed',
            host: 'gitlab.acme.com',
            provider: PlatformType.GITLAB,
        },
        {
            name: 'GitHub Enterprise Server',
            host: 'github.acme.com',
            provider: PlatformType.GITHUB,
        },
        {
            name: 'Bitbucket Server',
            host: 'bitbucket.acme.com',
            provider: PlatformType.BITBUCKET,
        },
        {
            name: 'Forgejo self-hosted',
            host: 'forgejo.acme.com',
            provider: PlatformType.FORGEJO,
        },
        {
            name: 'Azure DevOps',
            host: 'dev.azure.com',
            provider: PlatformType.AZURE_REPOS,
        },
        {
            name: 'GitHub SaaS',
            host: 'github.com',
            provider: PlatformType.GITHUB,
        },
    ];

    it.each(cases)(
        'clones $name from its own host with its own credentials',
        async ({ host, provider }) => {
            const codeManagementService = {
                getCodeManagementPlatforms: jest.fn().mockResolvedValue([provider]),
                getCloneParams: jest.fn().mockResolvedValue({
                    url: `https://${host}/group/repo`,
                    provider,
                    auth: { type: 'token', token: `token-for-${provider}` },
                }),
            };

            const service = new CloneParamsResolverService(
                codeManagementService as any,
            );

            const result = await service.resolve(
                pipelineContext(),
                cliContext(`https://${host}/group/repo.git`),
            );

            expect(new URL(result!.url).hostname).toBe(host);
            expect(result?.platform).toBe(provider);
            expect(result?.authToken).toBe(`token-for-${provider}`);
        },
    );
});
