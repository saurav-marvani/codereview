import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalSandboxService } from './local-sandbox.service';

/**
 * exec must return stdout and stderr SEPARATELY (plus a real exitCode) rather
 * than merging stderr into stdout. The merge is what let a subprocess error
 * ("fd: command not found", "No such file") masquerade as real command output
 * in the tools that consume exec.
 */
describe('LocalSandboxService exec — separates stdout and stderr', () => {
    let dir: string;
    let rc: any;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-exec-streams-'));
        fs.writeFileSync(path.join(dir, 'real.txt'), 'hello world\n');
        const svc = new LocalSandboxService({} as any);
        rc = (svc as any).buildRemoteCommands(dir);
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('keeps a failing single command’s stderr out of stdout', async () => {
        const r = await rc.exec('cat nonexistent.txt');
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toMatch(/nonexistent/i);
        expect(r.stdout).not.toMatch(/nonexistent/i);
    });

    it('returns clean stdout with empty stderr on success', async () => {
        const r = await rc.exec('cat real.txt');
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toMatch(/hello world/);
        expect(r.stderr ?? '').not.toMatch(/hello world/);
    });

    it('keeps stderr out of stdout in a pipeline', async () => {
        const r = await rc.exec('cat nonexistent.txt | head');
        expect(r.stderr).toMatch(/nonexistent/i);
        expect(r.stdout).not.toMatch(/nonexistent/i);
    });
});
