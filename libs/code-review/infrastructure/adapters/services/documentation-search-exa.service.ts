import { createLogger } from '@kodus/flow';
import { DocumentationSearchCacheService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-cache.service';
import {
    DocumentationItem,
    DocumentationQueryPlanByFile,
} from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Exa from 'exa-js';

const CACHE_PROVIDER = 'exa';

@Injectable()
export class DocumentationSearchExaService {
    private readonly logger = createLogger(DocumentationSearchExaService.name);
    private readonly exaClient: Exa | null;
    private readonly inFlightRequests = new Map<
        string,
        Promise<DocumentationItem | null>
    >();

    constructor(
        private readonly configService: ConfigService,
        private readonly documentationSearchCacheService: DocumentationSearchCacheService,
    ) {
        const apiKey = this.configService.get<string>('API_EXA_KEY');
        this.exaClient = apiKey ? new Exa(apiKey) : null;
    }

    async searchByFilePlan(
        planByFile: Record<string, DocumentationQueryPlanByFile>,
    ): Promise<Record<string, DocumentationItem[]>> {
        if (!this.exaClient) {
            this.logger.warn({
                message:
                    'API_EXA_KEY is not configured, skipping documentation search stage',
                context: DocumentationSearchExaService.name,
            });

            return {};
        }

        const fileResults = await Promise.all(
            Object.entries(planByFile).map(async ([filePath, plan]) => {
                const docs = await this.searchForPlan(plan);
                return [filePath, docs] as const;
            }),
        );

        return Object.fromEntries(fileResults);
    }

    private async searchForPlan(
        plan: DocumentationQueryPlanByFile,
    ): Promise<DocumentationItem[]> {
        const queryTasks = this.buildQueryTasks(plan).slice(0, 5);

        if (!queryTasks.length || !this.exaClient) {
            return [];
        }

        const queryResults = await Promise.allSettled(
            queryTasks.map((task) => this.searchQuery(task)),
        );

        const items: DocumentationItem[] = [];

        for (const queryResult of queryResults) {
            if (queryResult.status === 'fulfilled' && queryResult.value) {
                items.push(queryResult.value);
            }
        }

        return this.deduplicateByQuery(items).slice(0, 20);
    }

    private async searchQuery(task: {
        query: string;
        packageName: string;
    }): Promise<DocumentationItem | null> {
        const queryNormalized = this.normalizeCacheSegment(task.query);
        const packageNameNormalized = this.normalizeCacheSegment(
            task.packageName,
        );
        const inFlightKey = this.buildInFlightKey(
            packageNameNormalized,
            queryNormalized,
        );

        const existingInFlight = this.inFlightRequests.get(inFlightKey);
        if (existingInFlight) {
            return existingInFlight;
        }

        const request = this.searchQueryWithCache(
            task,
            packageNameNormalized,
            queryNormalized,
        ).finally(() => {
            this.inFlightRequests.delete(inFlightKey);
        });

        this.inFlightRequests.set(inFlightKey, request);
        return request;
    }

    private async searchQueryWithCache(
        task: {
            query: string;
            packageName: string;
        },
        packageNameNormalized: string,
        queryNormalized: string,
    ): Promise<DocumentationItem | null> {
        if (!this.exaClient) {
            return null;
        }

        const cached = await this.documentationSearchCacheService.get({
            provider: CACHE_PROVIDER,
            packageNameNormalized,
            queryNormalized,
        });

        if (cached) {
            return cached;
        }

        try {
            const packageScopedQuery = this.buildPackageScopedQuery(
                task.packageName,
                task.query,
            );

            const response = await this.exaClient.answer(packageScopedQuery, {
                systemPrompt:
                    'Find relevant documentation from official sources. Focus on practical implementation guidance and API usage relevant to the query. Return concise markdown suitable for LLM prompt context.',
            });

            const item: DocumentationItem = {
                url: response.citations[0]?.url || 'unknown',
                title: `Documentation for ${task.packageName}`,
                source: 'exa-search',
                snippet: this.buildSnippet(
                    response.answer as string,
                    task.query,
                ),
                query: packageScopedQuery,
            };

            await this.documentationSearchCacheService.set({
                provider: CACHE_PROVIDER,
                packageNameNormalized,
                queryNormalized,
                documentationItem: item,
            });

            return item;
        } catch (error) {
            this.logger.warn({
                message: `Exa search failed for query: ${task.query}`,
                context: DocumentationSearchExaService.name,
                error,
            });

            return null;
        }
    }

    private buildQueryTasks(plan: DocumentationQueryPlanByFile): Array<{
        query: string;
        packageName: string;
    }> {
        const queries = (plan.queries || []).filter(Boolean);
        const packages = (plan.relevantPackages || [])
            .map((pkg) => (pkg || '').trim())
            .filter(Boolean);

        if (!queries.length) {
            return [];
        }

        // Guarantee that each query is scoped to one package.
        if (!packages.length) {
            return queries.map((query) => ({
                query,
                packageName: 'framework',
            }));
        }

        return queries.map((query, index) => ({
            query,
            packageName: packages[index % packages.length],
        }));
    }

    private buildPackageScopedQuery(
        packageName: string,
        query: string,
    ): string {
        return `Package: ${packageName}. Query: ${query}. Restrict results to this package's official documentation and APIs.`;
    }

    private buildSnippet(text: string | undefined, query: string): string {
        const sanitized = (text || '').replace(/\s+/g, ' ').trim();

        if (!sanitized) {
            return `No extract was returned by Exa for query: ${query}`;
        }

        return sanitized.slice(0, 320);
    }

    private deduplicateByQuery(
        items: DocumentationItem[],
    ): DocumentationItem[] {
        const byQuery = new Map<string, DocumentationItem>();

        for (const item of items) {
            if (!byQuery.has(item.query)) {
                byQuery.set(item.query, item);
            }
        }

        return [...byQuery.values()];
    }

    private buildInFlightKey(
        packageNameNormalized: string,
        queryNormalized: string,
    ): string {
        return `${CACHE_PROVIDER}:${packageNameNormalized}:${queryNormalized}`;
    }

    private normalizeCacheSegment(value: string): string {
        return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }
}
