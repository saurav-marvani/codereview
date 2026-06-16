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

import { buildAgentTools } from '../llm/agent-tools.factory';

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

export function buildFinderToolRegistry(
    ...args: Parameters<typeof buildAgentTools>
): ToolRegistry {
    const raw = buildAgentTools(...args);

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
