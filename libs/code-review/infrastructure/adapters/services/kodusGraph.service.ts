import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import type { Sandbox } from 'e2b';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { AstGraphRepository } from '../repositories/astGraph.repository';
import { RepositoryRepository } from '../repositories/repository.repository';

const REPO_DIR = '/home/user/repo';
const GRAPH_DIR = '.kodus-graph';
const GRAPH_PATH = `${GRAPH_DIR}/graph.json`;
const PROMPT_PATH = `${GRAPH_DIR}/prompt.txt`;

const TIMEOUTS = {
    INSTALL_MS: 120_000, // 2 min — download + install bun + kodus-graph
    PARSE_MS: 300_000, // 5 min — parse changed files (generous for large PRs)
    CONTEXT_MS: 60_000, // 1 min — context generation
};

const KODUS_GRAPH_VERSION = 'latest';

@Injectable()
export class KodusGraphService {
    private readonly logger = createLogger(KodusGraphService.name);

    constructor(
        private readonly astGraphRepo: AstGraphRepository,
        private readonly repositoryRepo: RepositoryRepository,
    ) {}

    /**
     * Generate context using DB graph as baseline (new flow).
     * Parses only changed files, exports base graph from DB, runs kodus-graph context.
     */
    async generateContext(
        sandboxHandle: unknown,
        changedFiles: FileChange[],
        repoId: string,
    ): Promise<string> {
        const sandbox = sandboxHandle as Sandbox;
        if (!sandbox?.commands) {
            this.logger.warn({
                message: `[KODUS-GRAPH] generateContext: sandbox has no commands, skipping`,
                context: KodusGraphService.name,
                metadata: {
                    repoId,
                    hasSandbox: !!sandbox,
                    keys: sandbox ? Object.keys(sandbox).slice(0, 5) : [],
                },
            });
            return '';
        }

        const filePaths = changedFiles
            .map((f) => f.filename || f.previous_filename)
            .filter(Boolean) as string[];
        if (filePaths.length === 0) {
            this.logger.warn({
                message: `[KODUS-GRAPH] generateContext: no file paths extracted from ${changedFiles?.length} files`,
                context: KodusGraphService.name,
            });
            return '';
        }

        try {
            // Step 1: Install kodus-graph
            this.logger.log({
                message: `[KODUS-GRAPH] Step 1/4: Installing kodus-graph...`,
                context: KodusGraphService.name,
                metadata: { repoId, fileCount: filePaths.length },
            });
            await this.installKodusGraph(sandbox);

            // Step 2: Parse ONLY changed files (not --all)
            this.logger.log({
                message: `[KODUS-GRAPH] Step 2/4: Parsing ${filePaths.length} changed files...`,
                context: KodusGraphService.name,
                metadata: { files: filePaths },
            });
            await this.parseChangedFiles(sandbox, filePaths);

            // Step 3: Export filtered subgraph from DB and write to sandbox
            this.logger.log({
                message: `[KODUS-GRAPH] Step 3/4: Exporting subgraph from DB for repo ${repoId}...`,
                context: KodusGraphService.name,
            });
            const repo = await this.repositoryRepo.findById(repoId);
            if (!repo) {
                this.logger.warn({
                    message: `[KODUS-GRAPH] Step 3/4: repo not found by UUID ${repoId}, falling back to legacy`,
                    context: KodusGraphService.name,
                });
                return this.generateContextLegacy(sandboxHandle, changedFiles);
            }
            await this.writeBaseGraphToSandbox(
                sandbox,
                repoId,
                filePaths,
                repo.astGraphSha ?? undefined,
            );

            // Step 4: Generate context with real diff
            // Always write diff so kodus-graph can filter when baseline is empty
            const diffPath = await this.writeDiffToSandbox(
                sandbox,
                changedFiles,
            );
            this.logger.log({
                message: `[KODUS-GRAPH] Step 4/4: Generating prompt context with base graph...`,
                context: KodusGraphService.name,
                metadata: { hasDiff: !!diffPath },
            });
            const prompt = await this.generatePromptContext(
                sandbox,
                filePaths,
                `${GRAPH_DIR}/base-graph.json`, // base graph from DB (main branch)
                diffPath,
            );

            this.logger.log({
                message: `[KODUS-GRAPH] Context generated with DB baseline: ${prompt.length} chars`,
                context: KodusGraphService.name,
                metadata: {
                    changedFiles: filePaths.length,
                    promptChars: prompt.length,
                    promptPreview: prompt.substring(0, 200),
                },
            });

            return prompt;
        } catch (error) {
            this.logger.warn({
                message: `[KODUS-GRAPH] Failed with DB baseline, falling back to legacy`,
                context: KodusGraphService.name,
                error,
                metadata: { repoId, fileCount: filePaths.length },
            });
            return this.generateContextLegacy(sandboxHandle, changedFiles);
        }
    }

