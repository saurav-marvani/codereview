import * as crypto from 'crypto';
import { SelfHostedLicenseService } from '@libs/ee/license/self-hosted-license.service';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// --- Test keypair (matches the one embedded in the service) ---
const PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGpqMX6ekPw3vjzLlUKa0jM6V1IOLQfBHnZAyOfglbiZ
-----END PRIVATE KEY-----`;

function base64UrlEncode(buf: Buffer): string {
    return buf
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function makeJWT(payload: Record<string, any>): string {
    const header = { alg: 'EdDSA', typ: 'JWT' };
    const h = base64UrlEncode(Buffer.from(JSON.stringify(header)));
    const p = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
    const sig = crypto.sign(
        null,
        Buffer.from(`${h}.${p}`),
        crypto.createPrivateKey(PRIVATE_KEY_PEM),
    );
    return `${h}.${p}.${base64UrlEncode(sig)}`;
}

// --- Another keypair (to test invalid signature) ---
const OTHER_PRIVATE_KEY_PEM = (() => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return privateKey;
})();

function makeJWTWithWrongKey(payload: Record<string, any>): string {
    const header = { alg: 'EdDSA', typ: 'JWT' };
    const h = base64UrlEncode(Buffer.from(JSON.stringify(header)));
    const p = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
    const sig = crypto.sign(
        null,
        Buffer.from(`${h}.${p}`),
        crypto.createPrivateKey(OTHER_PRIVATE_KEY_PEM),
    );
    return `${h}.${p}.${base64UrlEncode(sig)}`;
}

// --- Mock org params service ---
function createMockOrgParamsService(returnValue: any = null) {
    return {
        findByKey: jest.fn().mockResolvedValue(returnValue),
        createOrUpdateConfig: jest.fn(),
        deleteByokConfig: jest.fn(),
    };
}

function createService(mockOrgParams: any) {
    return new SelfHostedLicenseService(mockOrgParams);
}

const now = Math.floor(Date.now() / 1000);

const validPayload = {
    iss: 'kodus.io',
    sub: 'test-org',
    iat: now,
    exp: now + 365 * 24 * 3600,
    plan: 'enterprise',
    seats: 50,
    features: ['all'],
    customer: 'Test Corp',
};

const expiredPayload = {
    iss: 'kodus.io',
    sub: 'test-org',
    iat: now - 7200,
    exp: now - 3600,
    plan: 'enterprise',
    seats: 10,
    features: ['all'],
    customer: 'Expired Corp',
};

describe('SelfHostedLicenseService', () => {
    const orgData = { organizationId: 'org-123' };

    afterEach(() => {
        delete process.env.KODUS_LICENSE_KEY;
    });

    describe('validateOrganizationLicense', () => {
        it('should return valid result for a valid JWT from DB', async () => {
            const token = makeJWT(validPayload);
            const mockParams = createMockOrgParamsService({
                configValue: { key: token },
            });
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(true);
            expect(result.subscriptionStatus).toBe(
                SubscriptionStatus.LICENSED_SELF_HOSTED,
            );
            expect(result.planType).toBe('enterprise');
            expect(result.numberOfLicenses).toBe(50);
        });

        it('should return valid result for a valid JWT from env var', async () => {
            const token = makeJWT(validPayload);
            process.env.KODUS_LICENSE_KEY = token;

            const mockParams = createMockOrgParamsService(null);
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(true);
            expect(result.subscriptionStatus).toBe(
                SubscriptionStatus.LICENSED_SELF_HOSTED,
            );
        });

        it('should prefer DB key over env var', async () => {
            const dbToken = makeJWT({
                ...validPayload,
                plan: 'enterprise-db',
            });
            const envToken = makeJWT({
                ...validPayload,
                plan: 'enterprise-env',
            });

            process.env.KODUS_LICENSE_KEY = envToken;

            const mockParams = createMockOrgParamsService({
                configValue: { key: dbToken },
            });
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(true);
            expect(result.planType).toBe('enterprise-db');
        });

        it('should fall back to env var when DB lookup fails', async () => {
            const token = makeJWT(validPayload);
            process.env.KODUS_LICENSE_KEY = token;

            const mockParams = createMockOrgParamsService(null);
            mockParams.findByKey.mockRejectedValue(new Error('DB error'));
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(true);
        });

        it('should return invalid for expired JWT', async () => {
            const token = makeJWT(expiredPayload);
            const mockParams = createMockOrgParamsService({
                configValue: { key: token },
            });
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(false);
            expect(result.subscriptionStatus).toBe(
                SubscriptionStatus.EXPIRED,
            );
        });

        it('should return invalid for JWT signed with wrong key', async () => {
            const token = makeJWTWithWrongKey(validPayload);
            const mockParams = createMockOrgParamsService({
                configValue: { key: token },
            });
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(false);
        });

        it('should return invalid for malformed JWT', async () => {
            const mockParams = createMockOrgParamsService({
                configValue: { key: 'not.a.valid.jwt.at.all' },
            });
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(false);
        });

        it('should return invalid when no key is available', async () => {
            const mockParams = createMockOrgParamsService(null);
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(false);
        });

        it('should cache results for 5 minutes', async () => {
            const token = makeJWT(validPayload);
            const mockParams = createMockOrgParamsService({
                configValue: { key: token },
            });
            const service = createService(mockParams);

            // First call
            await service.validateOrganizationLicense(orgData);
            // Second call (should use cache)
            await service.validateOrganizationLicense(orgData);

            expect(mockParams.findByKey).toHaveBeenCalledTimes(1);
        });

        it('should bypass cache after clearCache()', async () => {
            const token = makeJWT(validPayload);
            const mockParams = createMockOrgParamsService({
                configValue: { key: token },
            });
            const service = createService(mockParams);

            await service.validateOrganizationLicense(orgData);
            service.clearCache();
            await service.validateOrganizationLicense(orgData);

            expect(mockParams.findByKey).toHaveBeenCalledTimes(2);
        });

        it('should handle DB returning string configValue', async () => {
            const token = makeJWT(validPayload);
            const mockParams = createMockOrgParamsService({
                configValue: token,
            });
            const service = createService(mockParams);

            const result =
                await service.validateOrganizationLicense(orgData);

            expect(result.valid).toBe(true);
        });
    });

    describe('assignLicense', () => {
        it('should assign user when license is valid and seats available', async () => {
            const token = makeJWT(validPayload);
            const mockParams = createMockOrgParamsService(null);
            // First findByKey call returns license key, second returns no assigned users
            mockParams.findByKey
                .mockResolvedValueOnce({ configValue: { key: token } }) // getLicenseKey
                .mockResolvedValueOnce(null); // getAssignedUsers
            mockParams.createOrUpdateConfig = jest.fn().mockResolvedValue(true);
            const service = createService(mockParams);

            const result = await service.assignLicense(
                orgData,
                'user-1',
                'github',
            );
            expect(result).toBe(true);
            expect(mockParams.createOrUpdateConfig).toHaveBeenCalledWith(
                'license_assigned_users',
                { users: ['user-1'] },
                orgData,
            );
        });

        it('should return false when no valid license', async () => {
            const mockParams = createMockOrgParamsService(null);
            const service = createService(mockParams);

            const result = await service.assignLicense(
                orgData,
                'user-1',
                'github',
            );
            expect(result).toBe(false);
        });

        it('should return false when seat limit reached', async () => {
            const token = makeJWT({ ...validPayload, seats: 1 });
            const mockParams = createMockOrgParamsService(null);
            mockParams.findByKey
                .mockResolvedValueOnce({ configValue: { key: token } }) // getLicenseKey
                .mockResolvedValueOnce({ configValue: { users: ['existing-user'] } }); // getAssignedUsers
            const service = createService(mockParams);

            const result = await service.assignLicense(
                orgData,
                'new-user',
                'github',
            );
            expect(result).toBe(false);
        });
    });

    describe('unassignLicense', () => {
        it('should remove user from assigned list', async () => {
            const mockParams = createMockOrgParamsService(null);
            mockParams.findByKey.mockResolvedValueOnce({
                configValue: { users: ['user-1', 'user-2'] },
            });
            mockParams.createOrUpdateConfig = jest.fn().mockResolvedValue(true);
            const service = createService(mockParams);

            const result = await service.unassignLicense(orgData, 'user-1');
            expect(result).toBe(true);
            expect(mockParams.createOrUpdateConfig).toHaveBeenCalledWith(
                'license_assigned_users',
                { users: ['user-2'] },
                orgData,
            );
        });
    });

    describe('getAllUsersWithLicense', () => {
        it('should return assigned users from DB', async () => {
            const mockParams = createMockOrgParamsService({
                configValue: { users: ['user-1', 'user-2'] },
            });
            const service = createService(mockParams);

            const result = await service.getAllUsersWithLicense(orgData);
            expect(result).toEqual([
                { git_id: 'user-1' },
                { git_id: 'user-2' },
            ]);
        });

        it('should return empty when no assignments exist', async () => {
            const mockParams = createMockOrgParamsService(null);
            const service = createService(mockParams);

            const result = await service.getAllUsersWithLicense(orgData);
            expect(result).toEqual([]);
        });
    });

    describe('decodePayload', () => {
        it('should decode a valid JWT payload', () => {
            const token = makeJWT(validPayload);
            const mockParams = createMockOrgParamsService(null);
            const service = createService(mockParams);

            const payload = service.decodePayload(token);
            expect(payload).toBeTruthy();
            expect(payload!.plan).toBe('enterprise');
            expect(payload!.seats).toBe(50);
            expect(payload!.customer).toBe('Test Corp');
        });

        it('should return null for invalid signature', () => {
            const token = makeJWTWithWrongKey(validPayload);
            const mockParams = createMockOrgParamsService(null);
            const service = createService(mockParams);

            const payload = service.decodePayload(token);
            expect(payload).toBeNull();
        });
    });
});
