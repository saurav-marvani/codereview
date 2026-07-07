/**
 * Environment-axis probe for the multi-stack QA loop. For each repo, provision
 * a fresh VM (cold, in parallel), run the playbook phases, and report which
 * phase (if any) failed + the output tail. NO agent — this measures/refines the
 * PLAYBOOK robustness across stacks (does the env boot green from zero?), which
 * has to work before judgment can be measured.
 *
 * Run in the dev container (see kodus1461-runtime.ts invocation).
 */
import 'tsconfig-paths/register';
import * as fs from 'fs';
import * as os from 'os';
import { VmSandboxService } from '@libs/sandbox/infrastructure/providers/vm-sandbox.service';

function cfgVal(name: string): string {
    const line = fs
        .readFileSync(os.homedir() + '/.kodus-dev/config', 'utf8')
        .split('\n')
        .find((l) => l.startsWith(name + '='));
    return (line ?? '').split('=').slice(1).join('=').replace(/^["']|["']$/g, '').trim();
}

// setsid-background a long-running service so the exec returns; redirect OUTSIDE
// bash -c so the ssh channel fds free (hard-won from the experiment).
function wrapService(command: string): string {
    const escaped = command.replace(/'/g, `'\\''`);
    return `setsid bash -c '${escaped}' > /tmp/kody-svc.log 2>&1 < /dev/null & sleep 3`;
}

// Readiness POLL instead of a fixed sleep: many apps take variable time to bind
// (gophish inits its DB on first run, Django/Node compile on boot). Retry up to
// ~60s. `-k` tolerates gophish's self-signed admin TLS.
function poll(url: string): string {
    return `for i in $(seq 1 30); do curl -skf "${url}" -o /dev/null && echo HEALTH_OK && exit 0; sleep 2; done; echo "TIMEOUT waiting for ${url}"; exit 1`;
}

const REPOS = [
    {
        name: 'kutt-node',
        url: 'https://github.com/kodus-e2e/tiny-url',
        branch: 'kutt-main',
        auth: cfgVal('GH_TEST_TOKEN'),
        setup: [
            'apt-get install -y -qq nodejs npm >/dev/null 2>&1 && node --version',
            'npm install --no-audit --no-fund 2>&1 | tail -2',
            "cp .example.env .env && sed -i 's/^JWT_SECRET=.*/JWT_SECRET=probe-secret-123/' .env",
        ],
        build: ['npm run migrate 2>&1 | tail -3'],
        services: ['npm start'],
        healthcheck: [poll('http://localhost:3000/api/health')],
    },
    {
        name: 'bakerydemo-django',
        url: 'https://github.com/wagtail/bakerydemo',
        branch: 'main',
        auth: undefined,
        setup: [
            'apt-get install -y -qq python3 python3-pip python3-venv >/dev/null 2>&1 && python3 --version',
            'python3 -m venv .venv && . .venv/bin/activate && pip install -q -r requirements.txt 2>&1 | tail -3',
        ],
        build: [
            '. .venv/bin/activate && python manage.py migrate --noinput 2>&1 | tail -4',
            '. .venv/bin/activate && python manage.py load_initial_data 2>&1 | tail -3 || true',
        ],
        // --skip-checks: wagtail vs treebeard raises a system-check error
        // (treebeard.E001) that otherwise aborts runserver on boot.
        services: ['. .venv/bin/activate && python manage.py runserver --skip-checks --noreload 0.0.0.0:8000'],
        healthcheck: [poll('http://localhost:8000/')],
    },
    {
        name: 'gophish-go',
        url: 'https://github.com/gophish/gophish',
        branch: 'master',
        auth: undefined,
        setup: [
            // gcc: go-sqlite3 (gophish's DB driver via goose) needs CGO; without
            // a C compiler CGO is off and sqlite3.Error is stubbed → build fails.
            'apt-get install -y -qq gcc >/dev/null 2>&1 && gcc --version | head -1',
            'curl -fsSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz -o /tmp/go.tgz && tar -C /usr/local -xzf /tmp/go.tgz && /usr/local/go/bin/go version',
        ],
        // -o gophish: bare `go build` names the binary after the checkout dir,
        // not the module → ./gophish wouldn't exist. `test -f` gates the phase on
        // the binary actually existing — `| tail` alone masks a build failure's
        // exit code (same trap as a piped `... | tail`), marking build falsely ✓.
        build: ['export PATH=$PATH:/usr/local/go/bin CGO_ENABLED=1 && (go build -o gophish 2>&1 | tail -20); test -f ./gophish || { echo GOPHISH_BUILD_FAILED; exit 1; }'],
        // admin listens on 127.0.0.1:3333 by default
        services: ['export PATH=$PATH:/usr/local/go/bin && ./gophish'],
        healthcheck: [poll('https://localhost:3333/')],
    },
];

async function probe(repo: (typeof REPOS)[number]) {
    const env: Record<string, string> = {
        PREVIEW_VM_TOKEN: cfgVal('HETZNER_DEV'),
        PREVIEW_VM_REGION: 'hil',
        PREVIEW_VM_SIZE: 'cpx31',
    };
    const config: any = { get: (k: string) => env[k] };
    const vmSvc = new VmSandboxService(config);
    const phases: Array<{ phase: string; ok: boolean; tail: string }> = [];
    let vm: any;
    try {
        vm = await vmSvc.createSandboxWithRepo({
            cloneUrl: repo.url,
            authToken: repo.auth,
            branch: repo.branch,
            baseBranch: repo.branch,
            platform: 'github' as any,
        });
        for (const [phase, cmds] of [
            ['setup', repo.setup],
            ['build', repo.build],
            ['services', repo.services.map(wrapService)],
            ['healthcheck', repo.healthcheck],
        ] as const) {
            let ok = true;
            let tail = '';
            for (const cmd of cmds) {
                const r = await vm.run(cmd, { timeoutMs: 20 * 60_000 });
                tail = `exit=${r.exitCode} :: ${(r.stdout + r.stderr).slice(-600)}`;
                // services is fire-and-forget (setsid-backgrounded → spurious
                // 255 over ssh); the healthcheck is the real readiness gate.
                if (r.exitCode !== 0 && phase !== 'services') { ok = false; break; }
            }
            // Instrument: on any services/healthcheck failure, dump the booted
            // service's OWN log — the phase output is empty (it's backgrounded),
            // the real reason (crash on startup, missing env, wrong port) is here.
            if (!ok && (phase === 'services' || phase === 'healthcheck')) {
                const svc = await vm
                    .run('tail -40 /tmp/kody-svc.log 2>/dev/null; echo "--- listening ports ---"; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | tail -15')
                    .then((x: any) => (x.stdout + x.stderr).slice(-1400))
                    .catch(() => '');
                tail += `\n      [svc.log + ports]\n${svc}`;
            }
            phases.push({ phase, ok, tail });
            if (!ok) break;
        }
        const green = phases.length === 4 && phases.every((p) => p.ok);
        return { name: repo.name, green, phases };
    } catch (e: any) {
        return { name: repo.name, green: false, error: String(e?.message ?? e).slice(0, 300), phases };
    } finally {
        if (vm) await vm.cleanup().catch(() => undefined);
    }
}

async function main() {
    // PROBE_ONLY=gophish-go,kutt-node re-tests a subset after a fix without
    // burning VMs on already-green stacks.
    const only = (process.env.PROBE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const repos = only.length ? REPOS.filter((r) => only.includes(r.name)) : REPOS;
    console.log(`[probe] provisioning + booting ${repos.length} stack(s) in parallel…`);
    const results = await Promise.all(repos.map(probe));
    console.log('\n########## PLAYBOOK PROBE RESULTS');
    for (const r of results) {
        console.log(`\n=== ${r.name}: ${r.green ? 'GREEN ✓' : 'FAILED ✕'} ${r.error ? '('+r.error+')' : ''}`);
        for (const p of r.phases) {
            console.log(`   ${p.ok ? '✓' : '✕'} ${p.phase}${p.ok ? '' : '\n      ↳ ' + p.tail.replace(/\n/g, '\n      ')}`);
        }
    }
    const greens = results.filter((r) => r.green).length;
    console.log(`\n########## ${greens}/${results.length} stack(s) booted GREEN from zero`);
}

main().catch((e) => { console.error('[probe] FAILED:', e?.message ?? e); process.exit(1); });