    /**
     * Legacy flow: parse changed files, optionally building a baseline graph
     * from the base branch via `git show` (read-only, no repo modifications).
     * When baseBranch is provided and the sandbox has it fetched, old file versions
     * are extracted and parsed to produce an oldGraph — enabling contract_diffs
     * (signature change detection) without needing a full DB baseline.
     * Falls back gracefully to no-baseline behavior on any failure.
     */
    async generateContextLegacy(
        sandboxHandle: unknown,
        changedFiles: FileChange[],
        baseBranch?: string,
    ): Promise<string> {
        this.logger.log({
            message: `[KODUS-GRAPH] generateContextLegacy called: changedFiles=${changedFiles?.length}, baseBranch=${baseBranch || 'none'}, sandboxHandle type=${typeof sandboxHandle}`,
            context: KodusGraphService.name,
        });

        const sandbox = sandboxHandle as Sandbox;
        if (!sandbox?.commands) {
            this.logger.warn({
                message: `[KODUS-GRAPH] No sandbox handle available, skipping (has commands: ${!!sandbox?.commands}, keys: ${sandbox ? Object.keys(sandbox).slice(0, 5).join(',') : 'null'})`,
                context: KodusGraphService.name,
            });
            return '';
        }

        const filePaths = changedFiles
            .map((f) => f.filename || f.previous_filename)
            .filter(Boolean) as string[];

        if (filePaths.length === 0) {
            this.logger.warn({
                message: `[KODUS-GRAPH] No file paths extracted from ${changedFiles?.length} changed files, skipping`,
                context: KodusGraphService.name,
            });
            return '';
        }

        try {
            // Step 1: Install bun + kodus-graph
            await this.installKodusGraph(sandbox);

            // Step 2: Write unified diff to sandbox so kodus-graph can filter
            // changed functions by actual diff lines (not mark all as "new").
            const diffPath = await this.writeDiffToSandbox(
                sandbox,
                changedFiles,
            );

            // Step 3: Try to build base graph from git history (read-only).
            // This enables contract_diffs (param/return/visibility change detection)
            // without needing a pre-built DB baseline from `parse --all`.
            let baseGraphPath: string | undefined;
            if (baseBranch) {
                baseGraphPath = await this.buildBaseGraphFromGit(
                    sandbox,
                    filePaths,
                    baseBranch,
                );
            }

            // Step 4: Generate context — with base graph if available, otherwise
            // oldGraph=null and --diff filters functions by actual diff hunks.
            const prompt = await this.generatePromptContext(
                sandbox,
                filePaths,
                baseGraphPath,
                diffPath,
            );

            this.logger.log({
                message: `[KODUS-GRAPH] Context generated: ${prompt.length} chars for ${filePaths.length} changed files (baseGraph=${baseGraphPath ? 'yes' : 'no'})`,
                context: KodusGraphService.name,
                metadata: {
                    changedFiles: filePaths.length,
                    promptChars: prompt.length,
                    hasBaseGraph: !!baseGraphPath,
                    baseBranch: baseBranch || 'none',
                    promptPreview: prompt.substring(0, 320),
                },
            });

            return prompt;
        } catch (error) {
            this.logger.warn({
                message: `[KODUS-GRAPH] Failed to generate context, proceeding without it`,
                context: KodusGraphService.name,
                error,
            });
            return '';
        }
    }

