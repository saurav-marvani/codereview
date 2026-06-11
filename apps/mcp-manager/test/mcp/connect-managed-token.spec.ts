import { BadRequestException } from '@nestjs/common';

jest.mock('@kodus/flow', () => ({
    createMCPAdapter: jest.fn(),
}));

jest.mock('../../src/clients/composio', () => ({
    ComposioClient: jest.fn().mockImplementation(() => ({})),
}));

import { McpService } from '../../src/modules/mcp/mcp.service';
import { MCPConnectionStatus } from '../../src/modules/mcp/entities/mcp-connection.entity';
import { MCPIntegrationAuthType } from '../../src/modules/integrations/enums/integration.enum';

const INT = 'atlassian-rovo-default';
const ORG = 'org-1';

const authMethods = [
    {
        id: 'oauth',
        type: MCPIntegrationAuthType.OAUTH2,
        dynamicRegistration: true,
        default: true,
    },
    {
        id: 'token',
        type: MCPIntegrationAuthType.BASIC,
        userFields: [
            { name: 'email', required: true },
            { name: 'apiToken', required: true, secret: true },
            { name: 'cloudId', required: true },
        ],
    },
];

function buildService() {
    const kodusProvider = {
        getAuthMethods: jest.fn().mockReturnValue(authMethods),
        getManagedConfig: jest.fn().mockReturnValue({
            id: INT,
            name: 'Atlassian Rovo',
            baseUrl: 'https://mcp.atlassian.com/v1/mcp',
            protocol: 'http',
            logoUrl: '',
        }),
    };
    const providerFactory = {
        getProvider: jest.fn().mockReturnValue(kodusProvider),
    };
    const connectionRepository = {
        findOne: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockImplementation((e) => Promise.resolve(e)),
    };
    const integrationOAuthService = {
        saveTokenCredential: jest.fn().mockResolvedValue(undefined),
    };

    const service = new McpService(
        providerFactory as any,
        connectionRepository as any,
        {} as any,
        {} as any,
        integrationOAuthService as any,
    );

    return { service, connectionRepository, integrationOAuthService };
}

describe('McpService.connectManagedToken', () => {
    it('stores the credential and creates an ACTIVE connection for a valid submission', async () => {
        const { service, connectionRepository, integrationOAuthService } =
            buildService();

        const result = await service.connectManagedToken(ORG, INT, {
            authMethod: 'token',
            secret: 'api-token',
            fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
        });

        expect(integrationOAuthService.saveTokenCredential).toHaveBeenCalledWith(
            ORG,
            INT,
            {
                authMethodId: 'token',
                authType: MCPIntegrationAuthType.BASIC,
                secret: 'api-token',
                fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
            },
        );

        expect(connectionRepository.save).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            integrationId: INT,
            organizationId: ORG,
            provider: 'kodusmcp',
            status: MCPConnectionStatus.ACTIVE,
            mcpUrl: 'https://mcp.atlassian.com/v1/mcp',
            appName: 'Atlassian Rovo',
            metadata: { authMethod: 'token' },
        });
    });

    it('rejects an invalid submission without storing anything', async () => {
        const { service, connectionRepository, integrationOAuthService } =
            buildService();

        await expect(
            service.connectManagedToken(ORG, INT, {
                authMethod: 'token',
                secret: 'api-token',
                fields: { email: 'dev@kodus.io' }, // missing cloudId
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(integrationOAuthService.saveTokenCredential).not.toHaveBeenCalled();
        expect(connectionRepository.save).not.toHaveBeenCalled();
    });

    it('rejects an unknown auth method', async () => {
        const { service } = buildService();

        await expect(
            service.connectManagedToken(ORG, INT, {
                authMethod: 'nope',
                secret: 'x',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
