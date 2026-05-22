import { randomBytes } from 'crypto';

import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@kodus/flow';
import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { SignUpUseCase } from '@libs/identity/application/use-cases/auth/signup.use-case';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';

@Injectable()
export class SSOLoginUseCase implements IUseCase {
    private readonly logger = createLogger(SSOLoginUseCase.name);

    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly signUpUseCase: SignUpUseCase,
    ) {}

    async execute(profile: any, organizationId: string) {
        try {
            const { email, firstName, lastName } = profile;

            let user = await this.authService.validateUser({ email });

            if (!user) {
                user = await this.signUpUseCase.execute(
                    {
                        email,
                        name:
                            `${firstName || ''} ${lastName || ''}`.trim() ||
                            email,
                        password: randomBytes(32).toString('base64').slice(0, 32),
                        organizationId,
                    },
                    { preVerified: true },
                );
            }

            const { accessToken, refreshToken } = await this.authService.login(
                user,
                AuthProvider.SSO,
            );

            return {
                accessToken,
                refreshToken,
            };
        } catch (error) {
            this.logger.error({
                message: 'SSO login failed',
                error,
                context: SSOLoginUseCase.name,
                metadata: {
                    profile,
                    organizationId,
                },
                serviceName: SSOLoginUseCase.name,
            });
            throw error;
        }
    }
}