    /**
     * Build a baseline graph from the base branch using git history.
     * Uses `git show origin/<baseBranch>:<file>` (read-only) to get old versions
     * of changed files, parses them with kodus-graph, and returns the graph path.
     * Returns undefined on any failure — caller falls back to no-baseline behavior.
     */
    private async buildBaseGraphFromGit(
        sandbox: Sandbox,
        filePaths: string[],
        baseBranch: string,
    ): Promise<string | undefined> {
        const BASE_FILES_DIR = `${GRAPH_DIR}/base-files`;
        const BASE_GRAPH_PATH = `${GRAPH_DIR}/base-graph.json`;

        try {
            // Extract old file versions from git (read-only, no branch changes).
            // Files that don't exist on the base branch (new files) are silently skipped.
            const escapedFiles = filePaths.map(
                (f) => `'${f.replace(/'/g, "'\\''")}'`,
            );
            const fileList = escapedFiles.join(' ');

            const extractResult = await sandbox.commands.run(
                [
                    `cd ${REPO_DIR}`,
                    `rm -rf ${BASE_FILES_DIR} && mkdir -p ${BASE_FILES_DIR}`,
                    `for f in ${fileList}; do ` +
                        `d="${BASE_FILES_DIR}/$(dirname "$f")" && ` +
                        `mkdir -p "$d" 2>/dev/null; ` +
                        `git show "origin/${baseBranch}:$f" > "${BASE_FILES_DIR}/$f" 2>/dev/null || rm -f "${BASE_FILES_DIR}/$f"; ` +
                        `done`,
                    `find ${BASE_FILES_DIR} -type f -size +0c | sed 's|^${BASE_FILES_DIR}/||' | sort`,
                ].join(' && '),
                { timeoutMs: 30_000 },
            );

            if (extractResult.exitCode !== 0) {
                this.logger.warn({
                    message: `[KODUS-GRAPH] buildBaseGraphFromGit: extract failed (exit=${extractResult.exitCode})`,
                    context: KodusGraphService.name,
                    metadata: {
                        stderr: (extractResult.stderr || '').slice(0, 300),
                    },
                });
                return undefined;
            }

            const extractedFiles = (extractResult.stdout || '')
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean);

            if (extractedFiles.length === 0) {
                this.logger.log({
                    message: `[KODUS-GRAPH] buildBaseGraphFromGit: no old files found on origin/${baseBranch} (all ${filePaths.length} files are new)`,
                    context: KodusGraphService.name,
                });
                return undefined;
            }

            // Parse old files to produce base graph
            const oldFilesArg = extractedFiles
                .map((f) => `'${f.replace(/'/g, "'\\''")}'`)
                .join(' ');
            const parseResult = await sandbox.commands.run(
                [
                    'export PATH="$HOME/.bun/bin:$PATH"',
                    `cd ${REPO_DIR}`,
                    `kodus-graph parse --files ${oldFilesArg} --repo-dir ${BASE_FILES_DIR} --out ${BASE_GRAPH_PATH}`,
                ].join(' && '),
                { timeoutMs: TIMEOUTS.PARSE_MS },
            );

            if (parseResult.exitCode !== 0) {
                this.logger.warn({
                    message: `[KODUS-GRAPH] buildBaseGraphFromGit: parse failed (exit=${parseResult.exitCode})`,
                    context: KodusGraphService.name,
                    metadata: {
                        stderr: (parseResult.stderr || '').slice(0, 300),
                        fileCount: extractedFiles.length,
                    },
                });
                return undefined;
            }

            this.logger.log({
                message: `[KODUS-GRAPH] buildBaseGraphFromGit: base graph built from ${extractedFiles.length}/${filePaths.length} files on origin/${baseBranch}`,
                context: KodusGraphService.name,
                metadata: {
                    baseBranch,
                    extractedFiles: extractedFiles.length,
                    totalFiles: filePaths.length,
                },
            });

            return BASE_GRAPH_PATH;
        } catch (error) {
            this.logger.warn({
                message: `[KODUS-GRAPH] buildBaseGraphFromGit: unexpected error, proceeding without base graph`,
                context: KodusGraphService.name,
                error,
            });
            return undefined;
        }
    }

    private async installKodusGraph(sandbox: Sandbox): Promise<void> {
        // Check installed version — always ensure latest is available.
        // Use "|| true" to prevent E2B CommandExitError when command fails.
        const check = await sandbox.commands.run(
            'export PATH="$HOME/.bun/bin:$PATH" && kodus-graph --version 2>/dev/null || true',
            { timeoutMs: 5_000 },
        );

        const installedVersion = (check.stdout || '').trim();

        if (installedVersion && installedVersion === KODUS_GRAPH_VERSION) {
            this.logger.log({
                message: `[KODUS-GRAPH] Version ${installedVersion} matches target ${KODUS_GRAPH_VERSION}, skipping install`,
                context: KodusGraphService.name,
            });
            return;
        }

        this.logger.log({
            message: `[KODUS-GRAPH] Installing kodus-graph@${KODUS_GRAPH_VERSION} (installed: ${installedVersion || 'none'})`,
            context: KodusGraphService.name,
        });

        const result = await sandbox.commands.run(
            [
                // Install bun if not present
                'which bun > /dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1)',
                'export PATH="$HOME/.bun/bin:$PATH"',
                // Install/update kodus-graph globally
                `bun install -g @kodus/kodus-graph@${KODUS_GRAPH_VERSION} 2>&1`,
            ].join(' && '),
            { timeoutMs: TIMEOUTS.INSTALL_MS },
        );

        this.logger.log({
            message: `[KODUS-GRAPH] Install output: exit=${result.exitCode}, stdout=${(result.stdout || '').slice(0, 300)}`,
            context: KodusGraphService.name,
        });

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph install failed (exit=${result.exitCode}): ${(result.stderr || result.stdout || '').slice(0, 500)}`,
            );
        }

        this.logger.log({
            message: `[KODUS-GRAPH] Installed successfully`,
            context: KodusGraphService.name,
        });
    }

    private async parseChangedFiles(
        sandbox: Sandbox,
        filePaths: string[],
    ): Promise<void> {
        const filesArg = filePaths
            .map((f) => `'${f.replace(/'/g, "'\\''")}'`)
            .join(' ');
        const result = await sandbox.commands.run(
            [
                'export PATH="$HOME/.bun/bin:$PATH"',
                `cd ${REPO_DIR}`,
                `mkdir -p ${GRAPH_DIR}`,
                `kodus-graph parse --files ${filesArg} --repo-dir . --out ${GRAPH_PATH}`,
            ].join(' && '),
            { timeoutMs: TIMEOUTS.PARSE_MS },
        );

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph parse --files failed (exit=${result.exitCode}): ${(result.stderr || '').slice(0, 500)}`,
            );
        }

        this.logger.log({
            message: `[KODUS-GRAPH] Step 2/4: Parse completed successfully`,
            context: KodusGraphService.name,
            metadata: { stdout: (result.stdout || '').slice(0, 300) },
        });
    }

    private async writeBaseGraphToSandbox(
        sandbox: Sandbox,
        repoId: string,
        changedFiles: string[],
        sha?: string,
    ): Promise<void> {
        // Filtered subgraph: only nodes in changed files + direct neighbors.
        // ~99% reduction vs full export (e.g. ~500 nodes instead of 50k+).
        const jsonStr = await this.astGraphRepo.exportSubgraphJsonString(
            repoId,
            changedFiles,
            sha,
        );
        const baseGraphPath = `${REPO_DIR}/${GRAPH_DIR}/base-graph.json`;

        this.logger.log({
            message: `[KODUS-GRAPH] Step 3/4: Subgraph exported: ${jsonStr.length} chars, writing to sandbox at ${baseGraphPath}`,
            context: KodusGraphService.name,
            metadata: {
                repoId,
                changedFiles,
                subgraphChars: jsonStr.length,
                sha,
            },
        });

        await sandbox.files.write(baseGraphPath, jsonStr);
    }

    /**
     * Build a unified diff from changedFiles patches and write it to the sandbox.
     * Used in fallback mode so kodus-graph can filter changed functions by actual diff lines.
     */
    private async writeDiffToSandbox(
        sandbox: Sandbox,
        changedFiles: FileChange[],
    ): Promise<string | undefined> {
        const patches: string[] = [];
        for (const file of changedFiles) {
            // Use raw patch first; fall back to patchWithLinesStr (which has line numbers prepended).
            const rawPatch = file.patch || file.patchWithLinesStr;
            if (!rawPatch) continue;
            const filePath = file.filename || file.previous_filename || '';
            if (!filePath) continue;

            let patchBody: string;
            if (file.patch) {
                // Raw GitHub patch — use directly.
                patchBody = file.patch;
            } else {
                // patchWithLinesStr format: has "## file: '...'" header and line-numbered content.
                // Strip the header and line numbers — parseDiffHunks only needs @@ headers.
                patchBody = rawPatch
                    .split('\n')
                    .filter((line) => !line.startsWith('## file:'))
                    .map((line) => {
                        // Remove leading line-number prefix (e.g. "   149 +    code" → "+    code")
                        // Lines look like: "   149      code" or "   152 +    code" or "    10 -    code"
                        const m = line.match(/^\s*\d+\s([+ -].*)/);
                        return m ? m[1] : line;
                    })
                    .join('\n');
            }

            // Ensure trailing newline so next file header isn't on the same line.
            const patchNormalized = patchBody.endsWith('\n')
                ? patchBody
                : `${patchBody}\n`;
            patches.push(
                `--- a/${filePath}\n+++ b/${filePath}\n${patchNormalized}`,
            );
        }
        if (patches.length === 0) {
            this.logger.warn({
                message: `[KODUS-GRAPH] No patches found in changedFiles, skipping diff write`,
                context: KodusGraphService.name,
            });
            return undefined;
        }
        const diffContent = patches.join('\n');
        const diffPath = `${REPO_DIR}/${GRAPH_DIR}/pr.diff`;
        await sandbox.commands.run(`mkdir -p ${REPO_DIR}/${GRAPH_DIR}`, {
            timeoutMs: 5_000,
        });
        await sandbox.files.write(diffPath, diffContent);
        this.logger.log({
            message: `[KODUS-GRAPH] Diff written to sandbox: ${diffContent.length} chars, ${patches.length} files`,
            context: KodusGraphService.name,
            metadata: {
                diffChars: diffContent.length,
                filesWithPatch: patches.length,
            },
        });
        return `${GRAPH_DIR}/pr.diff`;
    }

    private async generatePromptContext(
        sandbox: Sandbox,
        filePaths: string[],
        graphPath?: string,
        diffPath?: string,
    ): Promise<string> {
        const filesArg = filePaths
            .map((f) => `'${f.replace(/'/g, "'\\''")}'`)
            .join(' ');

        const graphArg = graphPath ? ` --graph ${graphPath}` : '';
        const diffArg = diffPath ? ` --diff ${diffPath}` : '';
        const cmd = `kodus-graph context --files ${filesArg}${graphArg}${diffArg} --repo-dir . --format prompt --out ${PROMPT_PATH}`;
        this.logger.log({
            message: `[KODUS-GRAPH] Step 4/4: Running context command`,
            context: KodusGraphService.name,
            metadata: { cmd: cmd.substring(0, 300), graphPath },
        });

        const result = await sandbox.commands.run(
            [
                'export PATH="$HOME/.bun/bin:$PATH"',
                `cd ${REPO_DIR}`,
                `mkdir -p ${GRAPH_DIR}`,
                cmd,
            ].join(' && '),
            { timeoutMs: TIMEOUTS.CONTEXT_MS },
        );

        if (result.exitCode !== 0) {
            throw new Error(
                `kodus-graph context failed (exit=${result.exitCode}): ${(result.stderr || '').slice(0, 500)}`,
            );
        }

        // Read the prompt file
        const readResult = await sandbox.commands.run(
            `cat ${REPO_DIR}/${PROMPT_PATH}`,
            { timeoutMs: 10_000 },
        );

        const prompt = readResult.stdout || '';
        if (!prompt) {
            this.logger.warn({
                message: `[KODUS-GRAPH] Step 4/4: prompt file is empty (context command succeeded but produced no output)`,
                context: KodusGraphService.name,
                metadata: {
                    stderr: (result.stderr || '').slice(0, 300),
                    stdout: (result.stdout || '').slice(0, 300),
                },
            });
        }

        return prompt;
    }
}
