// Reversible fake crypto (crypto.ts throws at import without API_CRYPTO_KEY).
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => (v ? `enc(${v})` : ''),
    decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
}));

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { PreviewEnvInfraService } from './preview-env-infra.service';

/**
 * Unit test of the org-level BYO-cloud infra config: token encrypted at rest
 * and never returned by status; empty removes / omitted keeps; resolveInfra
 * decrypts for the stage; unset org → null (env fallback).
 */
const makeService = () => {
    let stored: any = undefined;
    const orgParams = {
        findByKey: jest.fn(async (key: OrganizationParametersKey) => {
            expect(key).toBe(OrganizationParametersKey.ENVIRONMENT_INFRA);
            return stored ? { configValue: stored } : null;
        }),
        createOrUpdateConfig: jest.fn(async (_key: any, value: any) => {
            stored = value;
            return true;
        }),
    } as any;
    const service = new PreviewEnvInfraService(orgParams);
    const orgAndTeam = { organizationId: 'o1', teamId: 't1' } as any;
    return { service, orgAndTeam, getStored: () => stored };
};

describe('PreviewEnvInfraService', () => {
    it('encrypts the token at rest and never returns it via status', async () => {
        const { service, orgAndTeam, getStored } = makeService();
        await service.setInfra(orgAndTeam, {
            provider: 'hetzner',
            token: 'hcloud-secret',
            region: 'hil',
        });

        expect(JSON.stringify(getStored())).toContain('enc(hcloud-secret)');
        const status = await service.getStatus(orgAndTeam);
        expect(status).toEqual({
            provider: 'hetzner',
            region: 'hil',
            serverType: undefined,
            tokenConfigured: true,
        });
        expect(JSON.stringify(status)).not.toContain('hcloud-secret');
    });

    it('omitted token keeps the existing one; empty string removes it', async () => {
        const { service, orgAndTeam } = makeService();
        await service.setInfra(orgAndTeam, { provider: 'hetzner', token: 't1' });

        // Edit only the region — token untouched.
        await service.setInfra(orgAndTeam, { provider: 'hetzner', region: 'ash' });
        expect((await service.resolveInfra(orgAndTeam))?.token).toBe('t1');
        expect((await service.getStatus(orgAndTeam))?.region).toBe('ash');

        // Empty string removes the token.
        await service.setInfra(orgAndTeam, { provider: 'hetzner', token: '' });
        expect(await service.resolveInfra(orgAndTeam)).toBeNull();
        expect((await service.getStatus(orgAndTeam))?.tokenConfigured).toBe(false);
    });

    it('resolveInfra decrypts for the stage', async () => {
        const { service, orgAndTeam } = makeService();
        await service.setInfra(orgAndTeam, {
            provider: 'hetzner',
            token: 'tok',
            serverType: 'cpx41',
        });
        expect(await service.resolveInfra(orgAndTeam)).toEqual({
            provider: 'hetzner',
            region: undefined,
            serverType: 'cpx41',
            token: 'tok',
        });
    });

    it('unset org → null everywhere (env fallback applies)', async () => {
        const { service, orgAndTeam } = makeService();
        expect(await service.getStatus(orgAndTeam)).toBeNull();
        expect(await service.resolveInfra(orgAndTeam)).toBeNull();
    });
});
