const createMock = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
    return jest.fn().mockImplementation(() => ({
        messages: { create: createMock },
    }));
});

import { PreviewEnvDetectService } from './preview-env-detect.service';

// Helpers to script Anthropic responses.
const bashTurn = (command: string) => ({
    content: [
        { type: 'text', text: `running ${command}` },
        { type: 'tool_use', id: `t-${command}`, name: 'bash', input: { command } },
    ],
});
const finishTurn = (input: any) => ({
    content: [{ type: 'tool_use', id: 'fin', name: 'finish', input }],
});

describe('PreviewEnvDetectService', () => {
    let svc: PreviewEnvDetectService;
    let exec: jest.Mock;

    beforeEach(() => {
        createMock.mockReset();
        exec = jest.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
        svc = new PreviewEnvDetectService();
    });

    const run = () =>
        svc.detect({ apiKey: 'k', model: 'm', exec, maxTurns: 5 });

    it('runs the agent loop: execs bash, then returns the parsed playbook on finish', async () => {
        createMock
            .mockResolvedValueOnce(bashTurn('cat package.json'))
            .mockResolvedValueOnce(
                finishTurn({
                    success: true,
                    summary: 'node app',
                    playbook_yaml:
                        'setup:\n  - corepack enable\n  - pnpm install\nservices:\n  - pnpm start\nhealthcheck:\n  - curl -sf localhost:3000\nrequiredEnv:\n  - JWT_SECRET\n',
                }),
            );

        const res = await run();

        expect(exec).toHaveBeenCalledWith('cat package.json', expect.any(Number));
        expect(res.success).toBe(true);
        expect(res.playbook?.setup).toEqual(['corepack enable', 'pnpm install']);
        expect(res.playbook?.services).toEqual(['pnpm start']);
        expect(res.playbook?.requiredEnv).toEqual(['JWT_SECRET']);
        expect(res.playbookYaml).toContain('corepack enable');
        expect(res.turns).toBe(2);
        // Transcript captured the bash command + its output.
        expect(res.transcript[0].commands[0]).toMatchObject({ command: 'cat package.json', exitCode: 0 });
    });

    it('records the real exit code of a failed command in the transcript', async () => {
        exec.mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 1 });
        createMock
            .mockResolvedValueOnce(bashTurn('bad-cmd'))
            .mockResolvedValueOnce(finishTurn({ success: false, summary: 'nope', playbook_yaml: 'setup: []\n' }));

        const res = await run();
        expect(res.transcript[0].commands[0]).toMatchObject({ command: 'bad-cmd', exitCode: 1, stderr: 'boom' });
        expect(res.success).toBe(false);
    });

    it('feeds malformed playbook YAML back to the model instead of returning', async () => {
        createMock
            .mockResolvedValueOnce(finishTurn({ success: true, summary: 's', playbook_yaml: 'setup: [: :bad' }))
            .mockResolvedValueOnce(finishTurn({ success: true, summary: 's2', playbook_yaml: 'setup:\n  - ok\n' }));

        const res = await run();
        // It did NOT return on the malformed finish; it retried and returned the valid one.
        expect(createMock).toHaveBeenCalledTimes(2);
        expect(res.playbook?.setup).toEqual(['ok']);
    });

    it('stops at the turn limit without a playbook', async () => {
        createMock.mockResolvedValue(bashTurn('loop-forever'));
        const res = await svc.detect({ apiKey: 'k', model: 'm', exec, maxTurns: 3 });
        expect(res.success).toBe(false);
        expect(res.playbookYaml).toBeNull();
        expect(res.turns).toBe(3);
    });
});
