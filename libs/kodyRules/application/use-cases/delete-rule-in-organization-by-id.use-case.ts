import { createLogger } from '@kodus/flow';
import { Injectable, Inject, Optional } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    KODY_RULES_SERVICE_TOKEN,
    IKodyRulesService,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';

@Injectable()
export class DeleteRuleInOrganizationByIdKodyRulesUseCase {
    private readonly logger = createLogger(
        DeleteRuleInOrganizationByIdKodyRulesUseCase.name,
    );
    constructor(
        @Optional()
        @Inject(REQUEST)
        private readonly request: UserRequest,

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    async execute(
        ruleId: string,
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            userId?: string;
            userEmail?: string;
        },
    ) {
        try {
            return await this.kodyRulesService.deleteRuleWithLogging(
                {
                    organizationId:
                        actor?.organizationId ||
                        this.request.user.organization.uuid,
                },
                ruleId,
                {
                    userId: actor?.userId || this.request.user.uuid,
                    userEmail: actor?.userEmail || this.request.user.email,
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error deleting Kody Rule in organization by ID',
                context: DeleteRuleInOrganizationByIdKodyRulesUseCase.name,
                error: error,
                metadata: {
                    organizationId:
                        actor?.organizationId ||
                        this.request.user.organization.uuid,
                    ruleId,
                },
            });
            throw error;
        }
    }
}
