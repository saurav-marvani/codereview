import { KodyRuleDetectorCompilerService } from './kody-rule-detector-compiler.service';

// Chainable builder mock: every config method returns `this`; execute() returns
// the canned compiler JSON. Mirrors the PromptRunnerService.builder() contract.
function makeBuilder(output: any) {
    const b: any = {};
    for (const m of [
        'setProviders',
        'setParser',
        'setLLMJsonMode',
        'addPrompt',
        'setRunName',
        'setBYOKConfig',
        'setPayload',
    ]) {
        b[m] = jest.fn(() => b);
    }
    b.execute = jest.fn(async () => output);
    return b;
}

const org = { organizationId: '11111111-1111-1111-1111-111111111111' } as any;

const make = (compilerOutput: any) => {
    const builder = makeBuilder(compilerOutput);
    const promptRunnerService: any = { builder: () => builder };
    const permissionValidationService: any = {
        getBYOKConfig: jest.fn(async () => null), // system mode
    };
    const kodyRulesService: any = {
        updateRuleDetector: jest.fn(async () => ({})),
    };
    const svc = new KodyRuleDetectorCompilerService(
        promptRunnerService,
        permissionValidationService,
        kodyRulesService,
    );
    return { svc, kodyRulesService, builder };
};

const mechanicalRule = {
    uuid: 'r1',
    title: 'no console',
    rule: 'do not use console.log',
    examples: [
        { isCorrect: false, snippet: 'console.log(x)' },
        { isCorrect: true, snippet: 'logger.info(x)' },
    ],
};

describe('KodyRuleDetectorCompilerService.compileAndSave (#1449 T0)', () => {
    it('persists a detector when the model compiles a passing regex', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: true,
            pattern: 'console\\.(log|warn|error)\\(',
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledTimes(1);
        const [, ruleId, detector] =
            kodyRulesService.updateRuleDetector.mock.calls[0];
        expect(ruleId).toBe('r1');
        expect(detector.pattern).toContain('console');
    });

    it('does NOT persist when the model declines (rule stays semantic)', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: false,
            reason: 'needs judgment',
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });

    it('does NOT persist when the compiled regex fails the gate', async () => {
        const { svc, kodyRulesService } = make({
            mechanical: true,
            pattern: 'NEVER_MATCHES', // misses the incorrect example
        });
        await svc.compileAndSave(org, 'r1', mechanicalRule);
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });

    it('clears a stale detector when an edited rule no longer compiles', async () => {
        const { svc, kodyRulesService } = make({ mechanical: false });
        await svc.compileAndSave(org, 'r1', {
            ...mechanicalRule,
            detector: { type: 'regex', pattern: 'old' }, // had one before
        });
        expect(kodyRulesService.updateRuleDetector).toHaveBeenCalledWith(
            org.organizationId,
            'r1',
            null,
        );
    });

    it('never throws / never persists when the LLM call errors', async () => {
        const { svc, kodyRulesService, builder } = make(null);
        builder.execute = jest.fn(async () => {
            throw new Error('llm down');
        });
        await expect(
            svc.compileAndSave(org, 'r1', mechanicalRule),
        ).resolves.toEqual({ compiled: false, declineReason: 'error' });
        expect(kodyRulesService.updateRuleDetector).not.toHaveBeenCalled();
    });
});
