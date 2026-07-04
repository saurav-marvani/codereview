#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectEnvironment, diagnoseFailure, dumpPlaybook } from './agent.js';
import { getEnv } from './config.js';
import {
    PHASES,
    PLAYBOOK_REMOTE_PATH,
    readRemotePlaybook,
    runPlaybook,
} from './playbook.js';
import { getProvider } from './providers/index.js';
import { scpUpload, shellQuote, sshExec, sshInteractive } from './ssh.js';
import {
    RUNS_DIR,
    SSH_KEY_DIR,
    VM_PREFIX,
    deleteState,
    ensureDirs,
    listStates,
    loadState,
    normalizeName,
    saveState,
    stateExists,
    type PreviewState,
} from './state.js';

const CLOUD_INIT = `#cloud-config
package_update: true
packages:
  - git
  - jq
  - curl
  - ca-certificates
runcmd:
  # SSH also on 443: restrictive networks (VPNs) often block outbound 22.
  # Ubuntu 24.04 uses systemd socket activation (ssh.socket pins port 22),
  # so disable the socket and run sshd directly.
  - printf 'Port 22\\nPort 443\\n' > /etc/ssh/sshd_config.d/60-kody-ports.conf
  - systemctl disable --now ssh.socket || true
  - systemctl enable ssh
  - systemctl restart ssh
  - curl -fsSL https://get.docker.com | sh
  - mkdir -p /opt/kody
  # Base Node + headless Playwright/Chromium so agents can verify web UIs
  # in a real browser without burning turns on setup. Repos that pin a
  # different Node version can still install it over this one.
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  - apt-get install -y nodejs
  - npm install -g playwright
  - playwright install --with-deps chromium
`;

const USAGE = `kody preview-env — ephemeral customer test environments (experiment)

Usage:
  preview up      --name <n> --repo <git-url> [--token <t>] [--env-file <path>]
                  [--provider digitalocean] [--region ...] [--size ...] [--branch <b>]
  preview detect  --name <n> [--hint "..."] [--model <id>] [--force]
  preview run     --name <n> [--phase setup|services|build|test] [--playbook <file>] [--timeout <s>]
  preview diagnose --name <n> [--model <id>]   # run tests; on failure, agent finds root cause
  preview exec    --name <n> -- <command...>
  preview ssh     --name <n>
  preview status                    # local state + live VMs (API is source of truth)
  preview down    --name <n> | --all

Flow: up (VM + clone + env vars) -> detect (agent figures the env out, writes
.kody/environment.yml) -> run (deterministic playbook execution) -> down.
Leaked VMs are TTL-reaped by scripts/selfhosted/reap.sh (${VM_PREFIX}* prefix).`;

interface Args {
    _: string[];
    [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
    const args: Args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') {
            args.rest = argv.slice(i + 1).join(' ');
            break;
        }
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                args[key] = true;
            } else {
                args[key] = next;
                i++;
            }
        } else {
            args._.push(a);
        }
    }
    return args;
}

