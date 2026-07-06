import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { EnvironmentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

export interface SnapshotEntry {
    imageId: string;
    /** Fingerprint the image was built from (playbook + lockfiles). */
    key: string;
    region?: string;
    createdAt: string;
}

type SnapshotStore = Record<string, SnapshotEntry>; // repoId -> entry

/**
 * Golden-snapshot registry for Kody Runtime warm boot. A snapshot is a VM image
 * with the repo's deps installed + built, so a PR boots from it (git-fetch the
 * delta) instead of cold-installing every time. It's reused until its
 * FINGERPRINT changes — the fingerprint hashes the parts that decide the baked
 * state: the playbook's setup/build commands + the repo's lockfile blob SHAs
 * (dependency changes). Same idea as Devin's "rebuild the snapshot only on
 * config change". The registry is a plain (non-secret) org parameter.
 */
@Injectable()
export class PreviewEnvSnapshotService {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly orgParams: IOrganizationParametersService,
    ) {}

    /**
     * Deterministic fingerprint of what the snapshot bakes. `lockfiles` is a
     * caller-supplied map of lockfile path -> its blob SHA on the base branch
     * (from the platform API — cheap, no clone); it changes iff deps change.
     */
    computeKey(
        env: Pick<EnvironmentConfig, 'setup' | 'build' | 'requiredEnv'> | undefined,
        lockfiles: Record<string, string> = {},
    ): string {
        const material = JSON.stringify({
            setup: env?.setup ?? [],
            build: env?.build ?? [],
            // requiredEnv can change the baked .env shape the build reads.
            requiredEnv: [...(env?.requiredEnv ?? [])].sort(),
            lockfiles: Object.keys(lockfiles)
                .sort()
                .map((k) => `${k}:${lockfiles[k]}`),
        });
        return createHash('sha256').update(material).digest('hex').slice(0, 16);
    }

    private async load(orgAndTeam: OrganizationAndTeamData): Promise<SnapshotStore> {
        const entity = await this.orgParams
            .findByKey(OrganizationParametersKey.ENVIRONMENT_SNAPSHOTS, orgAndTeam)
            .catch(() => null);
        return (entity?.configValue as SnapshotStore) ?? {};
    }

    /**
     * The imageId of a FRESH snapshot for the repo — one whose stored key
     * matches `key`. Null when there's no snapshot or it's stale (the caller
     * then cold-boots and/or triggers a rebuild).
     */
    async resolveFresh(
        orgAndTeam: OrganizationAndTeamData,
        repositoryId: string,
        key: string,
    ): Promise<SnapshotEntry | null> {
        const store = await this.load(orgAndTeam);
        const entry = store[repositoryId];
        return entry && entry.key === key ? entry : null;
    }

    /** The current entry regardless of freshness (e.g. to GC a stale image). */
    async peek(
        orgAndTeam: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<SnapshotEntry | null> {
        const store = await this.load(orgAndTeam);
        return store[repositoryId] ?? null;
    }

    /**
     * Record a freshly-built snapshot for the repo and return the PREVIOUS
     * entry (if any) so the caller can delete the superseded image.
     */
    async record(
        orgAndTeam: OrganizationAndTeamData,
        repositoryId: string,
        entry: Omit<SnapshotEntry, 'createdAt'> & { createdAt?: string },
    ): Promise<SnapshotEntry | null> {
        const store = await this.load(orgAndTeam);
        const previous = store[repositoryId] ?? null;
        store[repositoryId] = {
            imageId: entry.imageId,
            key: entry.key,
            region: entry.region,
            createdAt: entry.createdAt ?? new Date().toISOString(),
        };
        await this.orgParams.createOrUpdateConfig(
            OrganizationParametersKey.ENVIRONMENT_SNAPSHOTS,
            store,
            orgAndTeam,
        );
        return previous;
    }
}
