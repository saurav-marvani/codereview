import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { resolveByokSlot } from './byok-credentials.util';
import {
    TestByokConnectionUseCase,
    TestByokResult,
} from './test-byok-connection.use-case';

export interface TestByokModelInput {
    provider: string;
    model: string;
    organizationAndTeamData: OrganizationAndTeamData;
}

/**
 * Validate a specific model id against the org's ACTUAL saved BYOK provider —
 * the truthful "will this model work?" check the static model catalog can't give
 * (the catalog is best-effort and, for openai_compatible, points at the wrong
 * endpoint). Resolves the stored credentials server-side and delegates to the
 * connection probe. The client sends only {provider, model}; the apiKey never
 * leaves the server.
 */
@Injectable()
export class TestByokModelUseCase {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly testByokConnectionUseCase: TestByokConnectionUseCase,
    ) {}

    async execute(input: TestByokModelInput): Promise<TestByokResult> {
        if (!input.model?.trim()) {
            throw new BadRequestException('model is required');
        }

        const slot = await resolveByokSlot(
            this.organizationParametersService,
            input.provider,
            input.organizationAndTeamData,
        );
        if (!slot) {
            throw new BadRequestException(
                `No saved BYOK credentials found for provider "${input.provider}". Configure it in BYOK settings first.`,
            );
        }

        return this.testByokConnectionUseCase.execute({
            provider: input.provider,
            model: input.model,
            apiKey: slot.apiKey,
            baseURL: slot.baseURL,
            vertexLocation: slot.vertexLocation,
            awsBearerToken: slot.awsBearerToken,
            awsAccessKeyId: slot.awsAccessKeyId,
            awsSecretAccessKey: slot.awsSecretAccessKey,
            awsRegion: slot.awsRegion,
            awsSessionToken: slot.awsSessionToken,
        });
    }
}
