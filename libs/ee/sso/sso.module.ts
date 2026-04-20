import { AuthModule } from '@libs/identity/modules/auth.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SSO_CONFIG_REPOSITORY_TOKEN } from './domain/contracts/ssoConfig.repository.contract';
import { SSO_CONFIG_SERVICE_TOKEN } from './domain/contracts/ssoConfig.service.contract';
import { SamlAuthGuard } from './guards/saml-auth.guard';
import { SSOConfigModel } from './repositories/ssoConfig.model';
import { SSOConfigRepository } from './repositories/ssoConfig.repository';
import { SSODomainVerificationService } from './services/sso-domain-verification.service';
import { SSOConfigService } from './services/ssoConfig.service';
import { SSOTestSessionService } from './services/sso-test-session.service';
import { SamlStrategy } from './strategies/saml-auth.strategy';
import { UseCases } from './use-cases';

@Module({
    imports: [TypeOrmModule.forFeature([SSOConfigModel]), AuthModule],
    providers: [
        SamlStrategy,
        SamlAuthGuard,
        SSOTestSessionService,
        SSODomainVerificationService,
        ...UseCases,
        {
            provide: SSO_CONFIG_REPOSITORY_TOKEN,
            useClass: SSOConfigRepository,
        },
        {
            provide: SSO_CONFIG_SERVICE_TOKEN,
            useClass: SSOConfigService,
        },
    ],
    exports: [
        ...UseCases,
        SSO_CONFIG_SERVICE_TOKEN,
        SSOTestSessionService,
        SSODomainVerificationService,
        SamlAuthGuard,
    ],
})
export class SSOModule {}
