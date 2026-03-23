import { Injectable } from '@nestjs/common';

import { createLogger } from '@kodus/flow';
import { GenerateKodusConfigFileUseCase } from './generate-kodus-config-file.use-case';
import { GetCodeReviewParameterUseCase } from './get-code-review-parameter.use-case';

@Injectable()
export class DownloadCentralizedConfigUseCase {
    private readonly logger = createLogger(
        DownloadCentralizedConfigUseCase.name,
    );

    constructor(
        private readonly getCodeReviewParameterUseCase: GetCodeReviewParameterUseCase,
        private readonly generateKodusConfigFileUseCase: GenerateKodusConfigFileUseCase,
    ) {}

    public async execute(
        user: any,
        teamId: string,
    ): Promise<Array<{ name: string; yamlString: string }>> {
        const entries: Array<{ name: string; yamlString: string }> = [];

        // Global
        try {
            const { yamlString } =
                await this.generateKodusConfigFileUseCase.execute(
                    teamId,
                    'global',
                );

            if (yamlString) {
                entries.push({ name: 'kodus-config.yml', yamlString });
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to generate global Kodus config file',
                context: DownloadCentralizedConfigUseCase.name,
                metadata: {
                    teamId,
                    errorMessage: error.message,
                },
            });
        }

        // Fetch formatted config to enumerate repos/directories
        const codeReview = await this.getCodeReviewParameterUseCase.execute(
            user,
            teamId,
        );

        for (const repo of codeReview.configValue.repositories ?? []) {
            if (!repo.isSelected) {
                continue;
            }

            const repoFolderName = repo.name || repo.id;

            try {
                const { yamlString } =
                    await this.generateKodusConfigFileUseCase.execute(
                        teamId,
                        repo.id,
                    );

                if (yamlString) {
                    entries.push({
                        name: `${repoFolderName}/kodus-config.yml`,
                        yamlString,
                    });
                }
            } catch (error) {
                this.logger.error({
                    message: 'Failed to generate repo Kodus config file',
                    context: DownloadCentralizedConfigUseCase.name,
                    metadata: {
                        teamId,
                        repoId: repo.id,
                        errorMessage: error.message,
                    },
                });
            }

            for (const dir of repo.directories ?? []) {
                if (!dir.isSelected) {
                    continue;
                }

                try {
                    const { yamlString } =
                        await this.generateKodusConfigFileUseCase.execute(
                            teamId,
                            repo.id,
                            dir.id,
                        );

                    if (yamlString) {
                        const dirPath = (dir.path || '').replace(/^\//, '');
                        const entryName = dirPath
                            ? `${repoFolderName}/${dirPath}/kodus-config.yml`
                            : `${repoFolderName}/kodus-config.yml`;

                        entries.push({ name: entryName, yamlString });
                    }
                } catch (error) {
                    this.logger.error({
                        message:
                            'Failed to generate directory Kodus config file',
                        context: DownloadCentralizedConfigUseCase.name,
                        metadata: {
                            teamId,
                            repoId: repo.id,
                            dirId: dir.id,
                            errorMessage: error.message,
                        },
                    });
                }
            }
        }

        return entries;
    }
}
