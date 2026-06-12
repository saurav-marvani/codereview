import * as yaml from 'js-yaml';

import {
    CentralizedConfigPrService,
    CentralizedMutationPullRequestRequest,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { KodusConfigFile } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { buildGroupFolderName } from './path-encoder';

type FileMutationOperation = {
    path: string;
    operation: 'upsert' | 'delete';
    content?: string;
};

export type DirectoryGroupFolderRef = { path: string };

export interface PreviousGroupRuleFileNames {
    review?: string[];
    memories?: string[];
}

interface BuildKodusConfigCentralizedMutationRequestParams {
    centralizedConfigPrService: CentralizedConfigPrService;
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId?: string;
    directoryPath?: string;
    folders?: DirectoryGroupFolderRef[];
    previousFolders?: DirectoryGroupFolderRef[];
    previousRulesFileNames?: PreviousGroupRuleFileNames;
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
    const isDirectoryGroup =
        Array.isArray(params.folders) && params.folders.length > 0;

    const newFolderName = isDirectoryGroup
        ? buildGroupFolderName(params.folders!.map((f) => f.path))
        : null;
    const oldFolderName =
        params.previousFolders && params.previousFolders.length > 0
            ? buildGroupFolderName(params.previousFolders.map((f) => f.path))
            : null;
    const folderRenamed =
        oldFolderName !== null &&
        newFolderName !== null &&
        oldFolderName !== newFolderName;
    const folderRemoved =
        oldFolderName !== null && newFolderName === null;

    return {
        organizationAndTeamData: params.organizationAndTeamData,
        repositoryId: params.repositoryId,
        files: ({ repositoryFolder }) => {
            if (isDirectoryGroup || folderRemoved) {
                return buildDirectoryGroupFileOps({
                    centralizedConfigPrService:
                        params.centralizedConfigPrService,
                    repositoryFolder,
                    newFolderName,
                    oldFolderName,
                    folderRenamed,
                    folderRemoved,
                    configFileContent: params.configFileContent,
                    previousRulesFileNames: params.previousRulesFileNames,
                });
            }

            const path = params.centralizedConfigPrService.buildCentralizedPath({
                repositoryFolder,
                relativePath: buildKodusConfigRelativePath(
                    normalizedDirectoryPath,
                ),
            });

            if (!hasConfigContent(params.configFileContent)) {
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

function buildDirectoryGroupFileOps(args: {
    centralizedConfigPrService: CentralizedConfigPrService;
    repositoryFolder: string;
    newFolderName: string | null;
    oldFolderName: string | null;
    folderRenamed: boolean;
    folderRemoved: boolean;
    configFileContent?: Partial<KodusConfigFile> | null;
    previousRulesFileNames?: PreviousGroupRuleFileNames;
}): FileMutationOperation[] {
    const {
        centralizedConfigPrService,
        repositoryFolder,
        newFolderName,
        oldFolderName,
        folderRenamed,
        folderRemoved,
        configFileContent,
        previousRulesFileNames,
    } = args;

    const ops: FileMutationOperation[] = [];
    const hasNewContent = hasConfigContent(configFileContent);

    if (newFolderName) {
        const newConfigPath =
            centralizedConfigPrService.buildDirectoryGroupConfigPath(
                repositoryFolder,
                newFolderName,
            );

        if (hasNewContent) {
            ops.push({
                path: newConfigPath,
                operation: 'upsert',
                content: yaml.dump(configFileContent),
            });
        } else if (!folderRenamed) {
            // No content and no rename → user is clearing the override at the
            // current folder. Delete it explicitly.
            ops.push({ path: newConfigPath, operation: 'delete' });
        }
    }

    if (oldFolderName && (folderRenamed || folderRemoved)) {
        ops.push({
            path: centralizedConfigPrService.buildDirectoryGroupConfigPath(
                repositoryFolder,
                oldFolderName,
            ),
            operation: 'delete',
        });

        appendRuleDeletes(
            ops,
            centralizedConfigPrService,
            repositoryFolder,
            oldFolderName,
            previousRulesFileNames?.review ?? [],
            'review',
        );
        appendRuleDeletes(
            ops,
            centralizedConfigPrService,
            repositoryFolder,
            oldFolderName,
            previousRulesFileNames?.memories ?? [],
            'memories',
        );
    }

    return ops;
}

function appendRuleDeletes(
    ops: FileMutationOperation[],
    centralizedConfigPrService: CentralizedConfigPrService,
    repositoryFolder: string,
    folderName: string,
    fileNames: string[],
    rulesDirectory: 'review' | 'memories',
): void {
    for (const fileName of fileNames) {
        ops.push({
            path: centralizedConfigPrService.buildDirectoryGroupRulesPath(
                repositoryFolder,
                folderName,
                rulesDirectory,
                fileName,
            ),
            operation: 'delete',
        });
    }
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
