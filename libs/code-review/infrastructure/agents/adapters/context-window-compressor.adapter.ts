/**
 * code-review (domain) — adapter from the existing context-compressor to the
 * agent-harness Compressor port. Closes the compression gap so large PRs don't
 * risk context overflow on the new harness.
 *
 * Maps the core's AgentMessage <-> AI SDK ModelMessage and reuses the
 * battle-tested shouldCompress/compressMessages. The investigation recap
 * (allToolCalls) is not threaded yet — passes [] (weaker recap, still
 * functional); a later step can wire the live tool-call history.
 */
import type { ModelMessage } from 'ai';

import type {
    Compressor,
    CompressionResult,
} from '@libs/agent-harness/domain/contracts/compression.contract';
import type { AgentMessage } from '@libs/agent-harness/domain/contracts/run-state.contract';

import {
    compressMessages,
    estimateMessagesTokens,
    shouldCompress,
} from '../llm/context-compressor';

export class ContextWindowCompressor implements Compressor {
    constructor(private readonly contextWindowTokens: number) {}

    maybeCompress(
        messages: readonly AgentMessage[],
    ): CompressionResult | null {
        if (!this.contextWindowTokens || this.contextWindowTokens <= 0) {
            return null;
        }
        const modelMsgs: ModelMessage[] = messages.map(
            (m) => ({ role: m.role, content: m.content }) as ModelMessage,
        );
        const check = shouldCompress(modelMsgs, this.contextWindowTokens);
        if (!check.should) return null;

        const compressed = compressMessages(modelMsgs, []);
        const after = estimateMessagesTokens(compressed);
        if (after >= check.currentTokens) return null; // no real savings

        return {
            messages: compressed.map((m) => ({
                role: m.role as AgentMessage['role'],
                content:
                    typeof m.content === 'string'
                        ? m.content
                        : JSON.stringify(m.content),
            })),
            beforeTokens: check.currentTokens,
            afterTokens: after,
        };
    }
}
