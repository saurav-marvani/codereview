import * as yaml from 'js-yaml';

import {
    CentralizedConfigPrService,
    CentralizedMutationPullRequestRequest,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { KodusConfigFile } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

interface BuildKodusConfigCentralizedMutationRequestParams {
    centralizedConfigPrService: CentralizedConfigPrService;
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId?: string;
    directoryPath?: string;
    directoryId?: string;
    folders?: Array<{ path: string }>;
    configFileContent?: Partial<KodusConfigFile> | null;
    title: string;
    description: string;
    commitMessage: string;
    sourceBranchPrefix: string;
    centralizedModeMessage?: string;
    author?: { name: string; email?: string };
}

export function buildKodusConfigCentralizedMutationRequest(
    params: BuildKodusConfigCentralizedMutationRequestParams,
): CentralizedMutationPullRequestRequest {
    const normalizedDirectoryPath = normalizeDirectoryPath(params.directoryPath);
    const directoryId = params.directoryId;

    return {
        organizationAndTeamData: params.organizationAndTeamData,
        repositoryId: params.repositoryId,
        files: ({ repositoryFolder }) => {
            if (directoryId) {
                const configPath =
                    params.centralizedConfigPrService.buildDirectoryGroupConfigPath(
                        repositoryFolder,
                        directoryId,
                    );
                const foldersPath =
                    params.centralizedConfigPrService.buildDirectoryGroupFoldersPath(
                        repositoryFolder,
                        directoryId,
                    );
                const hasContent = hasConfigContent(params.configFileContent);

                if (!hasContent) {
                    return [
                        { path: configPath, operation: 'delete' },
                        { path: foldersPath, operation: 'delete' },
                    ];
                }

                const files: {
                    path: string;
                    operation: 'upsert' | 'delete';
                    content?: string;
                }[] = [
                    {
                        path: configPath,
                        operation: 'upsert',
                        content: yaml.dump(params.configFileContent),
                    },
                ];

                if (params.folders && params.folders.length > 0) {
                    files.push({
                        path: foldersPath,
                        operation: 'upsert',
                        content: yaml.dump({ folders: params.folders }),
                    });
                }

                return files;
            }

            const path = params.centralizedConfigPrService.buildCentralizedPath({
                repositoryFolder,
                relativePath: buildKodusConfigRelativePath(
                    normalizedDirectoryPath,
                ),
            });

            const hasContent = hasConfigContent(params.configFileContent);

            if (!hasContent) {
                return [{ path, operation: 'delete' }];
            }

            return [
                {
                    path,
                    operation: 'upsert',
                    content: yaml.dump(params.configFileContent),
                },
            ];
        },
        title: params.title,
        description: params.description,
        commitMessage: params.commitMessage,
        sourceBranch: `${params.sourceBranchPrefix}-${Date.now()}`,
        centralizedModeMessage: params.centralizedModeMessage,
        author: params.author,
    };
}

export function hasConfigContent(configFileContent?:
    | Partial<KodusConfigFile>
    | null): boolean {
    return Boolean(
        configFileContent && Object.keys(configFileContent).length > 0,
    );
}

function buildKodusConfigRelativePath(directoryPath?: string): string {
    if (!directoryPath) {
        return 'kodus-config.yml';
    }

    return `${directoryPath}/kodus-config.yml`;
}

function normalizeDirectoryPath(path?: string): string | undefined {
    if (!path) {
        return undefined;
    }

    const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized || undefined;
}
