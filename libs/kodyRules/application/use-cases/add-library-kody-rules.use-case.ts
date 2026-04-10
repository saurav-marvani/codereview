import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IKodyRule,
    KodyRulesOrigin,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { AddLibraryKodyRulesDto } from '@libs/kodyRules/dtos/add-library-kody-rules.dto';
import { CreateKodyRuleDto } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';

@Injectable()
export class AddLibraryKodyRulesUseCase {
    private readonly logger = createLogger(AddLibraryKodyRulesUseCase.name);
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(libraryKodyRules: AddLibraryKodyRulesDto) {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            await this.authorizationService.ensure({
                user: this.request.user,
                action: Action.Create,
                resource: ResourceType.KodyRules,
                repoIds:
                    libraryKodyRules.repositoriesIds.length > 0
                        ? libraryKodyRules.repositoriesIds
                        : undefined,
            });

            const results: Partial<IKodyRule>[] = [];

            for await (const repoId of libraryKodyRules.repositoriesIds) {
                const kodyRule: CreateKodyRuleDto = {
                    title: libraryKodyRules.title,
                    rule: libraryKodyRules.rule,
                    path: libraryKodyRules.path,
                    severity: libraryKodyRules.severity,
                    severityLevel: libraryKodyRules.severityLevel,
                    repositoryId: repoId,
                    examples: libraryKodyRules.examples,
                    origin: KodyRulesOrigin.LIBRARY,
                    type: KodyRulesType.STANDARD,
                };

                const result =
                    await this.createOrUpdateKodyRulesUseCase.execute(
                        kodyRule,
                        this.request.user.organization.uuid,
                    );

                if (!result) {
                    throw new Error('Failed to add library Kody rule');
                }
                results.push(result);
            }

            // Processar diretórios se existirem
            if (
                libraryKodyRules?.directoriesInfo &&
                libraryKodyRules?.directoriesInfo?.length > 0
            ) {
                for await (const directoryInfo of libraryKodyRules.directoriesInfo) {
                    const kodyRule: CreateKodyRuleDto = {
                        title: libraryKodyRules.title,
                        rule: libraryKodyRules.rule,
                        path: libraryKodyRules.path,
                        severity: libraryKodyRules.severity,
                        severityLevel: libraryKodyRules.severityLevel,
                        repositoryId: directoryInfo.repositoryId,
                        directoryId: directoryInfo.directoryId,
                        examples: libraryKodyRules.examples,
                        origin: KodyRulesOrigin.LIBRARY,
                        type: KodyRulesType.STANDARD,
                    };

                    const result =
                        await this.createOrUpdateKodyRulesUseCase.execute(
                            kodyRule,
                            this.request.user.organization.uuid,
                        );

                    if (!result) {
                        throw new Error(
                            'Failed to add library Kody rule for directory',
                        );
                    }
                    results.push(result);
                }
            }

            return results;
        } catch (error) {
            this.logger.error({
                message: 'Could not add library Kody rules',
                context: AddLibraryKodyRulesUseCase.name,
                serviceName: 'AddLibraryKodyRulesUseCase',
                error: error,
                metadata: {
                    libraryKodyRules,
                    organizationAndTeamData: {
                        organizationId: this.request.user.organization.uuid,
                    },
                },
            });
            throw error;
        }
    }
}
