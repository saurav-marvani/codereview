/**
 * code-review (domain) — adapts the existing finder tools (grep/readFile/
 * listDir/getCallers/checkTypes/searchDocs) to the agent-harness AgentTool port,
 * returning a ToolRegistry the new runner can consume.
 *
 * Reuses buildAgentTools verbatim (no tool logic rewritten). The mapping:
 *  - recovers the raw JSON schema from the AI SDK jsonSchema() wrapper
 *  - wraps execute(args) -> Promise<string> into execute(input,ctx) ->
 *    ToolResult, turning thrown errors into {isError:true} values so the
 *    loop can recover instead of crashing.
 *
 * NOTE: the legacy tools read `remoteCommands` from a closure, not from the
 * ToolContext — so for now the registry is built per-run with the sandbox
 * already bound. A later step can move sandbox access into ToolContext.services.
 */
import type {
    AgentTool,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import {
    buildAgentTools,
    type DocumentationSearchAdapter,
} from '../llm/agent-tools.factory';
import type { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';

/** Recover the raw JSON schema from whatever buildAgentTools produced
 *  (AI SDK jsonSchema() wrapper exposes `.jsonSchema`; fall back to as-is). */
function rawSchema(inputSchema: any): JSONSchema {
    if (
        inputSchema &&
        typeof inputSchema === 'object' &&
        inputSchema.jsonSchema
    ) {
        return inputSchema.jsonSchema as JSONSchema;
    }
    return (inputSchema ?? { type: 'object', properties: {} }) as JSONSchema;
}

/** Named options for the finder tool registry — same fields buildAgentTools
 *  takes positionally, but callers pass only what they need instead of
 *  threading `undefined` placeholders. */
export interface FinderToolRegistryOptions {
    remoteCommands: RemoteCommands | undefined;
    gitHubToken?: string;
    repositoryFullName?: string;
    documentationSearchService?: DocumentationSearchAdapter;
    documentationSearchOptions?: Record<string, unknown>;
    callGraph?: string;
}

export function buildFinderToolRegistry(
    options: FinderToolRegistryOptions,
): ToolRegistry {
    const raw = buildAgentTools(
        options.remoteCommands,
        options.gitHubToken,
        options.repositoryFullName,
        options.documentationSearchService,
        options.documentationSearchOptions,
        options.callGraph,
    );

    const tools: AgentTool[] = Object.entries(raw).map(
        ([name, def]: [string, any]) => ({
            name,
            description: def.description,
            inputSchema: rawSchema(def.inputSchema),
            async execute(input) {
                try {
                    const out = await def.execute(input);
                    return {
                        output: typeof out === 'string' ? out : String(out),
                    };
                } catch (err: any) {
                    return {
                        output: err?.message
                            ? String(err.message)
                            : String(err),
                        isError: true,
                    };
                }
            },
        }),
    );

    return new InMemoryToolRegistry(tools);
}
