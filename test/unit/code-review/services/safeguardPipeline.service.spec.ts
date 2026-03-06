import { DocumentationSearchExaService } from '@/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { SafeguardPipelineService } from '@/code-review/infrastructure/adapters/services/safeguardPipeline.service';
import { ObservabilityService } from '@/core/log/observability.service';
import { PromptRunnerService } from '@kodus/kodus-common/llm';

describe('SafeguardPipelineService', () => {
    let service: SafeguardPipelineService;

    const mockPromptRunnerService = {} as PromptRunnerService;
    const mockObservabilityService = {} as ObservabilityService;

    const mockDocumentationSearchExaService = {
        searchByFilePlan: jest.fn(),
    } as unknown as DocumentationSearchExaService;

    beforeEach(() => {
        service = new SafeguardPipelineService(
            mockPromptRunnerService,
            mockObservabilityService,
            mockDocumentationSearchExaService,
        );

        jest.clearAllMocks();
    });

    describe('getDocumentationToolResult', () => {
        it('should return preloaded documentation context when available', async () => {
            const result = await (service as any).getDocumentationToolResult(
                'nestjs',
                'dependency injection tokens',
                [
                    {
                        title: 'NestJS Providers',
                        url: 'https://docs.nestjs.com/providers',
                        query: 'dependency injection tokens',
                        snippet: 'Use custom providers and tokens for DI.',
                        source: 'exa-search',
                    },
                ],
            );

            expect(result).toContain('Documentation (preloaded)');
            expect(result).toContain('NestJS Providers');
            expect(
                mockDocumentationSearchExaService.searchByFilePlan,
            ).not.toHaveBeenCalled();
        });

        it('should fallback to exa search when preloaded context is missing', async () => {
            mockDocumentationSearchExaService.searchByFilePlan = jest
                .fn()
                .mockResolvedValue({
                    safeguard: [
                        {
                            title: 'Mongoose Indexes',
                            url: 'https://mongoosejs.com/docs/guide.html#indexes',
                            query: 'ttl index expiresAt',
                            snippet: 'Define TTL indexes with expireAfterSeconds.',
                            source: 'exa-search',
                        },
                    ],
                });

            const result = await (service as any).getDocumentationToolResult(
                'mongoose',
                'ttl index expiresAt',
                [],
            );

            expect(result).toContain('Documentation:');
            expect(result).toContain('Mongoose Indexes');
            expect(
                mockDocumentationSearchExaService.searchByFilePlan,
            ).toHaveBeenCalledTimes(1);
        });

        it('should return validation message when query is empty', async () => {
            const result = await (service as any).getDocumentationToolResult(
                'nestjs',
                '   ',
                [],
            );

            expect(result).toContain('query is required');
            expect(
                mockDocumentationSearchExaService.searchByFilePlan,
            ).not.toHaveBeenCalled();
        });
    });
});
