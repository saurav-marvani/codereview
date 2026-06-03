import { ModelCostCalculator } from './model-cost-calculator';
import { PricingResolver } from './pricing-resolver';
import { ModelPricingInfo } from './token-pricing.use-case';

/**
 * Build a ModelPricingInfo in per-token units (catalog shape) from "$/1M"
 * scalars so the tests read like the public pricing pages.
 */
const pricingFromMillions = (opts: {
    inputPerM: number;
    outputPerM: number;
    cacheReadPerM?: number;
    cacheWritePerM?: number;
    inputPerMAbove200k?: number;
    outputPerMAbove200k?: number;
    cacheReadPerMAbove200k?: number;
    cacheWritePerMAbove200k?: number;
}): ModelPricingInfo => {
    const perToken = (x?: number) =>
        typeof x === 'number' ? x / 1e6 : undefined;
    return {
        id: 'test-model',
        provider: 'test',
        pricing: {
            input: {
                default: perToken(opts.inputPerM) ?? 0,
                ...(opts.inputPerMAbove200k !== undefined && {
                    above200k: perToken(opts.inputPerMAbove200k),
                }),
            },
            output: {
                default: perToken(opts.outputPerM) ?? 0,
                ...(opts.outputPerMAbove200k !== undefined && {
                    above200k: perToken(opts.outputPerMAbove200k),
                }),
            },
            cacheRead: {
                default: perToken(opts.cacheReadPerM) ?? 0,
                ...(opts.cacheReadPerMAbove200k !== undefined && {
                    above200k: perToken(opts.cacheReadPerMAbove200k),
                }),
            },
            cacheWrite: {
                default: perToken(opts.cacheWritePerM) ?? 0,
                ...(opts.cacheWritePerMAbove200k !== undefined && {
                    above200k: perToken(opts.cacheWritePerMAbove200k),
                }),
            },
            prompt: perToken(opts.inputPerM) ?? 0,
            completion: perToken(opts.outputPerM) ?? 0,
            internal_reasoning: perToken(opts.outputPerM) ?? 0,
        },
    };
};

describe('ModelCostCalculator', () => {
    let calculator: ModelCostCalculator;
    let tokenPricingUseCase: { execute: jest.Mock };

    beforeEach(() => {
        tokenPricingUseCase = { execute: jest.fn() };
        // Real resolver over the mocked catalog: the catalog path still flows
        // through tokenPricingUseCase.execute, so the assertions below hold.
        const pricingResolver = new PricingResolver(tokenPricingUseCase as any);
        calculator = new ModelCostCalculator(pricingResolver);
    });

    it('returns zero and never consults pricing for an empty row set', async () => {
        expect(await calculator.totalCost([])).toBe(0);
        expect(await calculator.spendByModel([])).toEqual([]);
        expect(tokenPricingUseCase.execute).not.toHaveBeenCalled();
    });

    it('prices a small single-model workload at the default tier', async () => {
        tokenPricingUseCase.execute.mockResolvedValue(
            pricingFromMillions({
                inputPerM: 2,
                outputPerM: 12,
                inputPerMAbove200k: 4,
                outputPerMAbove200k: 18,
            }),
        );

        const byModel = await calculator.spendByModel([
            { input: 100_000, output: 40_000, outputReasoning: 0, model: 'g' },
        ]);

        // input 100K × $2/M = $0.20, output 40K × $12/M = $0.48 → $0.68
        expect(byModel).toHaveLength(1);
        expect(byModel[0].model).toBe('g');
        expect(byModel[0].spentUsd).toBeCloseTo(0.68, 10);
        expect(tokenPricingUseCase.execute).toHaveBeenCalledWith('g');
    });

    it('uses the >200K tier and subtracts cache reads from billable input', async () => {
        tokenPricingUseCase.execute.mockResolvedValue(
            pricingFromMillions({
                inputPerM: 2,
                outputPerM: 12,
                cacheReadPerM: 0.2,
                inputPerMAbove200k: 4,
                outputPerMAbove200k: 18,
                cacheReadPerMAbove200k: 0.4,
            }),
        );

        const total = await calculator.totalCost([
            {
                input: 600_000,
                output: 300_000,
                outputReasoning: 120_000,
                cacheRead: 150_000,
                cacheWrite: 30_000,
                model: 'g',
            },
            {
                input: 400_000,
                output: 200_000,
                outputReasoning: 80_000,
                cacheRead: 50_000,
                cacheWrite: 20_000,
                model: 'g',
            },
        ]);

        // aggregate input = 1M (>200K → above200k tier)
        //   uncachedInput 800K × $4/M = $3.20
        //   cacheRead     200K × $0.40/M = $0.08
        //   cacheWrite     50K × $0 (no above200k rate → 0) = $0
        //   output        500K × $18/M = $9.00
        expect(total).toBeCloseTo(12.28, 10);
    });

    it('prices each model independently and consults pricing once per model', async () => {
        tokenPricingUseCase.execute.mockImplementation(async (model: string) =>
            model === 'gemini'
                ? pricingFromMillions({
                      inputPerM: 2,
                      outputPerM: 12,
                      inputPerMAbove200k: 4,
                      outputPerMAbove200k: 18,
                  })
                : pricingFromMillions({ inputPerM: 3, outputPerM: 15 }),
        );

        const byModel = await calculator.spendByModel([
            { input: 500_000, output: 100_000, outputReasoning: 0, model: 'gemini' },
            { input: 500_000, output: 100_000, outputReasoning: 0, model: 'claude' },
        ]);

        const spend = Object.fromEntries(
            byModel.map((m) => [m.model, m.spentUsd]),
        );
        // gemini (>200K tier): 500K × $4 + 100K × $18 = $2.00 + $1.80 = $3.80
        // claude (default):     500K × $3 + 100K × $15 = $1.50 + $1.50 = $3.00
        expect(spend.gemini).toBeCloseTo(3.8, 10);
        expect(spend.claude).toBeCloseTo(3.0, 10);
        expect(tokenPricingUseCase.execute).toHaveBeenCalledTimes(2);
    });

    it('prices with a manual override instead of the catalog when one is given', async () => {
        const byModel = await calculator.spendByModel(
            [{ input: 100_000, output: 40_000, outputReasoning: 0, model: 'custom' }],
            {
                custom: {
                    input: 3e-6, // $3 / 1M
                    output: 15e-6, // $15 / 1M
                    cacheRead: 0,
                    cacheWrite: 0,
                },
            },
        );

        // input 100K × $3/M = $0.30, output 40K × $15/M = $0.60 → $0.90
        expect(byModel[0].spentUsd).toBeCloseTo(0.9, 10);
        // Manual override short-circuits the catalog entirely.
        expect(tokenPricingUseCase.execute).not.toHaveBeenCalled();
    });

    it('contributes zero and skips pricing for usage with a blank/unknown model', async () => {
        const byModel = await calculator.spendByModel([
            { input: 1_000, output: 500, outputReasoning: 0, model: '  ' },
            { input: 1_000, output: 500, outputReasoning: 0 },
        ]);

        expect(byModel).toEqual([{ model: '(unknown)', spentUsd: 0 }]);
        expect(tokenPricingUseCase.execute).not.toHaveBeenCalled();
    });
});
