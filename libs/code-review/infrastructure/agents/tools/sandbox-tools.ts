import { z } from 'zod';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';

/**
 * Minimal interface for the documentation search capability.
 * Avoids importing DocumentationSearchExaService directly (which pulls in exa-js).
 */
export interface DocumentationSearchAdapter {
    searchByFilePlan(
        planByFile: Record<
            string,
            { queryTasks: Array<{ packageName: string; query: string }> }
        >,
        options?: Record<string, unknown>,
    ): Promise<
        Record<
            string,
            Array<{
                query: string;
                title: string;
                url: string;
                snippet: string;
                source: string;
            }>
        >
    >;
}

const MAX_GREP_MATCHES = 30;
const MAX_READ_LENGTH = 30_000;
const MAX_LIST_LENGTH = 15_000;
const MAX_SHELL_OUTPUT = 15_000;
const MAX_AST_GREP_MATCHES = 20;

/**
 * Registers sandbox-backed code exploration tools on an SDKOrchestrator.
 *
 * These tools wrap the RemoteCommands interface (grep/read/listDir) from
 * E2B sandbox and expose them as first-class tools for code review agents.
 */
export function registerSandboxTools(
    orchestration: SDKOrchestrator,
    remoteCommands: RemoteCommands,
): void {
    // grep — regex search across the codebase
    orchestration.createTool({
        name: 'grep',
        description:
            'Search the repository for a regex pattern. Returns matching lines with file paths. ' +
            'Use this to find usages, definitions, imports, or any code pattern across the codebase. ' +
            'Supports optional glob filtering (e.g. "*.ts" to search only TypeScript files) ' +
            'and path scoping (e.g. "src/services" to search only in that directory).',
        inputSchema: z.object({
            pattern: z
                .string()
                .describe(
                    'Regex pattern to search for (e.g. "functionName", "import.*lodash")',
                ),
            glob: z
                .string()
                .optional()
                .describe(
                    'Optional glob to filter files (e.g. "*.ts", "*.py", "src/**/*.tsx")',
                ),
            path: z
                .string()
                .optional()
                .describe(
                    'Optional directory path to scope the search (default: repository root)',
                ),
        }),
        execute: async (input: unknown) => {
            const { pattern, glob, path } = input as {
                pattern: string;
                glob?: string;
                path?: string;
            };
            let result = await remoteCommands.grep(pattern, path || '.', glob);
            const lines = result.split('\n');
            if (lines.length > MAX_GREP_MATCHES) {
                result =
                    lines.slice(0, MAX_GREP_MATCHES).join('\n') +
                    `\n... (${lines.length - MAX_GREP_MATCHES} more matches truncated)`;
            }
            return { result };
        },
        categories: ['code-exploration'],
    });

    // readFile — read file contents with optional line ranges
    orchestration.createTool({
        name: 'readFile',
        description:
            'Read the contents of a file from the repository. ' +
            'Use startLine and endLine to read specific sections of large files. ' +
            'Omit both to read the entire file. Line numbers are 1-based.',
        inputSchema: z.object({
            path: z.string().describe('File path relative to repository root'),
            startLine: z
                .number()
                .optional()
                .describe(
                    'Start line (1-based, inclusive). Omit to start from beginning.',
                ),
            endLine: z
                .number()
                .optional()
                .describe(
                    'End line (1-based, inclusive). Omit to read to end of file.',
                ),
        }),
        execute: async (input: unknown) => {
            const { path, startLine, endLine } = input as {
                path: string;
                startLine?: number;
                endLine?: number;
            };
            let result = await remoteCommands.read(
                path,
                startLine || 0,
                endLine || 0,
            );
            if (result.length > MAX_READ_LENGTH) {
                result =
                    result.substring(0, MAX_READ_LENGTH) +
                    `\n... (file truncated at ${MAX_READ_LENGTH} chars)`;
            }
            return { result };
        },
        categories: ['code-exploration'],
    });

    // listDir — list directory contents
    orchestration.createTool({
        name: 'listDir',
        description:
            'List files and directories at a given path. ' +
            'Use maxDepth to control how deep to recurse (default 2). ' +
            'Useful for understanding project structure before reading specific files.',
        inputSchema: z.object({
            path: z
                .string()
                .optional()
                .describe(
                    'Directory path relative to repository root (default: ".")',
                ),
            maxDepth: z
                .number()
                .optional()
                .describe('Maximum recursion depth (default: 2, max: 4)'),
        }),
        execute: async (input: unknown) => {
            const { path, maxDepth } = input as {
                path?: string;
                maxDepth?: number;
            };
            const depth = Math.min(maxDepth || 2, 4);
            let result = await remoteCommands.listDir(path || '.', depth);
            if (result.length > MAX_LIST_LENGTH) {
                result =
                    result.substring(0, MAX_LIST_LENGTH) +
                    `\n... (listing truncated at ${MAX_LIST_LENGTH} chars)`;
            }
            return { result };
        },
        categories: ['code-exploration'],
    });

    // Only register astGrep and shell if exec is available
    if (!remoteCommands.exec) {
        return;
    }

    const exec = remoteCommands.exec;

    // astGrep — structural code search via ast-grep CLI
    orchestration.createTool({
        name: 'astGrep',
        description:
            'Structural code search using ast-grep. Finds code patterns based on AST structure, ' +
            'not just text matching. More precise than regex grep for code patterns. ' +
            'Example patterns: "$VAR.map($FN)" finds all .map() calls, ' +
            '"if ($COND) { return $_ }" finds if-return patterns. ' +
            'Falls back to regular grep if ast-grep is not installed in the sandbox.',
        inputSchema: z.object({
            pattern: z
                .string()
                .describe(
                    'ast-grep pattern (e.g. "$VAR.map($FN)", "await $PROMISE", "catch ($ERR) { }")',
                ),
            lang: z
                .string()
                .describe(
                    'Language for AST parsing (e.g. "typescript", "javascript", "python", "go", "rust")',
                ),
            path: z
                .string()
                .optional()
                .describe(
                    'Optional directory to scope the search (default: repository root)',
                ),
        }),
        execute: async (input: unknown) => {
            const { pattern, lang, path } = input as {
                pattern: string;
                lang: string;
                path?: string;
            };
            try {
                const escapedPattern = pattern.replace(/'/g, "'\\''");
                const { stdout, exitCode } = await exec(
                    `sg --pattern '${escapedPattern}' --lang ${lang} ${path || '.'}`,
                );

                let result = stdout;

                // ast-grep not installed — fallback to regex grep
                if (
                    exitCode !== 0 &&
                    (result.includes('command not found') ||
                        result.includes('not found'))
                ) {
                    const fallbackPattern = pattern
                        .replace(/\$[A-Z_]+/g, '.*')
                        .replace(/[{}()]/g, '\\$&');
                    //TODO: Tá certo ter somente ts e js?
                    const langExt =
                        lang === 'typescript'
                            ? 'ts'
                            : lang === 'javascript'
                              ? 'js'
                              : lang;
                    result = await remoteCommands.grep(
                        fallbackPattern,
                        path || '.',
                        `*.${langExt}`,
                    );
                    result = `[ast-grep not available, used regex fallback]\n${result}`;
                }

                const lines = result.split('\n');
                if (lines.length > MAX_AST_GREP_MATCHES) {
                    result =
                        lines.slice(0, MAX_AST_GREP_MATCHES).join('\n') +
                        `\n... (${lines.length - MAX_AST_GREP_MATCHES} more matches truncated)`;
                }
                return { result };
            } catch (error) {
                return {
                    result: `astGrep error: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        },
        categories: ['code-exploration'],
    });

    // shell — run read-only commands (linters, type checkers) in the sandbox
    orchestration.createTool({
        name: 'shell',
        description:
            'Execute a read-only shell command in the repository sandbox. ' +
            'Allowed commands: tsc (TypeScript compiler check), eslint, ' +
            'python -m py_compile, go vet, cargo check. ' +
            'Use this to verify if code compiles or has linting errors. ' +
            'Commands that modify files or the filesystem are NOT allowed.',
        inputSchema: z.object({
            command: z
                .string()
                .describe(
                    'Shell command to run (e.g. "npx tsc --noEmit src/file.ts", "npx eslint src/file.ts")',
                ),
        }),
        execute: async (input: unknown) => {
            const { command } = input as { command: string };

            const ALLOWED_PREFIXES = [
                'tsc ',
                'npx tsc ',
                'npx eslint ',
                'eslint ',
                'python -m py_compile ',
                'python3 -m py_compile ',
                'go vet ',
                'cargo check ',
                'npx prettier --check ',
                'cat ',
                'wc ',
                'head ',
                'tail ',
                'file ',
            ];

            const isAllowed = ALLOWED_PREFIXES.some((prefix) =>
                command.trimStart().startsWith(prefix),
            );

            if (!isAllowed) {
                return {
                    result: `Command not allowed. Only read-only analysis commands are permitted: ${ALLOWED_PREFIXES.map((p) => p.trim()).join(', ')}`,
                };
            }

            const BLOCKED_PATTERNS = [
                /[;&|`$]/,
                /\brm\b/,
                /\bmv\b/,
                /\bcp\b/,
                />/,
                /\bsudo\b/,
                /\bcurl\b/,
                /\bwget\b/,
            ];

            if (BLOCKED_PATTERNS.some((p) => p.test(command))) {
                return {
                    result: `Command contains blocked patterns. Shell injection attempts are not allowed.`,
                };
            }

            try {
                const { stdout } = await exec(command);
                let result = stdout;
                if (result.length > MAX_SHELL_OUTPUT) {
                    result =
                        result.substring(0, MAX_SHELL_OUTPUT) +
                        `\n... (output truncated at ${MAX_SHELL_OUTPUT} chars)`;
                }
                return { result };
            } catch (error) {
                return {
                    result: `Shell error: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        },
        categories: ['analysis'],
    });
}

/**
 * Registers the searchDocs tool that uses the Exa documentation search service.
 * Separated from sandbox tools because it requires a service dependency.
 */
export function registerSearchDocsTool(
    orchestration: SDKOrchestrator,
    documentationSearchService: DocumentationSearchAdapter,
    options?: Record<string, unknown>,
): void {
    orchestration.createTool({
        name: 'searchDocs',
        description:
            'Search external documentation for a specific package or library. ' +
            'Returns official documentation snippets. Use this when you need to verify ' +
            'how a library API works, check correct usage patterns, or confirm if ' +
            'a function behaves as the code assumes. ' +
            'Example: searchDocs("express", "middleware error handling")',
        inputSchema: z.object({
            packageName: z
                .string()
                .describe(
                    'Package/library name (e.g. "express", "react", "@nestjs/common", "lodash")',
                ),
            query: z
                .string()
                .describe(
                    'What to search for in the docs (e.g. "error middleware", "useEffect cleanup", "debounce options")',
                ),
        }),
        execute: async (input: unknown) => {
            const { packageName, query } = input as {
                packageName: string;
                query: string;
            };

            if (!packageName || !query) {
                return {
                    result: 'Both packageName and query are required.',
                };
            }

            try {
                const planByFile = {
                    agent: {
                        queryTasks: [{ packageName, query }],
                    },
                };

                const results =
                    await documentationSearchService.searchByFilePlan(
                        planByFile,
                        options,
                    );

                const docs = results['agent'] || [];
                if (docs.length === 0) {
                    return {
                        result: `No documentation found for "${packageName}" with query "${query}".`,
                    };
                }

                const formatted = docs
                    .map(
                        (doc) =>
                            `### ${doc.title}\n**URL:** ${doc.url}\n**Query:** ${doc.query}\n\n${doc.snippet}`,
                    )
                    .join('\n\n---\n\n');

                return { result: formatted };
            } catch (error) {
                return {
                    result: `Documentation search error: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        },
        categories: ['documentation'],
    });
}
