import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { PreviewEnvSnapshotService } from './preview-env-snapshot.service';

/**
 * Unit test of the golden-snapshot registry: the fingerprint is deterministic
 * and changes with the playbook/lockfiles, resolveFresh only returns a matching
 * snapshot (stale → null), and record swaps the entry + returns the previous
 * one (for GC).
 */
const makeService = () => {
    let stored: any = undefined;
    const orgParams = {
        findByKey: jest.fn(async (key: OrganizationParametersKey) => {
            expect(key).toBe(OrganizationParametersKey.ENVIRONMENT_SNAPSHOTS);
            return stored ? { configValue: stored } : null;
        }),
        createOrUpdateConfig: jest.fn(async (_k: any, value: any) => {
            stored = value;
            return true;
        }),
    } as any;
    const service = new PreviewEnvSnapshotService(orgParams);
    const orgAndTeam = { organizationId: 'o1', teamId: 't1' } as any;
    return { service, orgAndTeam, getStored: () => stored };
};

describe('PreviewEnvSnapshotService', () => {
    it('computeKey is deterministic and order-insensitive on requiredEnv', () => {
        const { service } = makeService();
        const a = service.computeKey({ setup: ['npm ci'], build: ['npm run build'], requiredEnv: ['A', 'B'] });
        const b = service.computeKey({ setup: ['npm ci'], build: ['npm run build'], requiredEnv: ['B', 'A'] });
        expect(a).toBe(b);
    });

    it('computeKey changes when the build/setup or lockfiles change', () => {
        const { service } = makeService();
        const base = service.computeKey({ setup: ['npm ci'], build: ['b'] });
        expect(service.computeKey({ setup: ['npm ci'], build: ['b2'] })).not.toBe(base);
        expect(service.computeKey({ setup: ['npm ci'], build: ['b'] }, { 'pnpm-lock.yaml': 'sha1' }))
            .not.toBe(base);
        // same lockfile sha → same key
        expect(service.computeKey({ setup: ['npm ci'], build: ['b'] }, { 'pnpm-lock.yaml': 'sha1' }))
            .toBe(service.computeKey({ setup: ['npm ci'], build: ['b'] }, { 'pnpm-lock.yaml': 'sha1' }));
    });

    it('resolveFresh returns the snapshot only when the key matches', async () => {
        const { service, orgAndTeam } = makeService();
        await service.record(orgAndTeam, 'r1', { imageId: 'img1', key: 'k1', region: 'hil' });
        expect((await service.resolveFresh(orgAndTeam, 'r1', 'k1'))?.imageId).toBe('img1');
        expect(await service.resolveFresh(orgAndTeam, 'r1', 'k2')).toBeNull(); // stale
        expect(await service.resolveFresh(orgAndTeam, 'other', 'k1')).toBeNull(); // other repo
    });

    it('record swaps the entry and returns the previous one (for GC)', async () => {
        const { service, orgAndTeam } = makeService();
        const first = await service.record(orgAndTeam, 'r1', { imageId: 'img1', key: 'k1' });
        expect(first).toBeNull();
        const prev = await service.record(orgAndTeam, 'r1', { imageId: 'img2', key: 'k2' });
        expect(prev?.imageId).toBe('img1'); // caller deletes img1
        expect((await service.peek(orgAndTeam, 'r1'))?.imageId).toBe('img2');
    });

    it('scopes snapshots per repository', async () => {
        const { service, orgAndTeam } = makeService();
        await service.record(orgAndTeam, 'r1', { imageId: 'a', key: 'k' });
        await service.record(orgAndTeam, 'r2', { imageId: 'b', key: 'k' });
        expect((await service.peek(orgAndTeam, 'r1'))?.imageId).toBe('a');
        expect((await service.peek(orgAndTeam, 'r2'))?.imageId).toBe('b');
    });
});
