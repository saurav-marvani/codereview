import axios from 'axios';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SimpleLogger } from '@kodus/flow/dist/observability/logger';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

type CustomerIoEmailPayload = {
    transactional_message_id: string | number;
    to: string;
    from?: string;
    subject?: string;
    message_data?: Record<string, unknown>;
    identifiers?: Record<string, string | number>;
};

const CUSTOMERIO_RULES_TRANSACTIONAL_ID = 14;
const CUSTOMERIO_FORGOT_PASSWORD_TRANSACTIONAL_ID = 11;
const CUSTOMERIO_CONFIRMATION_TRANSACTIONAL_ID = 12;
const CUSTOMERIO_INVITE_TRANSACTIONAL_ID = 13;
const CUSTOMERIO_DOMAIN_VERIFICATION_TRANSACTIONAL_ID = 12;

const DEFAULT_FROM_EMAIL = 'noreply@kodus.io';
const DEFAULT_FROM_NAME = 'Kody from Kodus';

@Injectable()
export class EmailService {
    constructor(private readonly configService: ConfigService) {}

    private getRequiredString(envKey: string): string {
        const value = this.configService.get<string>(envKey);
        if (!value) {
            throw new Error(`${envKey} is not set`);
        }
        return value;
    }

    private getCustomerIoApiToken(): string {
        return this.getRequiredString('API_CUSTOMERIO_APP_API_TOKEN');
    }

    private getCustomerIoBaseUrl(): string {
        return (
            this.configService.get<string>('API_CUSTOMERIO_BASE_URL') ||
            'https://api.customer.io'
        );
    }

    private getFromAddress(): string {
        const fromEmail = this.configService.get<string>(
            'API_CUSTOMERIO_FROM_EMAIL',
        );
        if (!fromEmail) {
            return `${DEFAULT_FROM_NAME} <${DEFAULT_FROM_EMAIL}>`;
        }
        const fromName = this.configService.get<string>(
            'API_CUSTOMERIO_FROM_NAME',
        );
        return fromName ? `${fromName} <${fromEmail}>` : fromEmail;
    }

    private applyFromAddress(
        payload: CustomerIoEmailPayload,
    ): CustomerIoEmailPayload {
        const fromAddress = this.getFromAddress();
        if (fromAddress) {
            payload.from = fromAddress;
        }

        return payload;
    }

    private buildIdentifiers(
        email: string,
    ): CustomerIoEmailPayload['identifiers'] {
        return { email };
    }

    private async sendCustomerIoEmail(
        payload: CustomerIoEmailPayload,
    ): Promise<unknown> {
        const apiToken = this.getCustomerIoApiToken();
        const baseUrl = this.getCustomerIoBaseUrl();

        const response = await axios.post(`${baseUrl}/v1/send/email`, payload, {
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
            },
        });

