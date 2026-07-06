import { RunPreviewEnvStage } from './run-preview-env.stage';
import { PREVIEW_ENV_LABEL } from '../services/preview-env-findings';

/**
 * Integration test of the preview-env stage's orchestration (the alpha spine)
 * with the VM + agent + clone resolver mocked — verifies findings flow into
 * context.validSuggestions with proof + label + focus, and the VM is always
 * torn down. Does NOT boot a real VM or Kody.
 */
const makeStage = (over: {
    findings?: any[];
    available?: boolean;
    apiKey?: string;
    cleanup?: jest.Mock;
} = {}) => {
    const cleanup = over.cleanup ?? jest.fn().mockResolvedValue(undefined);
    const fakeSandbox = {
        type: 'vm',
        sandboxId: 's1',
        repoDir: '/opt/repo',
        run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
        readFile: jest.fn(),
        writeFile: jest.fn().mockResolvedValue(undefined),
        cleanup,
        remoteCommands: {} as any,
    };
    const config = {
        get: (k: string) =>
            ({
                PREVIEW_AGENT_API_KEY: over.apiKey ?? 'test-key',
                PREVIEW_AGENT_MODEL: 'claude-sonnet-4-5',
            })[k],
    } as any;
    const cloneParamsResolver = {
        resolve: jest.fn().mockResolvedValue({
            url: 'https://github.com/o/r',
            authToken: 't',
            branch: 'pr',
            baseBranch: 'main',
            prNumber: 7,
            platform: 'github',
        }),
    } as any;
    const agent = {
        run: jest.fn().mockResolvedValue({
            findings: over.findings ?? [],
            summary: 'ok',
            turns: 3,
        }),
    } as any;
    const vmSvc = {
        isAvailable: jest.fn().mockReturnValue(over.available ?? true),
        createSandboxWithRepo: jest.fn().mockResolvedValue(fakeSandbox),
    } as any;
    const secretsService = { resolveSecrets: jest.fn().mockResolvedValue({}) } as any;
    const infraService = { resolveInfra: jest.fn().mockResolvedValue(null) } as any;
    const stage = new RunPreviewEnvStage(config, cloneParamsResolver, agent, vmSvc, secretsService, infraService);
    return { stage, vmSvc, agent, cleanup, cloneParamsResolver, fakeSandbox, secretsService, infraService };
};

const ctx = (over: any = {}): any => ({
    codeReviewConfig: {
        environment: { enabled: true, trigger: 'auto', setup: [], build: [], services: [], test: [], healthcheck: [] },
    },
    changedFiles: [{ filename: 'db.js', patch: '@@ -1 +1 @@\n-a\n+b' }],
    repository: { id: 'r1' },
    origin: 'automatic',
    ...over,
});

describe('RunPreviewEnvStage (alpha spine)', () => {
    it('skips (no-op) when environment is not enabled', async () => {
        const { stage, vmSvc } = makeStage();
        const c = ctx({ codeReviewConfig: { environment: { enabled: false } } });
        const out = await stage.execute(c);
        expect(vmSvc.createSandboxWithRepo).not.toHaveBeenCalled();
        expect(out.validSuggestions).toBeUndefined();
    });

    it('skips when no VM token / not available', async () => {
        const { stage, agent } = makeStage({ available: false });
        await stage.execute(ctx());
        expect(agent.run).not.toHaveBeenCalled();
    });

    it('boots the VM, runs the agent, appends findings to validSuggestions with proof, tears down', async () => {
        // file matches the changed file → anchored on-diff → inline
        const findings = [
            { severity: 'critical', description: 'SSRF reachable', file: 'db.js', evidence: '$ curl 169.254... -> 200' },
        ];
        const { stage, agent, cleanup } = makeStage({ findings });
        const out = await stage.execute(ctx());

        expect(agent.run).toHaveBeenCalledTimes(1);
        expect(out.validSuggestions).toHaveLength(1);
        const s = out.validSuggestions[0];
        expect(s.relevantFile).toBe('db.js');
        expect(s.relevantLinesStart).toBe(1); // anchored to the changed line, not hard-1
        expect((s as any).postPrLevel).toBeUndefined(); // marker stripped before context
        expect(s.severity).toBe('critical');
        expect(s.label).toBe(PREVIEW_ENV_LABEL);
        expect(s.suggestionContent).toContain('SSRF reachable');
        expect(s.suggestionContent).toContain('<details>'); // proof block
        expect(out.previewEnvSignal.ran).toBe(true);
        expect(cleanup).toHaveBeenCalledTimes(1); // VM always torn down
    });

    it('an off-diff finding still flows through (line-1 anchor → comment manager degrades gracefully), marker stripped', async () => {
        // file is NOT among the changed files → no postable line. It stays in
        // validSuggestions (persisted + line-adjust-retried downstream), never
        // silently dropped; the internal postPrLevel marker is stripped.
        const findings = [
            { severity: 'high', description: 'runtime regression', file: 'not-in-diff.js', evidence: '$ ran -> 500' },
        ];
        const { stage } = makeStage({ findings });
        const out = await stage.execute(ctx());

        expect(out.validSuggestions).toHaveLength(1);
        expect(out.validSuggestions[0].relevantFile).toBe('not-in-diff.js');
        expect(out.validSuggestions[0].relevantLinesStart).toBe(1); // no changed line → line-1 anchor
        expect((out.validSuggestions[0] as any).postPrLevel).toBeUndefined(); // marker stripped
    });

    it('passes the focus directive to the agent and filters non-matching findings', async () => {
        const findings = [
            { severity: 'critical', description: 'SSRF', file: 'db.js', evidence: 'x' }, // critical → always kept, on-diff
            { severity: 'low', description: 'css nit', file: 'style.css', evidence: 'x' }, // no focus match → dropped
        ];
        const { stage, agent } = makeStage({ findings });
        const out = await stage.execute(ctx({ reviewDirective: 'security vulnerabilities' }));

        expect(agent.run).toHaveBeenCalledWith(
            expect.objectContaining({ focus: 'security vulnerabilities' }),
        );
        expect(out.validSuggestions).toHaveLength(1); // only the critical survives the focus
        expect(out.validSuggestions[0].relevantFile).toBe('db.js');
    });

    it('org-level infra config (BYO-cloud) makes the stage runnable without the env token', async () => {
        const { stage, agent, vmSvc, infraService } = makeStage({ available: false });
        const infra = { provider: 'hetzner', token: 'org-cloud-token', region: 'hil' };
        infraService.resolveInfra.mockResolvedValue(infra);

        await stage.execute(ctx({ organizationAndTeamData: { organizationId: 'o1', teamId: 't1' } }));

        expect(agent.run).toHaveBeenCalledTimes(1);
        // The org config is handed to the VM provisioner (their cloud account).
        expect(vmSvc.createSandboxWithRepo).toHaveBeenCalledWith(
            expect.anything(),
            infra,
        );
    });

    it('tears the VM down even when the agent throws', async () => {
        const { stage, agent, cleanup, vmSvc } = makeStage();
        agent.run.mockRejectedValueOnce(new Error('boom'));
        const out = await stage.execute(ctx());
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(vmSvc.createSandboxWithRepo).toHaveBeenCalled();
        expect(out.validSuggestions).toBeUndefined(); // failure → review continues without it
    });
});
