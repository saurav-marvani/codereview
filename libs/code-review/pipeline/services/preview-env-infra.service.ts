import { Inject, Injectable } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { encrypt, decrypt } from '@libs/common/utils/crypto';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

/** Alpha ships Hetzner only; the field exists so other clouds slot in without
 *  a data migration (the VmClient already takes token/region/size). */
export type PreviewEnvProvider = 'hetzner';

export interface PreviewEnvInfraConfig {
    provider: PreviewEnvProvider;
    region?: string;
    serverType?: string;
}

/** What the API returns — never the token, only whether one is set. */
export interface PreviewEnvInfraStatus extends PreviewEnvInfraConfig {
    tokenConfigured: boolean;
}

/** Decrypted, for the stage only (injection into the VM provisioner). */
export interface ResolvedPreviewEnvInfra extends PreviewEnvInfraConfig {
    token: string;
}

interface InfraStore extends PreviewEnvInfraConfig {
    token?: string; // encrypted at rest
}

/**
 * Org-level infrastructure config for the preview-env VM — the "which cloud"
 * knob self-hosted customers set from the UI (their VMs run in THEIR cloud
 * account; code never leaves their tenancy). Same encrypted-parameter pattern
 * as the secrets vault: the cloud token is encrypted at rest and never
 * returned by the API. Absent config → the stage falls back to the
 * server-level env token (how the cloud alpha is operated).
 */
@Injectable()
export class PreviewEnvInfraService {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly orgParams: IOrganizationParametersService,
    ) {}

    private async load(
        orgAndTeam: OrganizationAndTeamData,
    ): Promise<InfraStore | null> {
        const entity = await this.orgParams
            .findByKey(OrganizationParametersKey.ENVIRONMENT_INFRA, orgAndTeam)
            .catch(() => null);
        return (entity?.configValue as InfraStore) ?? null;
    }

    /**
     * Upsert the org's infra config. Token semantics mirror the secrets vault:
     * a present value is encrypted and stored, an empty string REMOVES it,
     * undefined keeps the existing one (so edits don't require re-entering it).
     */
    async setInfra(
        orgAndTeam: OrganizationAndTeamData,
        config: PreviewEnvInfraConfig & { token?: string },
    ): Promise<void> {
        const current = (await this.load(orgAndTeam)) ?? { provider: 'hetzner' };
        const next: InfraStore = {
            provider: config.provider ?? current.provider ?? 'hetzner',
            region: config.region ?? current.region,
            serverType: config.serverType ?? current.serverType,
            token: current.token,
        };
        if (config.token === '') delete next.token;
        else if (config.token != null) next.token = encrypt(config.token);

        await this.orgParams.createOrUpdateConfig(
            OrganizationParametersKey.ENVIRONMENT_INFRA,
            next,
            orgAndTeam,
        );
    }

    /** Provider/region/serverType + whether a token is set — never the token. */
    async getStatus(
        orgAndTeam: OrganizationAndTeamData,
    ): Promise<PreviewEnvInfraStatus | null> {
        const store = await this.load(orgAndTeam);
        if (!store) return null;
        const { token, ...rest } = store;
        return { ...rest, tokenConfigured: !!token };
    }

    /** Decrypted infra for the stage. Null when unset/un-decryptable → env fallback. */
    async resolveInfra(
        orgAndTeam: OrganizationAndTeamData,
    ): Promise<ResolvedPreviewEnvInfra | null> {
        const store = await this.load(orgAndTeam);
        if (!store?.token) return null;
        try {
            const { token, ...rest } = store;
            return { ...rest, token: decrypt(token) };
        } catch {
            return null; // e.g. crypto key rotated — fall back to env
        }
    }
}
