import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import type { Sandbox } from 'e2b';
import { AstGraphRepository } from '../repositories/astGraph.repository';
import { RepositoryRepository } from '../repositories/repository.repository';
import { AstGraphStatus } from '../repositories/schemas/repository.model';

const REPO_DIR = '/home/user/repo';
const GRAPH_DIR = '.kodus-graph';
const GRAPH_PATH = `${GRAPH_DIR}/graph.json`;

const KODUS_GRAPH_VERSION = 'latest';

const TIMEOUTS = {
    INSTALL_MS: 120_000,
    PARSE_ALL_MS: 600_000,
    PARSE_FILES_MS: 120_000,
    READ_FILE_MS: 600_000,
};

const DEFAULT_EXCLUDES = [
    '**/tests/**',
    '**/test/**',
    '**/__tests__/**',
    '**/test_*',
    '**/*.test.*',
    '**/*.spec.*',
    '**/fixtures/**',
    '**/static/**',
    '**/__mocks__/**',
    '**/.yarn/**',
    '**/node_modules/**',
    '**/vendor/**',
    '**/dist/**',
    '**/build/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.bundle.js',
    '**/*.chunk.js',
];

/** Repos above this threshold get a warning log before persist */
const LARGE_REPO_NODE_THRESHOLD = 50_000;

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
        const buildStart = Date.now();

        this.logger.log({
            message: `[AST-GRAPH] Starting full build for repo ${repositoryId}`,
            context: AstGraphBuildService.name,
            metadata: { repositoryId, headSha },
        });

        await this.repositoryRepo.updateGraphStatus(
            repositoryId,
            AstGraphStatus.BUILDING,
        );

        try {
            // 1. Install kodus-graph
            const installStart = Date.now();
            await this.installKodusGraph(sandbox);
            this.logger.log({
                message: `[AST-GRAPH] kodus-graph installed (${Date.now() - installStart}ms)`,
                context: AstGraphBuildService.name,
                metadata: { repositoryId },
            });

            // 2. Parse full repo
            const parseStart = Date.now();
            const excludeFlags = DEFAULT_EXCLUDES.map(
                (p) => `--exclude "${p}"`,
            ).join(' ');
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

            this.logger.log({
                message: `[AST-GRAPH] Parse completed (${Date.now() - parseStart}ms)`,
                context: AstGraphBuildService.name,
                metadata: {
                    repositoryId,
                    parseStderr: (parseResult.stderr || '').slice(0, 300),
                },
            });

            // 3. Read graph JSON from sandbox
            const { nodes, edges } = await this.readGraphFromSandbox(
                sandbox,
                repositoryId,
            );

            // 4. Validate — empty graph means excludes filtered everything or parse failed silently
            if (nodes.length === 0) {
                this.logger.warn({
                    message: `[AST-GRAPH] Parse produced 0 nodes for repo ${repositoryId} — marking as FAILED`,
                    context: AstGraphBuildService.name,
                    metadata: { repositoryId, headSha },
                });
                await this.repositoryRepo.updateGraphStatus(
                    repositoryId,
                    AstGraphStatus.FAILED,
                );
                return;
            }

            // 5. Persist to DB
            const persistStart = Date.now();
            const counts = await this.astGraphRepo.fullRebuild(
                repositoryId,
                nodes,
                edges,
            );

            this.logger.log({
                message: `[AST-GRAPH] DB persist completed (${Date.now() - persistStart}ms)`,
                context: AstGraphBuildService.name,
                metadata: {
                    repositoryId,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                },
            });

            // 6. Update repo status
            await this.repositoryRepo.updateGraphStatus(
                repositoryId,
                AstGraphStatus.READY,
                {
                    sha: headSha,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                },
            );

            const totalMs = Date.now() - buildStart;
            this.logger.log({
                message: `[AST-GRAPH] Full build COMPLETE for repo ${repositoryId} in ${totalMs}ms — ${counts.nodeCount} nodes, ${counts.edgeCount} edges`,
                context: AstGraphBuildService.name,
                metadata: {
                    repositoryId,
                    headSha,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                    durationMs: totalMs,
                },
            });
        } catch (error) {
            const totalMs = Date.now() - buildStart;
            await this.repositoryRepo.updateGraphStatus(
                repositoryId,
                AstGraphStatus.FAILED,
            );
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.error({
                message: `[AST-GRAPH] Full build FAILED for repo ${repositoryId} after ${totalMs}ms — ${errorMessage}`,
                context: AstGraphBuildService.name,
                metadata: { repositoryId, headSha, durationMs: totalMs },
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
        const updateStart = Date.now();

        this.logger.log({
            message: `[AST-GRAPH] Starting incremental update: ${changedFiles.length} files for repo ${repositoryId}`,
            context: AstGraphBuildService.name,
            metadata: {
                repositoryId,
                newSha,
                changedFilesCount: changedFiles.length,
                changedFiles: changedFiles.slice(0, 20),
            },
        });

        try {
            // 1. Install kodus-graph
            const installStart = Date.now();
            await this.installKodusGraph(sandbox);
            this.logger.log({
                message: `[AST-GRAPH] kodus-graph installed (${Date.now() - installStart}ms)`,
                context: AstGraphBuildService.name,
                metadata: { repositoryId },
            });

            // 2. Parse changed files
            const parseStart = Date.now();
            const filesArg = changedFiles
                .map((f) => `'${f.replace(/'/g, "'\\''")}'`)
                .join(' ');
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

            this.logger.log({
                message: `[AST-GRAPH] Incremental parse completed (${Date.now() - parseStart}ms)`,
                context: AstGraphBuildService.name,
                metadata: {
                    repositoryId,
                    changedFilesCount: changedFiles.length,
                },
            });

            // 3. Read graph JSON from sandbox
            const { nodes, edges } = await this.readGraphFromSandbox(
                sandbox,
                repositoryId,
            );

            // 4. Persist to DB
            const persistStart = Date.now();
            const counts = await this.astGraphRepo.incrementalUpdate(
                repositoryId,
                changedFiles,
                nodes,
                edges,
            );

            this.logger.log({
                message: `[AST-GRAPH] Incremental DB persist completed (${Date.now() - persistStart}ms)`,
                context: AstGraphBuildService.name,
                metadata: {
                    repositoryId,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                },
            });

            await this.repositoryRepo.updateGraphStatus(
                repositoryId,
                AstGraphStatus.READY,
                {
                    sha: newSha,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                },
            );

            const totalMs = Date.now() - updateStart;
            this.logger.log({
                message: `[AST-GRAPH] Incremental update COMPLETE for repo ${repositoryId} in ${totalMs}ms — ${counts.nodeCount} nodes, ${counts.edgeCount} edges from ${changedFiles.length} files`,
                context: AstGraphBuildService.name,
                metadata: {
                    repositoryId,
                    newSha,
                    nodeCount: counts.nodeCount,
                    edgeCount: counts.edgeCount,
                    changedFilesCount: changedFiles.length,
                    durationMs: totalMs,
                },
            });
        } catch (error) {
            const totalMs = Date.now() - updateStart;
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.warn({
                message: `[AST-GRAPH] Incremental update FAILED for repo ${repositoryId} after ${totalMs}ms — ${errorMessage}`,
                context: AstGraphBuildService.name,
                metadata: {
                    repositoryId,
                    newSha,
                    changedFilesCount: changedFiles.length,
                    durationMs: totalMs,
                },
            });
            // Don't set status to failed — graph is stale but still usable
            throw error;
        }
    }

    /**
     * Read the graph JSON file from the E2B sandbox using the files API,
     * then split into nodes and edges.
     *
     * Uses `sandbox.files.read()` instead of piping via stdout (`cat`),
     * which avoids the E2B command-runner stdout buffer overhead.
     */
    private async readGraphFromSandbox(
        sandbox: Sandbox,
        repositoryId: string,
    ): Promise<{ nodes: any[]; edges: any[] }> {
        const readStart = Date.now();
        const filePath = `${REPO_DIR}/${GRAPH_PATH}`;

        let rawJson: string;
        try {
            rawJson = await sandbox.files.read(filePath, {
                requestTimeoutMs: TIMEOUTS.READ_FILE_MS,
            });
        } catch (err) {
            const errorMessage =
                err instanceof Error ? err.message : String(err);
            throw new Error(
                `Failed to read graph file from sandbox (${filePath}): ${errorMessage}`,
                { cause: err },
            );
        }

        if (!rawJson || rawJson.length === 0) {
            throw new Error('kodus-graph parse produced empty output file');
        }

        const graphData = JSON.parse(rawJson);

        const nodes = graphData.nodes || [];
        const edges = graphData.edges || [];

        this.logger.log({
            message: `[AST-GRAPH] Graph read from sandbox (${Date.now() - readStart}ms): ${nodes.length} nodes, ${edges.length} edges`,
            context: AstGraphBuildService.name,
            metadata: {
                repositoryId,
                nodeCount: nodes.length,
                edgeCount: edges.length,
            },
        });

        if (nodes.length > LARGE_REPO_NODE_THRESHOLD) {
            this.logger.warn({
                message: `[AST-GRAPH] Large repo detected: ${nodes.length} nodes for ${repositoryId} — persist may be slow`,
                context: AstGraphBuildService.name,
                metadata: {
                    repositoryId,
                    nodeCount: nodes.length,
                    edgeCount: edges.length,
                },
            });
        }

        return { nodes, edges };
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
