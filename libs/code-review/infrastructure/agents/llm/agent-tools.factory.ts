import { tool } from 'ai';
import { z } from 'zod';
import { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';
import { DocumentationSearchAdapter } from '../tools/sandbox-tools';

export const MAX_GREP_MATCHES = 30;
export const MAX_READ_LENGTH = 30_000;
export const MAX_LIST_LENGTH = 15_000;
export const MAX_SHELL_OUTPUT = 15_000;

/**
 * Build the tool set for the agent from RemoteCommands.
 */
export function buildAgentTools(
    remoteCommands: RemoteCommands,
    docSearchService?: DocumentationSearchAdapter,
    docSearchOptions?: Record<string, unknown>,
): Record<string, any> {
    const tools: Record<string, any> = {
        grep: (tool as any)({
            description:
                'Search the repository for a regex pattern. Returns matching lines with file paths.',
            parameters: z.object({
                pattern: z.string().describe('Regex pattern to search for'),
                glob: z
                    .string()
                    .optional()
                    .describe('Optional glob to filter files (e.g. "*.ts")'),
                path: z
                    .string()
                    .optional()
                    .describe('Optional directory to scope the search'),
            }),
            execute: async (args: any) => {
                const pattern = args.pattern || args.regex || '';
                const glob = args.glob || args.include || undefined;
                const searchPath =
                    (args.path || args.directory || args.dir || '.').replace(
                        /^\/+/,
                        '',
                    ) || '.';
                if (!pattern) return 'Error: pattern is required';
                let result = await remoteCommands.grep(
                    pattern,
                    searchPath,
                    glob,
                );
                const lines = result.split('\n');
                if (lines.length > MAX_GREP_MATCHES) {
                    result =
                        lines.slice(0, MAX_GREP_MATCHES).join('\n') +
                        `\n... (${lines.length - MAX_GREP_MATCHES} more matches)`;
                }
                return result;
            },
        }),

        readFile: (tool as any)({
            description:
                'Read file contents. Use startLine/endLine for specific sections. Omit both for entire file.',
            parameters: z.object({
                path: z.string().describe('File path relative to repo root'),
                startLine: z
                    .number()
                    .optional()
                    .describe('Start line (1-based)'),
                endLine: z.number().optional().describe('End line (1-based)'),
            }),
            execute: async (args: any) => {
                // Tolerate models sending file/filePath instead of path
                let filePath: string =
                    args.path || args.filePath || args.file || '';
                const startLine = args.startLine || args.start_line || 0;
                const endLine = args.endLine || args.end_line || 0;
                // Strip leading slash — paths are relative to repo root
                filePath = filePath.replace(/^\/+/, '');
                if (!filePath) return 'Error: path is required';
                let result = await remoteCommands.read(
                    filePath,
                    startLine,
                    endLine,
                );
                if (result.length > MAX_READ_LENGTH) {
                    result =
                        result.substring(0, MAX_READ_LENGTH) +
                        `\n... (truncated)`;
                }
                return result;
            },
        }),

        listDir: (tool as any)({
            description:
                'List files and directories. Use maxDepth to control recursion (default 2).',
            parameters: z.object({
                path: z
                    .string()
                    .optional()
                    .describe('Directory path (default: ".")'),
                maxDepth: z
                    .number()
                    .optional()
                    .describe('Max recursion depth (default: 2, max: 4)'),
            }),
            execute: async (args: any) => {
                const dirPath =
                    (args.path || args.directory || args.dir || '.').replace(
                        /^\/+/,
                        '',
                    ) || '.';
                const depth = Math.min(args.maxDepth || args.max_depth || 2, 4);
                let result = await remoteCommands.listDir(dirPath, depth);
                if (result.length > MAX_LIST_LENGTH) {
                    result =
                        result.substring(0, MAX_LIST_LENGTH) +
                        `\n... (truncated)`;
                }
                return result;
            },
        }),
    };

    // Add exec-based tools if available
    if (remoteCommands.exec) {
        const exec = remoteCommands.exec;

        tools.shell = (tool as any)({
            description:
                'Execute a read-only shell command. Allowed: tsc, eslint, npx, python, go vet, cargo check.',
            parameters: z.object({
                command: z
                    .string()
                    .describe(
                        'Command to run (e.g. "npx tsc --noEmit src/file.ts")',
                    ),
            }),
            execute: async ({ command }: any) => {
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
        });
    }

    // Add searchDocs if available
    if (docSearchService) {
        tools.searchDocs = (tool as any)({
            description: 'Search external documentation for a package/library.',
            parameters: z.object({
                packageName: z
                    .string()
                    .describe('Package name (e.g. "express")'),
                query: z.string().describe('What to search for in docs'),
            }),
            execute: async ({ packageName, query }: any) => {
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
                        .map((d: any) => `### ${d.title}\n${d.url}\n${d.snippet}`)
                        .join('\n---\n');
                } catch (e) {
                    return `Doc search error: ${e instanceof Error ? e.message : String(e)}`;
                }
            },
        });
    }

    return tools;
}
