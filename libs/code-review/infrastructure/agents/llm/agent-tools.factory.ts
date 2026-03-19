import { jsonSchema } from 'ai';
import { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';
import { DocumentationSearchAdapter } from '../tools/sandbox-tools';

export const MAX_GREP_MATCHES = 30;
export const MAX_READ_LENGTH = 30_000;
export const MAX_LIST_LENGTH = 15_000;
export const MAX_SHELL_OUTPUT = 15_000;

/**
 * Create a tool definition compatible with all AI SDK providers (including Anthropic).
 *
 * Uses `type: 'function'` + `inputSchema` with raw JSON Schema instead of Zod,
 * because Zod v4 + zod-to-json-schema is broken — it generates empty schemas
 * that Anthropic API rejects with "input_schema.type: Field required".
 */
function mkTool(
    desc: string,
    schema: Record<string, any>,
    exec: (args: any) => Promise<string>,
) {
    return {
        type: 'function' as const,
        description: desc,
        inputSchema: jsonSchema(schema),
        execute: exec,
    };
}

/**
 * Build the tool set for the agent from RemoteCommands.
 */
export function buildAgentTools(
    remoteCommands: RemoteCommands,
    docSearchService?: DocumentationSearchAdapter,
    docSearchOptions?: Record<string, unknown>,
): Record<string, any> {
    const tools: Record<string, any> = {
        grep: mkTool(
            'Search the repository for a regex pattern. Returns matching lines with file paths.',
            {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description: 'Regex pattern to search for',
                    },
                    glob: {
                        type: 'string',
                        description:
                            'Optional glob to filter files (e.g. "*.ts")',
                    },
                    path: {
                        type: 'string',
                        description:
                            'Optional directory to scope the search',
                    },
                },
                required: ['pattern'],
            },
            async (args: any) => {
                const pattern = args.pattern || args.regex || '';
                const glob = args.glob || args.include || undefined;
                const searchPath =
                    (
                        args.path ||
                        args.directory ||
                        args.dir ||
                        '.'
                    ).replace(/^\/+/, '') || '.';
                if (!pattern) return 'Error: pattern is required';
                let result: string;
                try {
                    result = await remoteCommands.grep(
                        pattern,
                        searchPath,
                        glob,
                    );
                } catch (err) {
                    return `Error searching for "${pattern}": ${err instanceof Error ? err.message : String(err)}`;
                }
                const lines = result.split('\n');
                if (lines.length > MAX_GREP_MATCHES) {
                    result =
                        lines.slice(0, MAX_GREP_MATCHES).join('\n') +
                        `\n... (${lines.length - MAX_GREP_MATCHES} more matches)`;
                }
                return result;
            },
        ),

        readFile: mkTool(
            'Read file contents. Prefer reading specific sections with startLine/endLine to save context. Only read entire file if you need to understand the full structure.',
            {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path relative to repo root',
                    },
                    startLine: {
                        type: 'number',
                        description:
                            'Start line (1-based). Use this to read around the changed lines (e.g. 50 lines before/after the diff)',
                    },
                    endLine: {
                        type: 'number',
                        description: 'End line (1-based)',
                    },
                },
                required: ['path'],
            },
            async (args: any) => {
                // Tolerate models sending file/filePath instead of path
                let filePath: string =
                    args.path || args.filePath || args.file || '';
                const startLine = args.startLine || args.start_line || 0;
                const endLine = args.endLine || args.end_line || 0;
                // Strip leading slash — paths are relative to repo root
                filePath = filePath.replace(/^\/+/, '');
                if (!filePath) return 'Error: path is required';
                let result: string;
                try {
                    result = await remoteCommands.read(
                        filePath,
                        startLine,
                        endLine,
                    );
                } catch (err) {
                    return `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
                }
                if (!result && result !== '') {
                    return `Error: readFile returned ${typeof result} for ${filePath}`;
                }
                if (result.length > MAX_READ_LENGTH) {
                    const lines = result.split('\n');
                    result =
                        result.substring(0, MAX_READ_LENGTH) +
                        `\n... (truncated — showing ${MAX_READ_LENGTH} chars of ${result.length}. File has ~${lines.length} lines. Use startLine/endLine to read specific sections.)`;
                }
                return result;
            },
        ),

        listDir: mkTool(
            'List files and directories. Use maxDepth to control recursion (default 2).',
            {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory path (default: ".")',
                    },
                    maxDepth: {
                        type: 'number',
                        description:
                            'Max recursion depth (default: 2, max: 4)',
                    },
                },
            },
            async (args: any) => {
                const dirPath =
                    (
                        args.path ||
                        args.directory ||
                        args.dir ||
                        '.'
                    ).replace(/^\/+/, '') || '.';
                const depth = Math.min(
                    args.maxDepth || args.max_depth || 2,
                    4,
                );
                let result = await remoteCommands.listDir(dirPath, depth);
                if (result.length > MAX_LIST_LENGTH) {
                    result =
                        result.substring(0, MAX_LIST_LENGTH) +
                        `\n... (truncated)`;
                }
                return result;
            },
        ),

        findFile: mkTool(
            'Find files by name or glob pattern. Use this to locate files before reading them.',
            {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description:
                            'File name or glob pattern (e.g. "config.ts", "*.test.go", "schema")',
                    },
                    path: {
                        type: 'string',
                        description:
                            'Directory to search in (default: ".")',
                    },
                    extension: {
                        type: 'string',
                        description:
                            'Filter by extension (e.g. "ts", "go", "rb")',
                    },
                },
                required: ['pattern'],
            },
            async (args: any) => {
                const pattern = args.pattern || '';
                if (!pattern) return 'Error: pattern is required';
                const searchPath =
                    (args.path || '.').replace(/^\/+/, '') || '.';
                const ext = args.extension || args.ext || '';
                const safePattern = pattern.replace(/'/g, "'\\''");
                const safePath = searchPath.replace(/'/g, "'\\''");
                const extArg = ext ? ` -e '${ext}'` : '';

                try {
                    // Try fd first (fast, .gitignore aware), then find as fallback
                    if (remoteCommands.exec) {
                        // Try fd
                        try {
                            const fdCmd = `fd ${safePattern}${extArg} ${safePath} --type f --max-results 30`;
                            const { stdout } = await remoteCommands.exec(fdCmd);
                            if (stdout && stdout.trim()) return stdout.trim();
                        } catch {
                            // fd not available, try find
                        }
                        // Fallback to find
                        try {
                            const cleanPattern = safePattern.replace(/[*?[\]]/g, '');
                            const findCmd = `find ${safePath} -type f -iname *${cleanPattern}*`;
                            const { stdout } = await remoteCommands.exec(findCmd);
                            if (stdout && stdout.trim()) {
                                const lines = stdout.trim().split('\n');
                                return lines.slice(0, 30).join('\n');
                            }
                        } catch {
                            // find also failed, fall through to listDir
                        }
                    }

                    // Fallback: listDir + filter (slower, no .gitignore)
                    const allFiles = await remoteCommands.listDir(
                        searchPath,
                        4,
                    );
                    const matching = allFiles
                        .split('\n')
                        .filter(
                            (f: string) =>
                                f.trim() &&
                                f.toLowerCase().includes(
                                    pattern.toLowerCase(),
                                ) &&
                                (!ext || f.endsWith(`.${ext}`)),
                        );
                    if (matching.length === 0)
                        return `No files matching "${pattern}" in ${searchPath}`;
                    if (matching.length > 30) {
                        return (
                            matching.slice(0, 30).join('\n') +
                            `\n... (${matching.length - 30} more files)`
                        );
                    }
                    return matching.join('\n');
                } catch (err) {
                    return `Error finding files: ${err instanceof Error ? err.message : String(err)}`;
                }
            },
        ),
    };

    // Add exec-based tools if available
    if (remoteCommands.exec) {
        const exec = remoteCommands.exec;

        tools.shell = mkTool(
            'Execute a read-only shell command. Allowed: tsc, eslint, npx, python, go vet, cargo check.',
            {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description:
                            'Command to run (e.g. "npx tsc --noEmit src/file.ts")',
                    },
                },
                required: ['command'],
            },
            async ({ command }: any) => {
                const ALLOWED = [
                    'tsc ',
                    'npx ',
                    'eslint ',
                    'python ',
                    'python3 ',
                    'go ',
                    'cargo ',
                    'cat ',
                    'wc ',
                    'head ',
                    'tail ',
                    'file ',
                ];
                const isAllowed = ALLOWED.some((p) =>
                    command.trimStart().startsWith(p),
                );
                if (!isAllowed) {
                    return `Command not allowed. Allowed prefixes: ${ALLOWED.join(', ')}`;
                }
                if (/[;&|`$>]|\brm\b|\bsudo\b/.test(command)) {
                    return 'Command contains blocked patterns.';
                }
                const { stdout } = await exec(command);
                return stdout.length > MAX_SHELL_OUTPUT
                    ? stdout.substring(0, MAX_SHELL_OUTPUT) +
                          '\n... (truncated)'
                    : stdout;
            },
        );
    }

    // Add searchDocs if available
    if (docSearchService) {
        tools.searchDocs = mkTool(
            'Search external documentation for a package/library.',
            {
                type: 'object',
                properties: {
                    packageName: {
                        type: 'string',
                        description: 'Package name (e.g. "express")',
                    },
                    query: {
                        type: 'string',
                        description: 'What to search for in docs',
                    },
                },
                required: ['packageName', 'query'],
            },
            async ({ packageName, query }: any) => {
                if (!packageName || !query)
                    return 'Both packageName and query are required.';
                try {
                    const results = await docSearchService.searchByFilePlan(
                        { agent: { queryTasks: [{ packageName, query }] } },
                        docSearchOptions,
                    );
                    const docs = results['agent'] || [];
                    if (docs.length === 0)
                        return `No docs found for "${packageName}": ${query}`;
                    return docs
                        .map(
                            (d: any) =>
                                `### ${d.title}\n${d.url}\n${d.snippet}`,
                        )
                        .join('\n---\n');
                } catch (e) {
                    return `Doc search error: ${e instanceof Error ? e.message : String(e)}`;
                }
            },
        );
    }

    return tools;
}
