// Mock the crypto util with a reversible fake so the test doesn't depend on
// API_CRYPTO_KEY (crypto.ts throws at import time without a valid 32-byte key).
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => (v ? `enc(${v})` : ''),
    decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
}));

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import {
    PreviewEnvSecretsService,
    SECRETS_GLOBAL_SCOPE,
} from './preview-env-secrets.service';

/**
 * Unit test of the encrypted per-repo secrets vault: values are encrypted at
 * rest, merge-updated (empty removes, omitted kept), status returns names only,
 * and resolve decrypts + filters by requiredEnv.
 */
const makeService = () => {
    // In-memory stand-in for the org-parameters store.
    let stored: any = undefined;
    const orgParams = {
        findByKey: jest.fn(async (key: OrganizationParametersKey) => {
            expect(key).toBe(OrganizationParametersKey.ENVIRONMENT_SECRETS);
            return stored ? { configValue: stored } : null;
        }),
        createOrUpdateConfig: jest.fn(
            async (_key: OrganizationParametersKey, value: any) => {
                stored = value;
                return true;
            },
        ),
    } as any;
    const service = new PreviewEnvSecretsService(orgParams);
    const orgAndTeam = { organizationId: 'o1', teamId: 't1' } as any;
    return { service, orgParams, orgAndTeam, getStored: () => stored };
};

describe('PreviewEnvSecretsService', () => {
    it('encrypts at rest and never persists plaintext', async () => {
        const { service, orgAndTeam, getStored } = makeService();
        await service.setSecrets(orgAndTeam, 'r1', { DB_URL: 'postgres://secret' });

        const raw = JSON.stringify(getStored());
        expect(raw).toContain('enc(postgres://secret)');
        expect(raw).not.toContain('postgres://secret"'); // no bare plaintext value
    });

    it('merges partial edits: omitted keys kept, empty-string removes', async () => {
        const { service, orgAndTeam } = makeService();
        await service.setSecrets(orgAndTeam, 'r1', { A: '1', B: '2' });
        // Edit only B, leave A untouched, and remove nothing.
        await service.setSecrets(orgAndTeam, 'r1', { B: '22' });
        expect((await service.getStatus(orgAndTeam, 'r1')).sort()).toEqual(['A', 'B']);
        expect(await service.resolveSecrets(orgAndTeam, 'r1')).toEqual({ A: '1', B: '22' });

        // Empty string removes A.
        await service.setSecrets(orgAndTeam, 'r1', { A: '' });
        expect((await service.getStatus(orgAndTeam, 'r1'))).toEqual(['B']);
    });

    it('getStatus returns names only (never values)', async () => {
        const { service, orgAndTeam } = makeService();
        await service.setSecrets(orgAndTeam, 'r1', { TOKEN: 'abc', KEY: 'xyz' });
        const names = await service.getStatus(orgAndTeam, 'r1');
        expect(names.sort()).toEqual(['KEY', 'TOKEN']);
        expect(JSON.stringify(names)).not.toContain('abc');
    });

    it('scopes secrets per repository', async () => {
        const { service, orgAndTeam } = makeService();
        await service.setSecrets(orgAndTeam, 'r1', { A: '1' });
        await service.setSecrets(orgAndTeam, 'r2', { B: '2' });
        expect(await service.resolveSecrets(orgAndTeam, 'r1')).toEqual({ A: '1' });
        expect(await service.resolveSecrets(orgAndTeam, 'r2')).toEqual({ B: '2' });
    });

    it('resolveSecrets filters to requiredEnv when provided', async () => {
        const { service, orgAndTeam } = makeService();
        await service.setSecrets(orgAndTeam, 'r1', { A: '1', B: '2', C: '3' });
        expect(await service.resolveSecrets(orgAndTeam, 'r1', ['A', 'C'])).toEqual({
            A: '1',
            C: '3',
        });
    });

    it('returns empty for an unconfigured repo', async () => {
        const { service, orgAndTeam } = makeService();
        expect(await service.getStatus(orgAndTeam, 'nope')).toEqual([]);
        expect(await service.resolveSecrets(orgAndTeam, 'nope')).toEqual({});
    });
});

describe('PreviewEnvSecretsService — global inheritance', () => {
    // Seed global defaults + a repo that overrides one and adds one.
    const seed = async (service: PreviewEnvSecretsService, orgAndTeam: any) => {
        await service.setSecrets(orgAndTeam, SECRETS_GLOBAL_SCOPE, {
            NPM_TOKEN: 'abc',
            JWT_SECRET: 'default',
        });
        await service.setSecrets(orgAndTeam, 'repo1', {
            JWT_SECRET: 'repo1-key',
            DB_URL: 'pg://x',
        });
    };

    it('resolveSecrets merges global under the repo (repo overrides, global inherited, repo-only kept)', async () => {
        const { service, orgAndTeam } = makeService();
        await seed(service, orgAndTeam);
        expect(await service.resolveSecrets(orgAndTeam, 'repo1')).toEqual({
            NPM_TOKEN: 'abc', // inherited from global
            JWT_SECRET: 'repo1-key', // repo overrides global's "default"
            DB_URL: 'pg://x', // repo-only
        });
    });

    it('a repo with no own secrets inherits all the global defaults', async () => {
        const { service, orgAndTeam } = makeService();
        await seed(service, orgAndTeam);
        expect(await service.resolveSecrets(orgAndTeam, 'repo-none')).toEqual({
            NPM_TOKEN: 'abc',
            JWT_SECRET: 'default',
        });
    });

    it('the global scope resolves to just its own secrets (no self-inherit)', async () => {
        const { service, orgAndTeam } = makeService();
        await seed(service, orgAndTeam);
        expect(await service.resolveSecrets(orgAndTeam, SECRETS_GLOBAL_SCOPE)).toEqual({
            NPM_TOKEN: 'abc',
            JWT_SECRET: 'default',
        });
    });

    it('requiredEnv filter applies across the merged set', async () => {
        const { service, orgAndTeam } = makeService();
        await seed(service, orgAndTeam);
        expect(
            await service.resolveSecrets(orgAndTeam, 'repo1', ['NPM_TOKEN', 'DB_URL']),
        ).toEqual({ NPM_TOKEN: 'abc', DB_URL: 'pg://x' });
    });

    it('getStatus returns only the scope’s own names (inheritance is applied at resolve/merge time, and in the UI)', async () => {
        const { service, orgAndTeam } = makeService();
        await seed(service, orgAndTeam);
        expect((await service.getStatus(orgAndTeam, 'repo1')).sort()).toEqual(['DB_URL', 'JWT_SECRET']);
        expect((await service.getStatus(orgAndTeam, SECRETS_GLOBAL_SCOPE)).sort()).toEqual(['JWT_SECRET', 'NPM_TOKEN']);
    });
});
