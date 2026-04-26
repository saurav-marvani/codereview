import { createLogger } from '@kodus/flow';
import {
    Inject,
    Injectable,
    UnauthorizedException,
    InternalServerErrorException,
} from '@nestjs/common';

import { EmailService } from '@libs/common/email/services/email.service';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';

@Injectable()
export class ResendEmailUseCase implements IUseCase {
    private readonly logger = createLogger(ResendEmailUseCase.name);
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        private readonly emailService: EmailService,
    ) {}

    async execute(email: string): Promise<{ message: string }> {
        try {
            const user = await this.usersService.findOne({
                email,
            });

            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            const token = await this.authService.createEmailToken(
                user.uuid,
                user.email,
            );

            await this.emailService.sendConfirmationEmail(
                token,
                user.email,
                user.organization.name,
                {
                    organizationId: user.organization.uuid,
                },
            );

            return { message: 'Email sent successfully' };
        } catch (error) {
            this.logger.error({
                message: 'Something went wrong while confirming email',
                context: ResendEmailUseCase.name,
                error,
            });
            throw new InternalServerErrorException(
                'Something went wrong while resending email',
            );
        }
    }
}