        return response.data;
    }

    async sendInvite(user, adminUserEmail, invite, logger?: SimpleLogger) {
        try {
            const transactionalMessageId = CUSTOMERIO_INVITE_TRANSACTIONAL_ID;

            const payload: CustomerIoEmailPayload = {
                transactional_message_id: transactionalMessageId,
                to: user.email,
                subject: `You've been invited to join ${user.teamMember[0].team.name}`,
                identifiers: this.buildIdentifiers(user.email),
                message_data: {
                    organizationName: user.organization.name,
                    invitingUser: {
                        email: adminUserEmail,
                    },
                    teamName: user.teamMember[0].team.name,
                    invitedUser: {
                        name: user.teamMember[0].name,
                        invite,
                    },
                },
            };

            return await this.sendCustomerIoEmail(
                this.applyFromAddress(payload),
            );
        } catch (error) {
            if (logger) {
                logger.error({
                    message: `Error in sendInvite for user ${user?.email}`,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: 'sendInvite',
                    metadata: {
                        userEmail: user?.email,
                        adminUserEmail,
                        organizationName: user?.organization?.name,
                    },
                });
            } else {
                console.log(error);
            }
        }
    }

    async sendForgotPasswordEmail(
        email: string,
        name: string,
        token: string,
        logger?: SimpleLogger,
    ) {
        try {
            const webUrl = this.getRequiredString('API_USER_INVITE_BASE_URL');

            const transactionalMessageId =
                CUSTOMERIO_FORGOT_PASSWORD_TRANSACTIONAL_ID;

            const payload: CustomerIoEmailPayload = {
                transactional_message_id: transactionalMessageId,
                to: email,
                subject: 'Reset your Kodus password',
                identifiers: this.buildIdentifiers(email),
                message_data: {
                    account: {
                        name: email,
                    },
                    resetLink: `${webUrl}/forgot-password/reset?token=${token}`,
                },
            };

            return await this.sendCustomerIoEmail(
                this.applyFromAddress(payload),
            );
        } catch (error) {
            if (logger) {
                logger.error({
                    message: `Error in sendForgotPasswordEmail for ${email}`,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: 'sendForgotPasswordEmail',
                    metadata: {
                        email,
                        name,
                    },
                });
            } else {
                console.error('sendForgotPasswordEmail error:', error);
            }
        }
    }

    async sendKodyRulesNotification(
        users: Array<{ email: string; name: string }>,
        rules: Array<string>,
        organizationName: string,
        logger?: SimpleLogger,
    ) {
        try {
            // Limitar regras para máximo 3 itens
            const limitedRules = rules.slice(0, 3);

            // Enviar email para cada usuário individualmente para personalização
            const emailPromises = users.map(async (user) => {
                const transactionalMessageId =
                    CUSTOMERIO_RULES_TRANSACTIONAL_ID;

                const payload: CustomerIoEmailPayload = {
                    transactional_message_id: transactionalMessageId,
                    to: user.email,
                    subject: `New Kody Rules Generated for ${organizationName}`,
                    identifiers: this.buildIdentifiers(user.email),
                    message_data: {
                        user: {
                            name: user.name,
                        },
                        organization: {
                            name: organizationName,
                        },
                        rules: limitedRules,
                        rulesCount: rules.length,
                    },
                };

                return await this.sendCustomerIoEmail(
                    this.applyFromAddress(payload),
                );
            });

            return await Promise.allSettled(emailPromises);
        } catch (error) {
            if (logger) {
                logger.error({
                    message: `Error in sendKodyRulesNotification for organization ${organizationName}`,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: 'sendKodyRulesNotification',
                    metadata: {
                        organizationName,
                        usersCount: users?.length || 0,
                        rulesCount: rules?.length || 0,
                    },
                });
            } else {
                console.error('sendKodyRulesNotification error:', error);
            }
            throw error;
        }
    }

    async sendConfirmationEmail(
        token: string,
        email: string,
        organizationName: string,
        organizationAndTeamData: OrganizationAndTeamData,
        logger?: SimpleLogger,
    ) {
        try {
            const webUrl = this.getRequiredString('API_USER_INVITE_BASE_URL');

            const transactionalMessageId =
                CUSTOMERIO_CONFIRMATION_TRANSACTIONAL_ID;

            const payload: CustomerIoEmailPayload = {
                transactional_message_id: transactionalMessageId,
                to: email,
                subject: 'Confirm your email',
                identifiers: this.buildIdentifiers(email),
                message_data: {
                    organizationName: organizationName,
                    confirmLink: `${webUrl}/confirm-email?token=${token}`,
                },
            };

            return await this.sendCustomerIoEmail(
                this.applyFromAddress(payload),
            );
        } catch (error) {
            if (logger) {
                logger.error({
                    message: `Error in sendConfirmationEmail for user ${email}`,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: 'sendConfirmationEmail',
                    metadata: {
                        email,
                        organizationName,
                        organizationAndTeamData,
                    },
                });
            }
        }
    }

    async sendDomainVerificationEmail(
        token: string,
        email: string,
        organizationName: string,
        domain: string,
        logger?: SimpleLogger,
    ) {
        try {
            const webUrl = this.getRequiredString('API_USER_INVITE_BASE_URL');

            const payload: CustomerIoEmailPayload = {
                transactional_message_id:
                    CUSTOMERIO_DOMAIN_VERIFICATION_TRANSACTIONAL_ID,
                to: email,
                subject: `Verify ${domain} for SSO`,
                identifiers: this.buildIdentifiers(email),
                message_data: {
                    organizationName,
                    domain,
                    confirmLink: `${webUrl}/organization/sso?domainVerificationToken=${token}`,
                },
            };

            return await this.sendCustomerIoEmail(
                this.applyFromAddress(payload),
            );
        } catch (error) {
            if (logger) {
                logger.error({
                    message: `Error in sendDomainVerificationEmail for ${email}`,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    context: 'sendDomainVerificationEmail',
                    metadata: {
                        email,
                        organizationName,
                        domain,
                    },
                });
            }
        }
    }
}

let emailServiceInstance: EmailService | null = null;

function getEmailServiceInstance(): EmailService {
    if (!emailServiceInstance) {
        const { ConfigService } = require('@nestjs/config');
        emailServiceInstance = new EmailService(new ConfigService());
    }
    return emailServiceInstance;
}

export async function sendInvite(user, adminUserEmail, invite, logger?) {
    const emailService = getEmailServiceInstance();
    return emailService.sendInvite(user, adminUserEmail, invite, logger);
}

export async function sendForgotPasswordEmail(
    email: string,
    name: string,
    token: string,
    logger?,
) {
    const emailService = getEmailServiceInstance();
    return emailService.sendForgotPasswordEmail(email, name, token, logger);
}

export async function sendKodyRulesNotification(
    users: Array<{ email: string; name: string }>,
    rules: Array<string>,
    organizationName: string,
    logger?,
) {
    const emailService = getEmailServiceInstance();
    return emailService.sendKodyRulesNotification(
        users,
        rules,
        organizationName,
        logger,
    );
}

export async function sendConfirmationEmail(
    token: string,
    email: string,
    organizationName: string,
    organizationAndTeamData: OrganizationAndTeamData,
    logger?,
) {
    const emailService = getEmailServiceInstance();
    return emailService.sendConfirmationEmail(
        token,
        email,
        organizationName,
        organizationAndTeamData,
        logger,
    );
}

export async function sendDomainVerificationEmail(
    token: string,
    email: string,
    organizationName: string,
    domain: string,
    logger?,
) {
    const emailService = getEmailServiceInstance();
    return emailService.sendDomainVerificationEmail(
        token,
        email,
        organizationName,
        domain,
        logger,
    );
}
