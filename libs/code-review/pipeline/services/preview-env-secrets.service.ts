import { Inject, Injectable } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { encrypt, decrypt } from '@libs/common/utils/crypto';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

type SecretsStore = Record<string, Record<string, string>>; // repoId -> { NAME: encrypted }

/**
 * Encrypted per-repo secrets vault for the preview-env app `.env` — reuses the
 * BYOK pattern (OrganizationParameters + crypto.encrypt). Values are encrypted
 * at rest and NEVER returned by the API (only `getStatus` names). The stage
 * calls `resolveSecrets` to decrypt + inject them into the VM.
 */
@Injectable()
export class PreviewEnvSecretsService {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly orgParams: IOrganizationParametersService,
    ) {}

    private async load(orgAndTeam: OrganizationAndTeamData): Promise<SecretsStore> {
        const entity = await this.orgParams
            .findByKey(OrganizationParametersKey.ENVIRONMENT_SECRETS, orgAndTeam)
            .catch(() => null);
        return (entity?.configValue as SecretsStore) ?? {};
    }

    /**
     * Merge-update the repo's secrets: a present value is encrypted and stored;
     * an empty-string value REMOVES the key; keys not passed are kept as-is
     * (so partial edits don't require re-entering every secret).
     */
    async setSecrets(
        orgAndTeam: OrganizationAndTeamData,
        repositoryId: string,
        secrets: Record<string, string>,
    ): Promise<void> {
        const store = await this.load(orgAndTeam);
        const repoMap: Record<string, string> = { ...(store[repositoryId] ?? {}) };
        for (const [name, value] of Object.entries(secrets ?? {})) {
            if (value === '' || value == null) delete repoMap[name];
            else repoMap[name] = encrypt(value);
        }
        store[repositoryId] = repoMap;
        await this.orgParams.createOrUpdateConfig(
            OrganizationParametersKey.ENVIRONMENT_SECRETS,
            store,
            orgAndTeam,
        );
    }

    /** Which secret NAMES are set for a repo — never the values. */
    async getStatus(
        orgAndTeam: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<string[]> {
        const store = await this.load(orgAndTeam);
        return Object.keys(store[repositoryId] ?? {});
    }

    /** Decrypt the repo's secrets for injection into the VM (optionally filtered to requiredEnv). */
    async resolveSecrets(
        orgAndTeam: OrganizationAndTeamData,
        repositoryId: string,
        requiredEnv?: string[],
    ): Promise<Record<string, string>> {
        const store = await this.load(orgAndTeam);
        const repoMap = store[repositoryId] ?? {};
        const out: Record<string, string> = {};
        for (const [name, enc] of Object.entries(repoMap)) {
            if (requiredEnv?.length && !requiredEnv.includes(name)) continue;
            try {
                out[name] = decrypt(enc);
            } catch {
                /* skip un-decryptable (e.g. key rotated) */
            }
        }
        return out;
    }
}
