import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { MultiSamlStrategy } from '@node-saml/passport-saml';

import {
    SSOConnectionTestSessionStatus,
    SSOProtocol,
    SSOProtocolConfigMap,
} from '@libs/ee/sso/domain/interfaces/ssoConfig.interface';
import {
    ISSOConfigService,
    SSO_CONFIG_SERVICE_TOKEN,
} from '../domain/contracts/ssoConfig.service.contract';
import { SSOTestSessionService } from '../services/sso-test-session.service';

@Injectable()
export class SamlStrategy extends PassportStrategy(MultiSamlStrategy, 'saml') {
    constructor(
        @Inject(SSO_CONFIG_SERVICE_TOKEN)
        private readonly ssoConfigService: ISSOConfigService,
        private readonly ssoTestSessionService: SSOTestSessionService,
    ) {
        super(
            {
                passReqToCallback: true,
                getSamlOptions: async (req, done) => {
                    try {
                        const organizationId = req?.params
                            ?.organizationId as string;
                        const relayState =
                            req?.body?.RelayState || req?.query?.RelayState;

                        if (!organizationId) {
                            return done(
                                new Error('No Organization ID provided'),
                            );
                        }

                        if (relayState) {
                            const testSession =
                                await this.ssoTestSessionService.getSession(
                                    relayState,
                                );

                            if (
                                testSession &&
                                testSession.organizationId === organizationId &&
                                testSession.protocol === SSOProtocol.SAML &&
                                testSession.status ===
                                    SSOConnectionTestSessionStatus.PENDING
                            ) {
                                const samlConfig =
                                    testSession.providerConfig as SSOProtocolConfigMap[SSOProtocol.SAML];

                                return done(null, {
                                    entryPoint: samlConfig.entryPoint,
                                    idpCert: samlConfig.cert,
                                    idpIssuer: samlConfig.idpIssuer,
                                    issuer:
                                        samlConfig.issuer ||
                                        'kodus-orchestrator',
                                    callbackUrl: `${process.env.API_URL}/auth/sso/saml/callback/${organizationId}`,
                                    wantAssertionsSigned: false,
                                    identifierFormat:
                                        samlConfig.identifierFormat || null,
                                    signatureAlgorithm: 'sha256',
                                });
                            }
                        }

                        const ssoConfig = await this.ssoConfigService.findOne({
                            protocol: SSOProtocol.SAML,
                            organization: {
                                uuid: organizationId,
                            },
                        });

                        if (!ssoConfig) {
                            return done(new Error('SSO config not found'));
                        }

                        return done(null, {
                            entryPoint: ssoConfig.providerConfig.entryPoint,
                            idpCert: ssoConfig.providerConfig.cert,
                            idpIssuer: ssoConfig.providerConfig.idpIssuer,
                            issuer:
                                ssoConfig.providerConfig.issuer ||
                                'kodus-orchestrator',
                            callbackUrl: `${process.env.API_URL}/auth/sso/saml/callback/${organizationId}`,
                            wantAssertionsSigned: false,
                            identifierFormat:
                                ssoConfig.providerConfig.identifierFormat ||
                                null,
                            signatureAlgorithm: 'sha256',
                        });
                    } catch (error) {
                        return done(error, null);
                    }
                },
            },
            (
                req: any,
                profile: any,
                done: (err: Error | null, user?: any) => void,
            ) =>
                this.validate(req, profile).then(
                    (user) => done(null, user),
                    (err) => done(err),
                ),
        );
    }

    async validate(req: Request, profile: any) {
        const email: string = profile.email || profile.nameId || profile.nameID;

        if (
            !email ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).toLowerCase())
        ) {
            throw new UnauthorizedException('Invalid email in SAML assertion');
        }

        return {
            email,
            firstName: profile.firstName || '',
            lastName: profile.lastName || '',
            organizationId: req.params.organizationId,
        };
    }
}
