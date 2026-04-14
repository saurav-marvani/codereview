import { createLogger } from '@kodus/flow';
import { PlatformType } from '@libs/core/domain/enums';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec, execFile, ExecFileOptions } from 'child_process';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import {
    CreateSandboxParams,
    ISandboxProvider,
    SandboxInstance,
    SandboxRunResult,
} from '@libs/code-review/domain/contracts/sandbox.provider';
import { RemoteCommands } from './collectCrossFileContexts.service';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 120_000;
const CMD_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 5 * 1024 * 1024; // 5 MB — cap output to prevent memory issues

@Injectable()
export class LocalSandboxService implements ISandboxProvider {
    private readonly logger = createLogger(LocalSandboxService.name);

    constructor(private readonly configService: ConfigService) {}

    isAvailable(): boolean {
        return this.configService.get<string>('SANDBOX_PROVIDER') === 'local';
    }

    async createSandboxWithRepo(
        params: CreateSandboxParams,
    ): Promise<SandboxInstance> {
        const {
            cloneUrl,
            authToken,
            authUsername,
            branch,
            prNumber,
            platform,
        } = params;

        const tempDir = await mkdtemp(join(tmpdir(), 'kodus-sandbox-'));

        try {
            const authHeader = this.buildAuthHeader(
                platform,
                authToken,
                authUsername,
            );
            const refspec =
                prNumber != null
                    ? this.getPrRefspec(platform, prNumber)
                    : `refs/heads/${branch}`;
            const localRef = prNumber != null ? 'pr-head' : 'cli-head';

            await execFileAsync('git', ['init', tempDir], {
                timeout: CLONE_TIMEOUT_MS,
            });

            // Disable all git hooks to prevent arbitrary code execution
            // from untrusted repos (post-checkout, post-merge, etc.)
            await execFileAsync(
                'git',
                ['-C', tempDir, 'config', 'core.hooksPath', '/dev/null'],
                { timeout: 5_000 },
            );

            // Pass auth header via env vars instead of -c args
            // to keep the token out of ps/proc/cmdline
            const fetchEnv: Record<string, string> = { ...process.env } as any;
            if (authToken) {
                fetchEnv.GIT_CONFIG_COUNT = '1';
                fetchEnv.GIT_CONFIG_KEY_0 = 'http.extraHeader';
                fetchEnv.GIT_CONFIG_VALUE_0 = authHeader;
            }

            await execFileAsync(
                'git',
                [
                    '-C',
                    tempDir,
                    'fetch',
                    '--depth=1',
                    cloneUrl,
                    `${refspec}:${localRef}`,
                ],
                {
                    timeout: CLONE_TIMEOUT_MS,
                    env: fetchEnv,
                } as ExecFileOptions,
            );

            await execFileAsync('git', ['-C', tempDir, 'checkout', localRef], {
                timeout: CLONE_TIMEOUT_MS,
            });

            const remoteCommands = this.buildRemoteCommands(tempDir);

            const capturedTempDir = tempDir;
            const cleanup = async () => {
                try {
                    await rm(capturedTempDir, { recursive: true, force: true });
                } catch (error) {
                    this.logger.warn({
                        message: `Failed to remove temp dir ${capturedTempDir}`,
                        context: LocalSandboxService.name,
                        error,
                    });
                }
            };

            const capturedRepoDir = tempDir;

            const run = async (command: string, opts?: { timeoutMs?: number }): Promise<SandboxRunResult> => {
                const execAsync = promisify(exec);
                try {
                    const { stdout, stderr } = await execAsync(command, {
                        cwd: capturedRepoDir,
                        timeout: opts?.timeoutMs ?? CMD_TIMEOUT_MS,
                        maxBuffer: MAX_BUFFER,
                        env: process.env as Record<string, string>,
                    });
                    return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
                } catch (error: any) {
                    return {
                        stdout: error.stdout || '',
                        stderr: error.stderr || '',
                        exitCode: error.code ?? 1,
                    };
                }
            };

            const sandboxReadFile = async (path: string): Promise<string> => {
                const fullPath = path.startsWith('/') ? path : join(capturedRepoDir, path);
                return readFile(fullPath, 'utf-8');
            };

            const sandboxWriteFile = async (path: string, content: string): Promise<void> => {
                const fullPath = path.startsWith('/') ? path : join(capturedRepoDir, path);
                const dir = join(fullPath, '..');
                await mkdir(dir, { recursive: true });
                await writeFile(fullPath, content, 'utf-8');
            };

            return {
                remoteCommands,
                cleanup,
                type: 'local' as const,
                repoDir: capturedRepoDir,
                run,
                readFile: sandboxReadFile,
                writeFile: sandboxWriteFile,
            };
        } catch (error) {
            try {
                await rm(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
            throw error;
        }
    }

    private buildRemoteCommands(repoDir: string): RemoteCommands {
        return {
            grep: async (
                pattern: string,
                path: string,
                glob?: string,
            ): Promise<string> => {
                await this.resolveSafePath(repoDir, path);

                // rg with --no-follow ensures symlinks are not followed during search.
                // cwd = repoDir so rg outputs relative paths (downstream expects "./src/foo.ts")
                const args = [
                    '--no-heading',
                    '-n',
                    '--no-follow',
                    pattern,
                    path,
                ];
                if (glob) {
                    args.push('--glob', glob);
                }

                try {
                    const { stdout } = await execFileAsync('rg', args, {
                        cwd: repoDir,
                        timeout: CMD_TIMEOUT_MS,
                        maxBuffer: MAX_BUFFER,
                    });
                    return stdout;
                } catch (error: any) {
                    // rg exits with code 1 when no matches found
                    if (error.code === 1) return '';
                    throw error;
                }
            },

            read: async (
                path: string,
                start: number,
                end: number,
            ): Promise<string> => {
                const safePath = await this.resolveSafePath(repoDir, path);
                // When start=0 and end=0, read the entire file (cat).
                // GNU sed rejects address 0 so we must avoid `sed -n '0,0p'`.
                if (start === 0 && end === 0) {
                    const { stdout } = await execFileAsync('cat', [safePath], {
                        timeout: CMD_TIMEOUT_MS,
                        maxBuffer: MAX_BUFFER,
                    });
                    return stdout;
                }
                const { stdout } = await execFileAsync(
                    'sed',
                    ['-n', `${start < 1 ? 1 : start},${end}p`, safePath],
                    { timeout: CMD_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
                );
                return stdout;
            },

            listDir: async (
                path: string,
                maxDepth: number,
            ): Promise<string> => {
                await this.resolveSafePath(repoDir, path);
                // Use relative path with cwd so output paths are relative (consistent with grep)
                // -not -type l excludes symlinks from results
                const { stdout } = await execFileAsync(
                    'find',
                    [
                        path,
                        '-maxdepth',
                        String(maxDepth),
                        '-type',
                        'f',
                        '-not',
                        '-type',
                        'l',
                    ],
                    {
                        cwd: repoDir,
                        timeout: CMD_TIMEOUT_MS,
                        maxBuffer: MAX_BUFFER,
                    },
                );
                return stdout;
            },

            exec: async (
                command: string,
            ): Promise<{ stdout: string; exitCode: number }> => {
                // Strict whitelist — only allow known read-only programs.
                // This runs on the host machine (no container isolation),
                // so we must prevent arbitrary command execution.
                const ALLOWED_PROGRAMS = new Set([
                    'sg', // ast-grep (macOS/homebrew)
                    'ast-grep', // ast-grep (npm global)
                    'tsc', // TypeScript compiler
                    'npx', // npx (further validated by tool-level whitelist)
                    'eslint',
                    'python',
                    'python3',
                    'go',
                    'cargo',
                    'cat',
                    'wc',
                    'head',
                    'tail',
                    'file',
                    'fd', // fast file finder (respects .gitignore)
                    'find', // fallback file finder
                ]);

                // Split command into program + args for execFile (no shell interpretation)
                const parts =
                    command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
                if (parts.length === 0) {
                    return { stdout: '', exitCode: 1 };
                }
                const [program, ...args] = parts.map((p) =>
                    p.replace(/^['"]|['"]$/g, ''),
                );

                if (!ALLOWED_PROGRAMS.has(program)) {
                    return {
                        stdout: `Program "${program}" is not allowed in local sandbox. Allowed: ${[...ALLOWED_PROGRAMS].join(', ')}`,
                        exitCode: 1,
                    };
                }

                // Block path traversal in positional arguments only.
                // Skip flags (--xxx) and their values (the arg right after a flag).
                const positionalArgs: string[] = [];
                for (let i = 0; i < args.length; i++) {
                    if (args[i].startsWith('-')) {
                        // Flag — skip its value too (e.g. --pattern '$A..$B')
                        i++;
                        continue;
                    }
                    positionalArgs.push(args[i]);
                }
                // Check for path traversal: ".." as a path segment (not substring).
                // Matches: "../x", "a/../../b", ".." alone — but NOT "./..." (Go idiom)
                const hasTraversal = positionalArgs.some(
                    (a) => a.startsWith('/') || /(^|\/)\.\.($|\/)/.test(a),
                );
                if (hasTraversal) {
                    return {
                        stdout: 'Arguments with path traversal (..) or absolute paths are not allowed.',
                        exitCode: 1,
                    };
                }

                try {
                    const { stdout, stderr } = await execFileAsync(
                        program,
                        args,
                        {
                            cwd: repoDir,
                            timeout: CMD_TIMEOUT_MS,
                            maxBuffer: MAX_BUFFER,
                        },
                    );
                    return { stdout: stdout + (stderr || ''), exitCode: 0 };
                } catch (error: any) {
                    return {
                        stdout: (error.stdout || '') + (error.stderr || ''),
                        exitCode: error.code ?? 1,
                    };
                }
            },
        };
    }

    private validatePath(path: string): void {
        if (path.startsWith('/')) {
            throw new Error('Absolute paths are not allowed');
        }
        if (path.includes('..')) {
            throw new Error('Path traversal using ".." is not allowed');
        }
    }

    /**
     * Resolve a relative path within the repo, ensuring the real path
     * stays inside repoDir (prevents symlink escapes).
     */
    private async resolveSafePath(
        repoDir: string,
        path: string,
    ): Promise<string> {
        this.validatePath(path);
        const candidate = join(repoDir, path);

        // Check if the target itself is a symlink before resolving
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink()) {
            throw new Error(`Symlink detected, refusing to follow: ${path}`);
        }

        // Resolve to real path and verify it's still under repoDir
        const real = await realpath(candidate);
        const repoReal = await realpath(repoDir);
        if (!real.startsWith(repoReal + '/') && real !== repoReal) {
            throw new Error(`Path escapes repo boundary: ${path}`);
        }

        return candidate;
    }

    private buildAuthHeader(
        platform: PlatformType,
        token: string,
        username?: string,
    ): string {
        switch (platform) {
            case PlatformType.GITHUB:
                return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
            case PlatformType.BITBUCKET:
                // Bitbucket App Passwords require the actual username, not x-access-token
                if (!username) {
                    throw new Error(
                        'Bitbucket authentication requires a username, but it was not provided.',
                    );
                }
                return `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
            case PlatformType.GITLAB:
            case PlatformType.AZURE_REPOS:
                return `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
            default:
                return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
        }
    }

    private getPrRefspec(platform: PlatformType, prNumber: number): string {
        switch (platform) {
            case PlatformType.GITHUB:
                return `refs/pull/${prNumber}/head`;
            case PlatformType.GITLAB:
                return `refs/merge-requests/${prNumber}/head`;
            case PlatformType.BITBUCKET:
                return `refs/pull-requests/${prNumber}/from`;
            case PlatformType.AZURE_REPOS:
                return `refs/pull/${prNumber}/merge`;
            default:
                return `refs/pull/${prNumber}/head`;
        }
    }
}
