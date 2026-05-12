import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import pLimit from 'p-limit';

import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IPullRequestManagerService } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CacheService } from '@libs/core/cache/cache.service';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { PullRequestAuthor } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

@Injectable()
export class PullRequestHandlerService implements IPullRequestManagerService {
    private readonly logger = createLogger(PullRequestHandlerService.name);

    /** Limite de concorrência para requisições de conteúdo de arquivos à API do GitHub */
    private readonly FILE_CONTENT_CONCURRENCY = 100;

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly cacheService: CacheService,
    ) {}

    async getPullRequestDetails(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        prNumber: number,
    ): Promise<any> {
        try {
            return await this.codeManagementService.getPullRequest({
                organizationAndTeamData,
                repository,
                prNumber,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull request details',
                context: PullRequestHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    prNumber,
                },
            });
            throw error;
        }
    }

    async getChangedFiles(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        ignorePaths?: string[],
        lastCommit?: string,
    ): Promise<FileChange[]> {
        try {
            let changedFiles: FileChange[];

            if (lastCommit) {
                // Retrieve files changed since the last commit
                changedFiles =
                    await this.codeManagementService.getChangedFilesSinceLastCommit(
                        {
                            organizationAndTeamData,
                            repository,
                            prNumber: pullRequest?.number,
                            lastCommit,
                        },
                    );
            } else {
                // Retrieve all files changed in the pull request
                changedFiles =
                    await this.codeManagementService.getFilesByPullRequestId({
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                    });
            }

            // Filter files based on ignorePaths and retrieve their content
            const filteredFiles = changedFiles?.filter((file) => {
                return !isFileMatchingGlob(file.filename, ignorePaths);
            });

            if (!filteredFiles?.length) {
                this.logger.warn({
                    message: `No files to review after filtering PR#${pullRequest?.number}`,
                    context: PullRequestHandlerService.name,
                    metadata: {
                        repository,
                        prNumber: pullRequest?.number,
                        ignorePaths,
                        changedFilePaths:
                            changedFiles?.map((file) => file.filename) || [],
                    },
                });
            }

            // Retrieve the content of the filtered files with concurrency limit
            if (filteredFiles && filteredFiles.length > 0) {
                const limit = pLimit(this.FILE_CONTENT_CONCURRENCY);

                const filesWithContent = await Promise.all(
                    filteredFiles.map((file) =>
                        limit(async () => {
                            try {
                                const fileContent =
                                    await this.codeManagementService.getRepositoryContentFile(
                                        {
                                            organizationAndTeamData,
                                            repository,
                                            file,
                                            pullRequest,
                                        },
                                    );

                                // If the content exists and is in base64, decode it
                                const content = fileContent?.data?.content;
                                let decodedContent = content;

                                if (
                                    content &&
                                    fileContent?.data?.encoding === 'base64'
                                ) {
                                    decodedContent = Buffer.from(
                                        content,
                                        'base64',
                                    ).toString('utf-8');
                                }

                                return {
                                    ...file,
                                    fileContent: decodedContent,
                                };
                            } catch (error) {
                                this.logger.error({
                                    message: `Error fetching content for file: ${file.filename}`,
                                    context: PullRequestHandlerService.name,
                                    error,
                                    metadata: {
                                        organizationAndTeamData,
                                        repository,
                                        prNumber: pullRequest?.number,
                                        filename: file.filename,
                                    },
                                });
                                return file;
                            }
                        }),
                    ),
                );

                return filesWithContent;
            }

            return filteredFiles || [];
        } catch (error) {
            this.logger.error({
                message: 'Error fetching changed files',
                context: PullRequestHandlerService.name,
                error,
                metadata: { ...pullRequest, repository },
            });
            throw error;
        }
    }

    async getPullRequestAuthorsWithCache(
        organizationAndTeamData: OrganizationAndTeamData,
        determineBots?: boolean,
    ): Promise<PullRequestAuthor[]> {
        const baseKey = organizationAndTeamData.teamId
            ? `pr_authors_60d_${organizationAndTeamData.organizationId}_${organizationAndTeamData.teamId}`
            : `pr_authors_60d_${organizationAndTeamData.organizationId}`;
        const cacheKey = determineBots ? `${baseKey}_bots` : baseKey;
        const TTL = 10 * 60 * 1000; // 10 minutos

        try {
            const cachedAuthors =
                await this.cacheService.getFromCache<PullRequestAuthor[]>(
                    cacheKey,
                );

            if (cachedAuthors?.length > 0) {
                return cachedAuthors;
            }

            const authors =
                await this.codeManagementService.getPullRequestAuthors({
                    organizationAndTeamData,
                    determineBots,
                });

            await this.cacheService.addToCache(cacheKey, authors, TTL);

            return authors;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching pull request authors',
                context: PullRequestHandlerService.name,
                error,
                metadata: { organizationAndTeamData },
            });
            throw error;
        }
    }

    async getNewCommitsSinceLastExecution(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        lastCommit?: any,
    ): Promise<Commit[]> {
        try {
            const commits =
                (await this.codeManagementService.getCommitsForPullRequestForCodeReview(
                    {
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                    },
                )) as Commit[];

            if (!commits || commits.length === 0) {
                this.logger.warn({
                    message: `No commits found for PR#${pullRequest?.number}`,
                    context: PullRequestHandlerService.name,
                    metadata: {
                        organizationAndTeamData,
                        repository,
                        pullRequestNumber: pullRequest?.number,
                    },
                });
                return [];
            }

            if (lastCommit && lastCommit.sha) {
                const lastCommitIndex = commits.findIndex(
                    (commit) => commit.sha === lastCommit.sha,
                );

                if (lastCommitIndex !== -1) {
                    return commits.slice(lastCommitIndex + 1);
                }
            }

            return commits;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching new commits since last execution',
                context: PullRequestHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    repository,
                    pullRequestNumber: pullRequest?.number,
                    lastCommit,
                },
            });

            throw error;
        }
    }

    /**
     * Busca apenas metadados dos arquivos alterados (sem conteúdo).
     * Mais rápido que getChangedFiles pois não faz chamadas repos.getContent.
     */
    async getChangedFilesMetadata(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        lastCommit?: string,
    ): Promise<FileChange[]> {
        try {
            let changedFiles: FileChange[];

            if (lastCommit) {
                changedFiles =
                    await this.codeManagementService.getChangedFilesSinceLastCommit(
                        {
                            organizationAndTeamData,
                            repository,
                            prNumber: pullRequest?.number,
                            lastCommit,
                        },
                    );
            } else {
                changedFiles =
                    await this.codeManagementService.getFilesByPullRequestId({
                        organizationAndTeamData,
                        repository,
                        prNumber: pullRequest?.number,
                    });
            }

            return changedFiles || [];
        } catch (error) {
            this.logger.error({
                message: 'Error fetching changed files metadata',
                context: PullRequestHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest?.number,
                    repository,
                },
            });
            throw error;
        }
    }

    /**
     * Enriquece arquivos com conteúdo.
     * Usado para buscar conteúdo apenas dos arquivos que passaram pelo filtro ignorePaths.
     * Usa p-limit para controlar concorrência e evitar secondary rate limit do GitHub.
     */
    async enrichFilesWithContent(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: any },
        pullRequest: any,
        files: FileChange[],
    ): Promise<FileChange[]> {
        if (!files || files.length === 0) {
            return [];
        }

        const limit = pLimit(this.FILE_CONTENT_CONCURRENCY);

        try {
            const filesWithContent = await Promise.all(
                files.map((file) =>
                    limit(async () => {
                        try {
                            const fileContent =
                                await this.codeManagementService.getRepositoryContentFile(
                                    {
                                        organizationAndTeamData,
                                        repository,
                                        file,
                                        pullRequest,
                                    },
                                );

                            const content = fileContent?.data?.content;
                            let decodedContent = content;

                            if (
                                content &&
                                fileContent?.data?.encoding === 'base64'
                            ) {
                                decodedContent = Buffer.from(
                                    content,
                                    'base64',
                                ).toString('utf-8');
                            }

                            return {
                                ...file,
                                fileContent: decodedContent,
                            };
                        } catch (error) {
                            this.logger.error({
                                message: `Error fetching content for file: ${file.filename}`,
                                context: PullRequestHandlerService.name,
                                error,
                                metadata: {
                                    organizationAndTeamData,
                                    prNumber: pullRequest?.number,
                                    repository,
                                    filename: file.filename,
                                },
                            });
                            return file;
                        }
                    }),
                ),
            );

            return filesWithContent;
        } catch (error) {
            this.logger.error({
                message: 'Error enriching files with content',
                context: PullRequestHandlerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest?.number,
                    repository,
                    fileCount: files.length,
                },
            });
            throw error;
        }
    }
}
