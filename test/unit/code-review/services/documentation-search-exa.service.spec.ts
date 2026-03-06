import { DocumentationSearchCacheService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-cache.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ConfigService } from '@nestjs/config';

const exaAnswerMock = jest.fn();

jest.mock('exa-js', () => {
    return jest.fn().mockImplementation(() => ({
        answer: exaAnswerMock,
    }));
});

describe('DocumentationSearchExaService', () => {
    function buildCacheServiceMock(params?: { cachedItem?: any }) {
        return {
            get: jest.fn().mockResolvedValue(params?.cachedItem || null),
            set: jest.fn().mockResolvedValue(undefined),
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should skip search when API key is missing', async () => {
        const configService = {
            get: jest.fn().mockReturnValue(undefined),
        } as unknown as ConfigService;

        const cacheService = buildCacheServiceMock();
        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
        );

        const result = await service.searchByFilePlan({
            'src/a.ts': {
                relevantPackages: ['react'],
                queries: ['hooks'],
            },
        });

        expect(result).toEqual({});
        expect(exaAnswerMock).not.toHaveBeenCalled();
    });

    it('should return documentation from Exa and persist in cache', async () => {
        const configService = {
            get: jest.fn((key: string) =>
                key === 'API_EXA_KEY' ? 'exa_test_key' : undefined,
            ),
        } as unknown as ConfigService;

        exaAnswerMock.mockResolvedValue({
            answer: 'Use official docs and controller decorators.',
            citations: [{ url: 'https://docs.nestjs.com/controllers' }],
        });

        const cacheService = buildCacheServiceMock();
        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
        );

        const result = await service.searchByFilePlan({
            'src/a.ts': {
                relevantPackages: ['@nestjs/common'],
                queries: ['nestjs controllers'],
            },
        });

        expect(exaAnswerMock).toHaveBeenCalledTimes(1);
        expect(result['src/a.ts']).toHaveLength(1);
        expect(result['src/a.ts'][0]).toEqual(
            expect.objectContaining({
                source: 'exa-search',
                url: 'https://docs.nestjs.com/controllers',
            }),
        );
        expect(cacheService.set).toHaveBeenCalledTimes(1);
    });

    it('should return cached docs and avoid Exa calls', async () => {
        const configService = {
            get: jest.fn((key: string) =>
                key === 'API_EXA_KEY' ? 'exa_test_key' : undefined,
            ),
        } as unknown as ConfigService;

        const cacheService = buildCacheServiceMock({
            cachedItem: {
                query: 'Package: @nestjs/common. Query: nestjs controllers',
                title: 'Documentation for @nestjs/common',
                url: 'https://docs.nestjs.com/controllers',
                snippet: 'cached snippet',
                source: 'exa-search',
            },
        });

        const service = new DocumentationSearchExaService(
            configService,
            cacheService as unknown as DocumentationSearchCacheService,
        );

        const result = await service.searchByFilePlan({
            'src/a.ts': {
                relevantPackages: ['@nestjs/common'],
                queries: ['nestjs controllers'],
            },
        });

        expect(result['src/a.ts']).toHaveLength(1);
        expect(result['src/a.ts'][0].snippet).toBe('cached snippet');
        expect(exaAnswerMock).not.toHaveBeenCalled();
    });
});
