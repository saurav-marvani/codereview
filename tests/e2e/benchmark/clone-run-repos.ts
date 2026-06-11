// Clone a fresh, single-use repo-set for ONE farm benchmark run.
//
// Each run needs its OWN copy of the 5 dataset repos because parallel runs
// collide on a repo's single webhook owner, and re-opening PRs on a reused repo
// leaks prior review comments into the next review. So we mint pristine clones
// kodus-e2e/<base>-<RUN_ID> and throw them away at the end of the run.
//
// Mechanic (mirrors provision-repos.ts): git mirror the dataset's source repo
// (ai-code-review-benchmark/<base>) once, then force-push ONLY the head+base
// branches the run's 50 PRs need into the per-run copy. Template-generate
// flattens history + drops PR branches, so it must be a real mirror+push.
//
// Run OUTSIDE the network sandbox (large git upload):
//   GH_TEST_TOKEN=$(gh auth token) FARM_RUN_ID=<id> tsx benchmark/clone-run-repos.ts
//   GH_TEST_TOKEN=$(gh auth token) FARM_RUN_ID=<id> tsx benchmark/clone-run-repos.ts --destroy
import { execSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORG = "kodus-e2e";
const TOKEN = process.env.GH_TEST_TOKEN || process.env.GH_DEV_TOKEN;
if (!TOKEN) throw new Error("GH_TEST_TOKEN not set");
const RUN_ID = process.env.FARM_RUN_ID;
if (!RUN_ID) throw new Error("FARM_RUN_ID not set");
const DESTROY = process.argv.includes("--destroy");

interface BenchPR { repo: string; head: string; base: string }

function loadPRs(): BenchPR[] {
    const p = join(process.cwd(), "..", "..", "scripts", "benchmark", "prs-benchmark.json");
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return (raw.prs ?? raw) as BenchPR[];
}

function sh(cmd: string, cwd?: string): string {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}
function gh(args: string): string {
    return sh(`gh ${args}`);
}
const authUrl = (repo: string) => `https://x-access-token:${TOKEN}@github.com/${repo}.git`;

function repoExists(full: string): boolean {
    try { gh(`api repos/${full} --jq .full_name`); return true; } catch { return false; }
}
function branchSha(full: string, branch: string): string | null {
    try { return gh(`api repos/${full}/branches/${encodeURIComponent(branch)} --jq .commit.sha`).trim(); } catch { return null; }
}
function createRepo(name: string): void {
    if (repoExists(`${ORG}/${name}`)) return;
    gh(`api -X POST orgs/${ORG}/repos -f name=${name} -F private=false -f description="farm benchmark run ${RUN_ID} (single-use clone)"`);
    console.log(`  + created ${ORG}/${name}`);
}

// base repo -> the distinct branches its PRs need (heads + their bases)
function branchesByBase(prs: BenchPR[]): Map<string, { source: string; branches: Set<string> }> {
    const m = new Map<string, { source: string; branches: Set<string> }>();
    for (const pr of prs) {
        const base = pr.repo.split("/")[1];
        if (!m.has(base)) m.set(base, { source: pr.repo, branches: new Set() });
        const e = m.get(base)!;
        e.branches.add(pr.head);
        e.branches.add(pr.base);
    }
    return m;
}

function provision(): void {
    const byBase = branchesByBase(loadPRs());
    console.log(`Provisioning ${byBase.size} clones for run ${RUN_ID} (kodus-e2e/<base>-${RUN_ID})`);
    for (const [base, { source, branches }] of byBase) {
        const name = `${base}-${RUN_ID}`;
        const full = `${ORG}/${name}`;
        const work = mkdtempSync(join(tmpdir(), `farm-clone-${base}-`));
        const mirror = join(work, "src.git");
        try {
            console.log(`[${base}] mirroring ${source} (${branches.size} branches)…`);
            sh(`git clone --mirror --quiet ${authUrl(source)} ${mirror}`);
            createRepo(name);
            // The PR base branch becomes the repo default for a clean PR target.
            const defaultBranch = [...branches].find((b) => /^(master|main)$/.test(b)) ?? [...branches][0];
            const refspecs = [...branches].map((b) => `refs/heads/${b}:refs/heads/${b}`).join(" ");
            console.log(`  -> force-pushing ${branches.size} branches to ${name}…`);
            sh(`git push --force --quiet ${authUrl(full)} ${refspecs}`, mirror);
            try { gh(`api -X PATCH repos/${full} -f default_branch=${defaultBranch}`); } catch { /* best-effort */ }
            console.log(`  ok ${name} ready`);
        } finally {
            if (existsSync(work)) rmSync(work, { recursive: true, force: true });
        }
    }
    console.log("done.");
}

function destroy(): void {
    const byBase = branchesByBase(loadPRs());
    console.log(`Destroying ${byBase.size} clones for run ${RUN_ID}`);
    for (const base of byBase.keys()) {
        const full = `${ORG}/${base}-${RUN_ID}`;
        if (!repoExists(full)) { console.log(`  = ${full} already gone`); continue; }
        try { gh(`api -X DELETE repos/${full}`); console.log(`  - deleted ${full}`); }
        catch (e) { console.error(`  ! failed to delete ${full}: ${(e as Error).message}`); }
    }
    console.log("done.");
}

(DESTROY ? destroy : provision)();
