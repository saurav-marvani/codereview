import {
    deriveTu,
    GEMINI_TIER_THRESHOLD,
    SYSTEM_RUN_NAMES,
} from './token-usage-tu';

/**
 * `deriveTu` is the single source of the `attributes.tu` sub-doc mirrored onto
 * every LLM-usage span. It must be a faithful, pure function of the same span
 * attributes the Token Usage read pipeline consumes — otherwise the covered
 * aggregation would report different numbers than the legacy $getField path.
 */
describe('deriveTu', () => {
    const usage = {
        'gen_ai.usage.total_tokens': 11921,
        'gen_ai.usage.input_tokens': 8757,
        'gen_ai.usage.output_tokens': 1131,
        'gen_ai.usage.reasoning_tokens': 1860,
        'gen_ai.usage.cache_read_input_tokens': 2721,
        'gen_ai.usage.cache_creation_input_tokens': 2792,
        'gen_ai.response.model': 'claude-sonnet-5',
    };

    it('returns null for spans without LLM usage', () => {
        expect(deriveTu(undefined)).toBeNull();
        expect(deriveTu(null)).toBeNull();
        expect(deriveTu({})).toBeNull();
        expect(deriveTu({ 'gen_ai.usage.total_tokens': 0 })).toBeNull();
        expect(
            deriveTu({ 'gen_ai.response.model': 'x' } as any),
        ).toBeNull();
    });

    it('mirrors token counts verbatim, defaulting missing fields to 0', () => {
        const tu = deriveTu({
            'gen_ai.usage.total_tokens': 100,
            'gen_ai.usage.input_tokens': 60,
            'gen_ai.response.model': 'claude-sonnet-5',
        })!;
        expect(tu.total).toBe(100);
        expect(tu.input).toBe(60);
        expect(tu.output).toBe(0);
        expect(tu.reasoning).toBe(0);
        expect(tu.cacheRead).toBe(0);
        expect(tu.cacheWrite).toBe(0);
    });

    it('copies every token field when present', () => {
        const tu = deriveTu(usage)!;
        expect(tu).toMatchObject({
            input: 8757,
            output: 1131,
            total: 11921,
            reasoning: 1860,
            cacheRead: 2721,
            cacheWrite: 2792,
        });
    });

    it('canonicalizes the model to the last ":"-segment', () => {
        expect(
            deriveTu({ ...usage, 'gen_ai.response.model': 'google_gemini:gemini-2.5-pro' })!
                .model,
        ).toBe('gemini-2.5-pro');
        expect(
            deriveTu({ ...usage, 'gen_ai.response.model': 'openai:gpt-5' })!.model,
        ).toBe('gpt-5');
        // bare name (no provider prefix) is unchanged
        expect(deriveTu(usage)!.model).toBe('claude-sonnet-5');
    });

    describe('byok view flags', () => {
        it('isByok reflects attributes.type === "byok"', () => {
            expect(deriveTu({ ...usage, type: 'byok' })!.isByok).toBe(true);
            expect(deriveTu({ ...usage, type: 'system' })!.isByok).toBe(false);
            expect(deriveTu(usage)!.isByok).toBe(false);
        });

        it('sys is true only for the internal system-analysis run-names', () => {
            for (const name of SYSTEM_RUN_NAMES) {
                expect(
                    deriveTu({ ...usage, 'gen_ai.run.name': name })!.sys,
                ).toBe(true);
            }
            expect(
                deriveTu({ ...usage, 'gen_ai.run.name': 'code-review-security' })!
                    .sys,
            ).toBe(false);
            expect(deriveTu(usage)!.sys).toBe(false);
        });
    });

    describe('tier bucketing', () => {
        it('flags gt only for Gemini above the input threshold', () => {
            const gem = 'google_gemini:gemini-2.5-pro';
            expect(
                deriveTu({
                    ...usage,
                    'gen_ai.response.model': gem,
                    'gen_ai.usage.input_tokens': GEMINI_TIER_THRESHOLD + 1,
                })!.tier,
            ).toBe('gt');
            expect(
                deriveTu({
                    ...usage,
                    'gen_ai.response.model': gem,
                    'gen_ai.usage.input_tokens': GEMINI_TIER_THRESHOLD,
                })!.tier,
            ).toBe('le');
        });

        it('never flags gt for non-Gemini models regardless of size', () => {
            expect(
                deriveTu({
                    ...usage,
                    'gen_ai.response.model': 'openai:gpt-5',
                    'gen_ai.usage.input_tokens': GEMINI_TIER_THRESHOLD * 10,
                })!.tier,
            ).toBe('le');
        });
    });
});
