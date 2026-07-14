/**
 * agent-harness — canonical Compressor: adapts the token-window context
 * compressor to the harness Compressor port. Closes the compression gap so a
 * long agentic run (large PR review, or a skill fetcher gathering lots of
 * context) doesn't risk context overflow. Generic across consumers — both
 * code-review and the skills fetcher plug this in via CompressionPolicy.
 *
 * Maps the harness AgentMessage <-> AI SDK ModelMessage and reuses the
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
} from './context-compressor';

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
            // Return content as-is: compressMessages already truncated the
            // tool-result text while preserving the parts structure. Stringifying
            // here would re-flatten `tool` turns and crash the SDK on
            // `content.filter` when this window is handed back to generateText.
            messages: compressed.map((m) => ({
                role: m.role as AgentMessage['role'],
                content: m.content as AgentMessage['content'],
            })),
            beforeTokens: check.currentTokens,
            afterTokens: after,
        };
    }
}
