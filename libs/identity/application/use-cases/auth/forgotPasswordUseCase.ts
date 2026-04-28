import { createLogger } from '@kodus/flow';
import {
    Inject,
    Injectable,
    InternalServerErrorException,
    NotFoundException,
} from '@nestjs/common';

import { EmailService } from '@libs/common/email/services/email.service';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';

@Injectable()
export class ForgotPasswordUseCase implements IUseCase {
    private readonly logger = createLogger(ForgotPasswordUseCase.name);
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        private readonly emailService: EmailService,
    ) {}

    async execute(email: string) {
        try {
            const user = await this.authService.validateUser({ email });
            if (!user) {
                throw new NotFoundException('User Not found.');
            }
            const token = await this.authService.createForgotPassToken(
                user.uuid,
                email,
            );
            await this.emailService.sendForgotPasswordEmail(
                user.email,
                user.organization.name,
                token,
                this.logger,
            );
            return { message: 'Reset link sent.' };
        } catch {
            throw new InternalServerErrorException(
                'Failed to send reset link.',
            );
        }
    }
}
