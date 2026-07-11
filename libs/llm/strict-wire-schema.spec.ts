import { z } from 'zod';
import { zodToStrictWireSchema } from '@libs/llm/strict-wire-schema';
import { kodyRulesIDEGeneratorSchema } from '@libs/common/utils/langchainCommon/prompts/kodyRules';
import { kodyMemoryResolutionSchema } from '@libs/common/utils/langchainCommon/prompts/kodyMemoryResolution';
import { compilerOutputSchema } from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler';

// Every property of every object node must be in `required` — OpenAI strict
// structured outputs 400 otherwise ("'required' is required to be supplied
// and to be an array including every key in properties"). Checked recursively
// because the live failures were on NESTED nodes (rules.items, violations.items).
function assertStrictRequired(node: any, path = '$'): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach((n, i) => assertStrictRequired(n, `${path}[${i}]`));
        return;
    }
    if (node.type === 'object' && node.properties) {
        expect({ path, required: [...(node.required ?? [])].sort() }).toEqual({
            path,
            required: Object.keys(node.properties).sort(),
        });
    }
    for (const key of Object.keys(node)) {
        assertStrictRequired(node[key], `${path}.${key}`);
    }
}

describe('zodToStrictWireSchema', () => {
    // The two schemas that failed LIVE in QA for BYOK-OpenAI orgs, plus the
    // other .optional()-carrying callers of runStructuredReviewCall.
    const realSchemas: Array<[string, z.ZodType]> = [
        ['kodyRulesIDEGeneratorSchema (guidance-file extraction)', kodyRulesIDEGeneratorSchema],
        ['kodyMemoryResolutionSchema', kodyMemoryResolutionSchema],
        ['compilerOutputSchema (detector compiler)', compilerOutputSchema],
    ];

    it.each(realSchemas)(
        '%s → wire schema is OpenAI-strict compatible',
        (_name, schema) => {
            const wire = (zodToStrictWireSchema(schema) as any).jsonSchema;
            assertStrictRequired(wire);
        },
    );

    it('previously-optional fields become nullable on the wire', () => {
        const wire = (zodToStrictWireSchema(compilerOutputSchema) as any)
            .jsonSchema;
        // pattern was .optional() — must now be required AND accept null
        expect(wire.required).toContain('pattern');
        expect(JSON.stringify(wire.properties.pattern)).toContain('"null"');
        // mechanical was already required — left untouched
        expect(JSON.stringify(wire.properties.mechanical)).not.toContain(
            '"null"',
        );
    });

    it('validate(): strict-provider null fills round-trip to absent', () => {
        const result = (zodToStrictWireSchema(compilerOutputSchema) as any)
            .validate({
                mechanical: false,
                pattern: null,
                flags: null,
                reason: null,
            });
        expect(result.success).toBe(true);
        expect(result.value.pattern).toBeUndefined();
        expect(result.value.mechanical).toBe(false);
    });

    it('validate(): lenient providers that omit optional keys still parse', () => {
        const result = (zodToStrictWireSchema(kodyRulesIDEGeneratorSchema) as any)
            .validate({
                rules: [
                    {
                        title: 't',
                        rule: 'r',
                        path: '**/*.rb',
                        sourcePath: 'CLAUDE.md',
                        severity: 'high',
                        examples: [{ snippet: 's', isCorrect: true }],
                    },
                ],
            });
        expect(result.success).toBe(true);
        expect(result.value.rules).toHaveLength(1);
    });

    it('validate(): real type errors still fail parse', () => {
        const result = (zodToStrictWireSchema(compilerOutputSchema) as any)
            .validate({ mechanical: 'yes' });
        expect(result.success).toBe(false);
    });
});
