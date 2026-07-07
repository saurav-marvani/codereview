import { BadRequestException } from '@nestjs/common';

import { TestByokModelUseCase } from './test-byok-model.use-case';

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => `dec:${v}`,
}));

function build(configValue: unknown) {
    const orgParams = {
        findByKey: jest.fn().mockResolvedValue(
            configValue ? { configValue } : null,
        ),
    } as any;
    const connectionUseCase = {
        execute: jest.fn().mockResolvedValue({ ok: true, code: 'ok', latencyMs: 5 }),
    } as any;
    return {
        useCase: new TestByokModelUseCase(orgParams, connectionUseCase),
        connectionUseCase,
    };
}

const org = { organizationId: 'org-1' };

describe('TestByokModelUseCase', () => {
    it('probes the model against the saved provider with decrypted credentials', async () => {
        const { useCase, connectionUseCase } = build({
            main: {
                provider: 'openai_compatible',
                apiKey: 'enc',
                baseURL: 'https://api.moonshot.ai/v1',
            },
        });

        const res = await useCase.execute({
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            organizationAndTeamData: org,
        });

        expect(res.ok).toBe(true);
        expect(connectionUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: 'openai_compatible',
                model: 'kimi-k2.7-code',
                apiKey: 'dec:enc',
                baseURL: 'https://api.moonshot.ai/v1',
            }),
        );
    });

    it('rejects when the org has no saved slot for the provider', async () => {
        const { useCase } = build(null);
        await expect(
            useCase.execute({
                provider: 'openai_compatible',
                model: 'x',
                organizationAndTeamData: org,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty model id', async () => {
        const { useCase } = build({ main: { provider: 'x', apiKey: 'e' } });
        await expect(
            useCase.execute({
                provider: 'x',
                model: '  ',
                organizationAndTeamData: org,
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