function str(args: Args, key: string): string | undefined {
    const v = args[key];
    return typeof v === 'string' ? v : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for SSH, alternating between port 22 and 443 (sshd listens on both;
 * restrictive networks/VPNs often block outbound 22). Persists whichever
 * port answered into state so all later calls use it.
 */
async function waitForSsh(state: PreviewState, timeoutMs = 420_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    process.stdout.write('waiting for SSH (ports 22/443) ');
    while (Date.now() < deadline) {
        for (const port of [22, 443]) {
            const res = await sshExec(
                { ...state, sshPort: port },
                'true',
                { timeoutMs: 15_000 },
            );
            if (res.exitCode === 0) {
                state.sshPort = port;
                saveState(state);
                console.log(`ok (port ${port})`);
                return;
            }
            process.stdout.write('.');
        }
        await sleep(5000);
    }
    throw new Error('SSH did not come up in time (tried ports 22 and 443)');
}

function buildAuthedCloneUrl(repoUrl: string, token?: string): string {
    if (!token) return repoUrl;
    const url = new URL(repoUrl);
    // Same platform quirks handled by e2b-sandbox's buildAuthHeader:
    // GitHub accepts x-access-token, GitLab wants oauth2, Bitbucket uses
    // user:app-password (pass token as "user:pass" for bitbucket).
    if (url.hostname.includes('gitlab')) {
        url.username = 'oauth2';
        url.password = token;
    } else if (token.includes(':')) {
        const [user, pass] = token.split(/:(.*)/s);
        url.username = user;
        url.password = pass;
    } else {
        url.username = 'x-access-token';
        url.password = token;
    }
    return url.toString();
}

async function cmdUp(args: Args): Promise<void> {
    const name = normalizeName(str(args, 'name') ?? 'default');
    const repoUrl = str(args, 'repo');
    if (!repoUrl) throw new Error('--repo <git-url> is required');
    if (stateExists(name)) {
        throw new Error(`Env '${name}' already exists. Run: preview down --name ${name}`);
    }
    ensureDirs();

    const keyPath = join(SSH_KEY_DIR, name);
    if (!existsSync(keyPath)) {
        execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', `${VM_PREFIX}${name}`], { stdio: 'ignore' });
    }
    const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();

    const provider = getProvider(str(args, 'provider') ?? getEnv('PREVIEW_VM_PROVIDER') ?? 'digitalocean');
    const vmName = `${VM_PREFIX}${name}`;
    console.log(`provisioning ${vmName} on ${provider.kind}...`);
    const vm = await provider.create({
        name: vmName,
        publicKey,
        userData: CLOUD_INIT,
        region: str(args, 'region'),
        size: str(args, 'size'),
    });
    console.log(`droplet ${vm.serverId} @ ${vm.ip}`);

    const state: PreviewState = {
        name,
        provider: provider.kind,
        serverId: vm.serverId,
        sshKeyId: vm.sshKeyId,
        serverIp: vm.ip,
        sshKeyPath: keyPath,
        repoUrl,
        repoDir: '/opt/repo',
        createdAt: new Date().toISOString(),
    };
    // Persist state BEFORE the slow parts so a crash never leaks the VM
    // untracked (reap.sh would still catch it, but status/down should work).
    saveState(state);

    await waitForSsh(state);
    console.log('waiting for cloud-init (docker install)...');
    const ci = await sshExec(state, 'cloud-init status --wait', { timeoutMs: 600_000 });
    if (ci.exitCode !== 0) {
        console.warn(`cloud-init reported: ${ci.stdout.trim() || ci.stderr.trim()} (continuing)`);
    }
    const docker = await sshExec(state, 'docker version --format {{.Server.Version}}', { timeoutMs: 30_000 });
    if (docker.exitCode !== 0) throw new Error('docker did not come up on the VM');
    console.log(`docker ${docker.stdout.trim()} ready`);

    const envFile = str(args, 'env-file');
    if (envFile) {
        if (!existsSync(envFile)) throw new Error(`env file not found: ${envFile}`);
        scpUpload(state, envFile, '/opt/kody/customer.env');
        await sshExec(state, 'chmod 600 /opt/kody/customer.env', { timeoutMs: 15_000 });
        state.envFileUploaded = true;
        saveState(state);
        console.log('customer env file uploaded to /opt/kody/customer.env');
    }

    const token = str(args, 'token') ?? getEnv('PREVIEW_GIT_TOKEN');
    const branch = str(args, 'branch');
    const authedUrl = buildAuthedCloneUrl(repoUrl, token);
    console.log(`cloning ${repoUrl}${branch ? ` (branch ${branch})` : ''}...`);
    const clone = await sshExec(
        state,
        `git clone ${branch ? `--branch ${shellQuote(branch)} ` : ''}${shellQuote(authedUrl)} /opt/repo && cd /opt/repo && git remote set-url origin ${shellQuote(repoUrl)}`,
        { timeoutMs: 600_000 },
    );
    if (clone.exitCode !== 0) {
        // Keep token out of the error output.
        throw new Error(`git clone failed:\n${clone.stderr.replaceAll(token ?? ' ', '***')}`);
    }
    console.log(`\nenv '${name}' is up.`);
    console.log(`  next: pnpm run preview detect --name ${name}`);
    console.log(`  ssh:  pnpm run preview ssh --name ${name}`);
}

async function cmdDetect(args: Args): Promise<void> {
    const name = normalizeName(str(args, 'name') ?? 'default');
    const state = loadState(name);

    if (!args.force) {
        const existing = await readRemotePlaybook(state);
        if (existing) {
            console.log(
                `Repo already has ${PLAYBOOK_REMOTE_PATH} — skipping detection (use --force to re-detect).`,
            );
            console.log(dumpPlaybook(existing));
            return;
        }
    }

    console.log(`starting environment-detection agent on '${name}'...`);
    const result = await detectEnvironment(state, {
        model: str(args, 'model'),
        hint: str(args, 'hint'),
    });

    console.log(`\n=== detection ${result.success ? 'SUCCEEDED' : 'FAILED'} after ${result.turns} turns ===`);
    console.log(result.summary);
    console.log(`transcript: ${result.transcriptPath}`);

    if (result.playbook) {
        const yamlText = dumpPlaybook(result.playbook);
        // Write to the repo on the VM (candidate for a PR back to the
        // customer) and keep a local artifact copy.
        const remoteDir = `${state.repoDir ?? '/opt/repo'}/.kody`;
        await sshExec(
            state,
            `mkdir -p ${remoteDir} && cat > ${remoteDir}/environment.yml <<'KODY_EOF'\n${yamlText}\nKODY_EOF`,
            { timeoutMs: 30_000 },
        );
        const localDir = join(RUNS_DIR, name);
        mkdirSync(localDir, { recursive: true });
        const localCopy = join(localDir, 'environment.yml');
        writeFileSync(localCopy, yamlText);
        console.log(`playbook written to VM ${PLAYBOOK_REMOTE_PATH} and ${localCopy}`);
        console.log(`\n${yamlText}`);
        console.log(`next: pnpm run preview run --name ${name}`);
    }
}

async function cmdRun(args: Args): Promise<void> {
    const name = normalizeName(str(args, 'name') ?? 'default');
    const state = loadState(name);
    const localPlaybook = str(args, 'playbook');
    if (localPlaybook) {
        if (!existsSync(localPlaybook)) {
            throw new Error(`playbook file not found: ${localPlaybook}`);
        }
        const repoDir = state.repoDir ?? '/opt/repo';
        await sshExec(state, `mkdir -p ${repoDir}/.kody`, { timeoutMs: 15_000 });
        scpUpload(state, localPlaybook, `${repoDir}/.kody/environment.yml`);
        console.log(`uploaded ${localPlaybook} -> ${repoDir}/.kody/environment.yml`);
    }
    const playbook = await readRemotePlaybook(state);
    if (!playbook) {
        throw new Error(
            `No ${PLAYBOOK_REMOTE_PATH} on the VM. Run: preview detect --name ${name}`,
        );
    }
    const phaseArg = str(args, 'phase');
    const phases = phaseArg ? [phaseArg] : [...PHASES, 'healthcheck'];
    if (phaseArg && !([...PHASES, 'healthcheck'] as string[]).includes(phaseArg)) {
        throw new Error(`Unknown phase '${phaseArg}'`);
    }
    const timeoutMs = Number(str(args, 'timeout') ?? 1800) * 1000;
    const { ok, results } = await runPlaybook(state, playbook, phases, timeoutMs);
    console.log(`\n=== run ${ok ? 'PASSED' : 'FAILED'} (${results.length} command(s)) ===`);
    process.exitCode = ok ? 0 : 1;
}

/**
 * Runs the playbook's test phase; on failure, hands the failing check +
 * output to the diagnosis agent, which investigates on the VM and reports
 * root cause + suggested fix (the Kody PR-validation story).
 */
async function cmdDiagnose(args: Args): Promise<void> {
    const name = normalizeName(str(args, 'name') ?? 'default');
    const state = loadState(name);
    const playbook = await readRemotePlaybook(state);
    if (!playbook) throw new Error(`No playbook on VM. Run detect first.`);
    const timeoutMs = Number(str(args, 'timeout') ?? 1800) * 1000;
    console.log('running verification (test phase)...');
    const { ok, results } = await runPlaybook(state, playbook, ['test'], timeoutMs);
    if (ok) {
        console.log('\nAll checks passed — nothing to diagnose.');
        return;
    }
    const failed = results[results.length - 1];
    const failureReport =
        `Check FAILED (exit ${failed.exitCode}):\n$ ${failed.command}\n\nOutput:\n${failed.outputTail}\n\n` +
        `Checks that passed before it: ${results.length - 1}`;
    console.log('\nstarting diagnosis agent...');
    const d = await diagnoseFailure(state, failureReport, {
        model: str(args, 'model'),
    });
    console.log(`\n=== DIAGNOSIS (${d.turns} turns, confidence: ${d.confidence}) ===`);
    console.log(`root cause: ${d.rootCause}`);
    console.log(`file:       ${d.file}`);
    console.log(`fix:\n${d.suggestedFix}`);
    console.log(`transcript: ${d.transcriptPath}`);
}

async function cmdExec(args: Args): Promise<void> {
    const name = normalizeName(str(args, 'name') ?? 'default');
    const state = loadState(name);
    const command = str(args, 'rest');
    if (!command) throw new Error('Usage: preview exec --name <n> -- <command>');
    const res = await sshExec(
        state,
        `set -a; [ -f /opt/kody/customer.env ] && . /opt/kody/customer.env; set +a; cd ${state.repoDir ?? '/opt/repo'} 2>/dev/null; ${command}`,
        { timeoutMs: 1800_000, stream: true },
    );
    process.exitCode = res.exitCode;
}

async function cmdStatus(): Promise<void> {
    const states = listStates();
    console.log(`local state (${states.length}):`);
    for (const s of states) {
        console.log(`  ${s.name}  ${s.serverIp}  ${s.repoUrl ?? ''}  created ${s.createdAt}`);
    }
    for (const [kind, tokenVar] of [
        ['digitalocean', 'DIGITALOCEAN_TOKEN'],
        ['hetzner', 'HCLOUD_TOKEN'],
    ] as const) {
        if (!getEnv(tokenVar)) continue;
        const provider = getProvider(kind);
        const live = await provider.listByPrefix(VM_PREFIX);
        console.log(`\nlive VMs on ${provider.kind} (${live.length}):`);
        for (const vm of live) {
            const tracked = states.some((s) => s.serverId === vm.id);
            console.log(`  ${vm.name}  ${vm.ip ?? '-'}  ${vm.status}  created ${vm.createdAt}${tracked ? '' : '  [UNTRACKED - leaked?]'}`);
        }
    }
}

async function cmdDown(args: Args): Promise<void> {
    const names = args.all
        ? listStates().map((s) => s.name)
        : [normalizeName(str(args, 'name') ?? 'default')];
    for (const name of names) {
        const state = loadState(name);
        const provider = getProvider(state.provider);
        console.log(`destroying ${VM_PREFIX}${name} (droplet ${state.serverId})...`);
        await provider.destroy(state.serverId, state.sshKeyId);
        deleteState(name);
        console.log(`env '${name}' destroyed.`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0];
    switch (command) {
        case 'up': return cmdUp(args);
        case 'detect': return cmdDetect(args);
        case 'run': return cmdRun(args);
        case 'diagnose': return cmdDiagnose(args);
        case 'exec': return cmdExec(args);
        case 'ssh': {
            const state = loadState(normalizeName(str(args, 'name') ?? 'default'));
            process.exitCode = await sshInteractive(state);
            return;
        }
        case 'status':
        case 'ls': return cmdStatus();
        case 'down': return cmdDown(args);
        default:
            console.log(USAGE);
            if (command) process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
});
