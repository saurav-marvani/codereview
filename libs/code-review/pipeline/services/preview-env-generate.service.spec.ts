import { PreviewEnvGenerateService } from './preview-env-generate.service';

describe('PreviewEnvGenerateService', () => {
    const org = { organizationId: 'o1', teamId: 't1' } as any;
    const repository = { id: 'r1', name: 'repo', defaultBranch: 'main' };

    let config: any;
    let vmSvc: any;
    let detectAgent: any;
    let infraService: any;
    let codeManagement: any;
    let vm: any;
    let svc: PreviewEnvGenerateService;

    const validYaml =
        'setup:\n  - corepack enable\n  - pnpm install\nservices:\n  - pnpm start\nrequiredEnv:\n  - JWT_SECRET\n';

    beforeEach(() => {
        config = { get: (k: string) => ({ PREVIEW_AGENT_API_KEY: 'key', PREVIEW_AGENT_MODEL: 'm' }[k]) };
        vm = { run: jest.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }), cleanup: jest.fn().mockResolvedValue(undefined) };
        vmSvc = { isAvailable: () => true, createSandboxWithRepo: jest.fn().mockResolvedValue(vm) };
        detectAgent = { detect: jest.fn().mockResolvedValue({ success: true, summary: 'node app', playbookYaml: validYaml, playbook: {}, turns: 3, transcript: [] }) };
        infraService = { resolveInfra: jest.fn().mockResolvedValue(null) };
        codeManagement = {
            getRepositories: jest.fn().mockResolvedValue([{ id: 'r1', name: 'repo', fullName: 'org/repo', defaultBranch: 'main', platform: 'github' }]),
            getCloneParams: jest.fn().mockResolvedValue({ url: 'https://x/repo.git', auth: { token: 'tok' }, platformType: 'github' }),
        };
        svc = new PreviewEnvGenerateService(config, vmSvc, detectAgent, infraService, codeManagement);
    });

    const run = () => svc.generate({ organizationAndTeamData: org, repositoryId: 'r1' });

    it('orchestrates resolve-repo → clone → provision → detect → validate and returns the playbook', async () => {
        const res = await run();
        expect(codeManagement.getRepositories).toHaveBeenCalled();
        expect(codeManagement.getCloneParams).toHaveBeenCalled();
        expect(vmSvc.createSandboxWithRepo).toHaveBeenCalledWith(
            expect.objectContaining({ cloneUrl: 'https://x/repo.git', authToken: 'tok', branch: 'main' }),
            undefined,
        );
        expect(res.success).toBe(true);
        expect(res.config?.setup).toEqual(['corepack enable', 'pnpm install']);
        expect(res.requiredEnv).toEqual(['JWT_SECRET']);
        expect(res.verified).toBe(true);
        expect(res.playbookYaml).toContain('pnpm install');
    });

    it('always tears the VM down, even on a detect error', async () => {
        detectAgent.detect.mockRejectedValueOnce(new Error('agent blew up'));
        const res = await run();
        expect(res.success).toBe(false);
        expect(vm.cleanup).toHaveBeenCalled();
    });

    it('fails cleanly when no agent key is configured', async () => {
        config.get = () => undefined;
        const res = await run();
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/LLM key/);
        expect(vmSvc.createSandboxWithRepo).not.toHaveBeenCalled();
    });

    it('fails when no VM token and no org infra', async () => {
        vmSvc.isAvailable = () => false;
        const res = await run();
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/VM token/);
    });

    it('fails when the repo is not found in the org integration', async () => {
        codeManagement.getRepositories.mockResolvedValueOnce([]);
        const res = await run();
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/not found/);
        expect(vmSvc.createSandboxWithRepo).not.toHaveBeenCalled();
    });

    it('fails when the clone URL cannot be resolved', async () => {
        codeManagement.getCloneParams.mockResolvedValueOnce({});
        const res = await run();
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/clone URL/);
    });

    it('reports a validation error (and still tears down) when the draft is invalid', async () => {
        detectAgent.detect.mockResolvedValueOnce({ success: true, summary: 's', playbookYaml: 'setup: not-a-list', playbook: null, turns: 1, transcript: [] });
        const res = await run();
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/failed validation/);
        expect(res.playbookYaml).toBe('setup: not-a-list'); // returns the raw draft for the user to see
        expect(vm.cleanup).toHaveBeenCalled();
    });

    it('surfaces a secret-looking key in the draft as a validation failure', async () => {
        detectAgent.detect.mockResolvedValueOnce({ success: true, summary: 's', playbookYaml: 'JWT_SECRET: leaked\nsetup:\n  - x\n', playbook: null, turns: 1, transcript: [] });
        const res = await run();
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/secret/);
    });
});
