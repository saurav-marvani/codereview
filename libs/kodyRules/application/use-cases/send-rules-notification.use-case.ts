import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { EmailService } from '@libs/common/email/services/email.service';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

@Injectable()
export class SendRulesNotificationUseCase {
    private readonly logger = createLogger(SendRulesNotificationUseCase.name);
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        private readonly emailService: EmailService,
    ) {}

    async execute(organizationId: string, rules: string[]): Promise<void> {
        try {
            this.logger.log({
                message: 'Starting Kody Rules notification process',
                context: SendRulesNotificationUseCase.name,
                metadata: {
                    organizationId,
                    rulesCount: rules.length,
                },
            });

            // Validar se há regras para notificar
            if (!rules || rules.length === 0) {
                this.logger.log({
                    message: 'No rules to notify',
                    context: SendRulesNotificationUseCase.name,
                    metadata: { organizationId },
                });
                return;
            }

            // Buscar usuários ativos da organização
            const users = await this.usersService.find(
                {
                    organization: { uuid: organizationId },
                },
                [STATUS.ACTIVE],
            );

            if (!users || users.length === 0) {
                this.logger.log({
                    message: 'No active users found in organization',
                    context: SendRulesNotificationUseCase.name,
                    metadata: { organizationId },
                });
                return;
            }

            // Buscar dados da organização
            const organization = await this.organizationService.findOne({
                uuid: organizationId,
            });

            if (!organization) {
                this.logger.error({
                    message: 'Organization not found',
                    context: SendRulesNotificationUseCase.name,
                    metadata: { organizationId },
                });
                return;
            }

            // Formatar dados dos usuários para o email
            const emailUsers = users.map((user) => ({
                email: user.email,
                name: this.extractUserName(user),
            }));

            // Formatar dados das regras para o template
            const emailRules = rules.map((rule) => rule);

            this.logger.log({
                message: 'Sending email notifications',
                context: SendRulesNotificationUseCase.name,
                metadata: {
                    organizationId,
                    usersCount: emailUsers.length,
                    rulesCount: emailRules.length,
                    organizationName: organization.name,
                },
            });

            // Enviar emails
            const emailResults = await this.emailService.sendKodyRulesNotification(
                emailUsers,
                emailRules,
                organization.name,
                this.logger,
            );

            // Log dos resultados
            const successCount = emailResults.filter(
                (result) => result.status === 'fulfilled',
            ).length;
            const failureCount = emailResults.filter(
                (result) => result.status === 'rejected',
            ).length;

            this.logger.log({
                message: 'Email notifications completed',
                context: SendRulesNotificationUseCase.name,
                metadata: {
                    organizationId,
                    totalEmails: emailResults.length,
                    successCount,
                    failureCount,
                },
            });

            // Log detalhado dos erros, se houver
            if (failureCount > 0) {
                const failures = emailResults
                    .filter((result) => result.status === 'rejected')
                    .map((result, index) => ({
                        userIndex: index,
                        reason: (result as PromiseRejectedResult).reason,
                    }));

                this.logger.error({
                    message: 'Some email notifications failed',
                    context: SendRulesNotificationUseCase.name,
                    metadata: {
                        organizationId,
                        failures,
                    },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error in Kody Rules notification process',
                context: SendRulesNotificationUseCase.name,
                error,
                metadata: {
                    organizationId,
                    rulesCount: rules?.length || 0,
                },
            });
            // Não propagar o erro para não interromper o processo principal
        }
    }

    private extractUserName(user: any): string {
        // Tentar extrair o nome do usuário de diferentes fontes
        if (user.teamMember && user.teamMember.length > 0) {
            return user.teamMember[0].name || user.email.split('@')[0];
        }
        return user.email.split('@')[0];
    }
}
