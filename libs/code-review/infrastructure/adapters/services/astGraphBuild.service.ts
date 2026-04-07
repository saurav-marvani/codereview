import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import type { Sandbox } from 'e2b';
import { AstGraphRepository } from '../repositories/astGraph.repository';
import { RepositoryRepository } from '../repositories/repository.repository';
import { AstGraphStatus } from '../repositories/schemas/repository.model';

const REPO_DIR = '/home/user/repo';
const GRAPH_DIR = '.kodus-graph';
const GRAPH_PATH = `${GRAPH_DIR}/graph.json`;

const KODUS_GRAPH_VERSION = '0.2.3';

const TIMEOUTS = {
    INSTALL_MS: 120_000,
    PARSE_ALL_MS: 300_000,
    PARSE_FILES_MS: 120_000,
};

const DEFAULT_EXCLUDES = [
    '**/tests/**', '**/test/**', '**/__tests__/**', '**/test_*',
    '**/*.test.*', '**/*.spec.*', '**/fixtures/**', '**/static/**', '**/__mocks__/**',
];

@Injectable()
export class AstGraphBuildService {
    private readonly logger = createLogger(AstGraphBuildService.name);

    constructor(
        private readonly astGraphRepo: AstGraphRepository,
        private readonly repositoryRepo: RepositoryRepository,
    ) {}

    /**
     * Full build: parse entire repo and persist to DB.
     * Called by AstGraphBuildJobProcessor.
     */
    async fullBuild(params: {
        repositoryId: string;
        sandbox: Sandbox;
        headSha: string;
    }): Promise<void> {
        const { repositoryId, sandbox, headSha } = params;

        this.logger.log({
            message: `[AST-GRAPH] Starting full build for repo ${repositoryId}`,
            context: AstGraphBuildService.name,
        });

        await this.repositoryRepo.updateGraphStatus(repositoryId, AstGraphStatus.BUILDING);

        try {
            // Install kodus-graph
            await this.installKodusGraph(sandbox);

            // Parse full repo
            const excludeFlags = DEFAULT_EXCLUDES.map((p) => `--exclude "${p}"`).join(' ');
            const parseResult = await sandbox.commands.run(
                [
                    `export PATH="$HOME/.bun/bin:$PATH"`,
                    `cd ${REPO_DIR}`,
                    `mkdir -p ${GRAPH_DIR}`,
                    `kodus-graph parse --all --repo-dir . --out ${GRAPH_PATH} ${excludeFlags}`,
                ].join(' && '),
                { timeoutMs: TIMEOUTS.PARSE_ALL_MS },
            );

            if (parseResult.exitCode !== 0) {
                throw new Error(
                    `kodus-graph parse --all failed (exit=${parseResult.exitCode}): ${(parseResult.stderr || '').slice(0, 500)}`,
                );
            }

            // Read graph JSON from sandbox
            const catResult = await sandbox.commands.run(
                `cat ${REPO_DIR}/${GRAPH_PATH}`,
                { timeoutMs: 30_000 },
            );
            if (!catResult.stdout) {
                throw new Error('kodus-graph parse produced empty output');
            }

            const graphData = JSON.parse(catResult.stdout);
            const nodes = graphData.nodes || [];
            const edges = graphData.edges || [];

            // Persist to DB (transactional: delete all + insert all)
            const counts = await this.astGraphRepo.fullRebuild(repositoryId, nodes, edges);

            // Update repo status
            await this.repositoryRepo.updateGraphStatus(repositoryId, AstGraphStatus.READY, {
                sha: headSha,
                nodeCount: counts.nodeCount,
                edgeCount: counts.edgeCount,
            });

            this.logger.log({
                message: `[AST-GRAPH] Full build complete: ${counts.nodeCount} nodes, ${counts.edgeCount} edges`,
                context: AstGraphBuildService.name,
                metadata: { repositoryId, nodeCount: counts.nodeCount, edgeCount: counts.edgeCount },
            });
        } catch (error) {
            await this.repositoryRepo.updateGraphStatus(repositoryId, AstGraphStatus.FAILED);
            this.logger.error({
                message: `[AST-GRAPH] Full build failed for repo ${repositoryId}`,
                context: AstGraphBuildService.name,
                error,
            });
            throw error;
        }
    }

    /**
     * Incremental update: parse only changed files and update DB.
     * Called by AstGraphIncrementalJobProcessor.
     */
    async incrementalUpdate(params: {
        repositoryId: string;
        sandbox: Sandbox;
        changedFiles: string[];
        newSha: string;
    }): Promise<void> {
        const { repositoryId, sandbox, changedFiles, newSha } = params;

        this.logger.log({
            message: `[AST-GRAPH] Incremental update: ${changedFiles.length} files`,
            context: AstGraphBuildService.name,
            metadata: { repositoryId, changedFiles: changedFiles.length },
        });

        try {
            await this.installKodusGraph(sandbox);

            const filesArg = changedFiles.join(' ');
            const parseResult = await sandbox.commands.run(
                [
                    `export PATH="$HOME/.bun/bin:$PATH"`,
                    `cd ${REPO_DIR}`,
                    `mkdir -p ${GRAPH_DIR}`,
                    `kodus-graph parse --files ${filesArg} --repo-dir . --out ${GRAPH_PATH}`,
                ].join(' && '),
                { timeoutMs: TIMEOUTS.PARSE_FILES_MS },
            );

            if (parseResult.exitCode !== 0) {
                throw new Error(
                    `kodus-graph parse --files failed (exit=${parseResult.exitCode}): ${(parseResult.stderr || '').slice(0, 500)}`,
                );
            }

            const catResult = await sandbox.commands.run(
                `cat ${REPO_DIR}/${GRAPH_PATH}`,
                { timeoutMs: 30_000 },
            );
            if (!catResult.stdout) {
                throw new Error('kodus-graph parse produced empty output');
            }

            const graphData = JSON.parse(catResult.stdout);
            const counts = await this.astGraphRepo.incrementalUpdate(
                repositoryId,
                changedFiles,
                graphData.nodes || [],
                graphData.edges || [],
            );

            await this.repositoryRepo.updateGraphStatus(repositoryId, AstGraphStatus.READY, {
                sha: newSha,
                nodeCount: undefined, // don't update total counts on incremental
                edgeCount: undefined,
            });

            this.logger.log({
                message: `[AST-GRAPH] Incremental update complete: ${counts.nodeCount} nodes, ${counts.edgeCount} edges for ${changedFiles.length} files`,
                context: AstGraphBuildService.name,
            });
        } catch (error) {
            this.logger.warn({
                message: `[AST-GRAPH] Incremental update failed (non-critical)`,
                context: AstGraphBuildService.name,
                error,
            });
            // Don't set status to failed — graph is stale but still usable
            throw error;
        }
    }

    private async installKodusGraph(sandbox: Sandbox): Promise<void> {
        const result = await sandbox.commands.run(
            [
                'which bun > /dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1)',
                'export PATH="$HOME/.bun/bin:$PATH"',
                `bun install -g @kodus/kodus-graph@${KODUS_GRAPH_VERSION} 2>&1`,
            ].join(' && '),
            { timeoutMs: TIMEOUTS.INSTALL_MS },
        );

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph install failed (exit=${result.exitCode}): ${(result.stderr || result.stdout || '').slice(0, 500)}`,
            );
        }
    }
}
