/**
 * ByokModelResolver unit tests — deterministic, no real provider.
 * Proves the L0 adapter wires modelId -> the BYOK model factory correctly.
 */
import { ByokModelResolver } from '@libs/code-review/infrastructure/agents/adapters/byok-model-resolver.adapter';

describe('ByokModelResolver', () => {
    it('passes modelId through as the default-model override', () => {
        const calls: any[] = [];
        const fakeFactory = ((cfg, role, opts, override) => {
            calls.push({ cfg, role, opts, override });
            return { id: 'fake-model' } as any;
        }) as any;

        const resolver = new ByokModelResolver({
            byokConfig: { main: { model: 'org-model' } } as any,
            factory: fakeFactory,
        });

        const model = resolver.resolve('gemini-flash');

        expect(model).toEqual({ id: 'fake-model' });
        expect(calls[0].role).toBe('main');
        expect(calls[0].override).toBe('gemini-flash');
        expect(calls[0].cfg).toEqual({ main: { model: 'org-model' } });
    });

    it('defaults role to main and empty options', () => {
        const calls: any[] = [];
        const resolver = new ByokModelResolver({
            factory: ((cfg, role, opts, override) => {
                calls.push({ role, opts });
                return {} as any;
            }) as any,
        });
        resolver.resolve('m');
        expect(calls[0].role).toBe('main');
        expect(calls[0].opts).toEqual({});
    });

    it('passes undefined override when modelId is empty (use BYOK/default)', () => {
        const calls: any[] = [];
        const resolver = new ByokModelResolver({
            factory: ((cfg, role, opts, override) => {
                calls.push({ override });
                return {} as any;
            }) as any,
        });
        resolver.resolve('');
        expect(calls[0].override).toBeUndefined();
    });
});
