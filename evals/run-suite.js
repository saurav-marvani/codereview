// Code-review eval suite — runs the replay evals for ONE model. The per-PR/
// per-model replacement for the live QA benchmark: same engine code, same tier-0
// models, but via deterministic tool replay (no deploy, no live reviews).
//
//   node evals/run-suite.js --model=gpt-5.4 [--prs=5] [--runs=3] [--enforce]
//
// Exit-code policy (so a broken model never looks green — problem #3):
//   - INFRA error in any eval (no key, bad model id, crash) → suite ALWAYS fails.
//   - GATE failure (a quality threshold) → reported; fails the suite only with
//     --enforce (off by default = post-merge monitor while thresholds calibrate).
//
// Per-eval exit codes the suite reads: 0 = pass, 1 = gate-fail, 2 = infra. The
// deterministic evals (kody-rules, anchoring) honor this contract. The promptfoo
// evals (finder, promotion) can't cleanly separate gate-vs-infra on their exit
// code yet, so they run REPORT-ONLY (logged, never block) until classified.
const { spawnSync } = require('child_process');
const path = require('path');
const { TIER0, promptfooFlags } = require('./shared/tier0-models');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const MODEL = args.model || 'gpt-5.4';
const PRS = +(args.prs || 5);
const RUNS = +(args.runs || 3);
const ENFORCE = !!args.enforce;
const ROOT = path.join(__dirname, '..');

if (!TIER0[MODEL]) {
    console.error(`unknown tier-0 model '${MODEL}' (known: ${Object.keys(TIER0).join(', ')})`);
    process.exit(2);
}

// kind: 'gate'   → exit-code contract honored (0 pass / 1 gate / 2 infra), gates.
//       'report' → promptfoo/non-gated eval; runs for coverage, never blocks (yet).
// Secondary-pass evals default to --mock so PR CI needs no LLM keys. Live
// multi-model matrix: evals/dedup/run-matrix.js + severity/format --model=.
const SUITE = [
    { name: 'dedup', kind: 'gate',
      cmd: ['node', 'evals/dedup/run.js', '--mock=identity', '--gate'] },
    { name: 'severity', kind: 'gate',
      cmd: ['node', 'evals/severity/run.js', '--mock=heuristic', '--gate'] },
    { name: 'format', kind: 'gate',
      cmd: ['node', 'evals/format/run.js', '--mock=perfect', '--gate'] },
    { name: 'kody-rules', kind: 'gate',
      cmd: ['node', 'evals/kody-rules/real-agent.js', '--dataset=github-cases', '--gate', `--model=${MODEL}`, `--runs=${RUNS}`, `--limit=${PRS}`] },
    { name: 'anchoring', kind: 'gate',
      cmd: ['node', 'evals/anchoring/anchor-eval.js', '--gate', `--model=${MODEL}`, `--limit=${PRS}`] },
    { name: 'finder-recall', kind: 'gate',
      cmd: ['node', 'evals/investigation/run-recall.js', '--set=pr', '--gate', `--model=${MODEL}`] },
    { name: 'promotion', kind: 'report',
      cmd: ['node', 'evals/promotion/run-eval.js', '--no-cache', ...promptfooFlags(MODEL)] },
];

function run(step) {
    console.log(`\n┌─ eval: ${step.name} (model=${MODEL})  [${step.kind === 'gate' ? 'GATING' : 'report-only'}]`);
    const r = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: ROOT, stdio: 'inherit', env: process.env });
    const code = r.status;
    let status;
    if (r.error || code === null) status = 'infra';           // failed to spawn / killed
    else if (code === 0) status = 'pass';
    else if (step.kind === 'gate') status = code === 1 ? 'gate' : 'infra'; // 1=gate, 2+=infra
    else status = 'report-fail';                              // promptfoo non-zero: report-only
    console.log(`└─ ${step.name}: ${{ pass: '✅ pass', gate: '⚠️ gate-fail', infra: '❌ INFRA ERROR', 'report-fail': '⚠️ report-fail (non-blocking)', skip: '⏭️ skip' }[status]} (exit ${code})`);
    return { name: step.name, kind: step.kind, status };
}

console.log(`════ code-review eval suite · model=${MODEL} · ${PRS} PRs · ${RUNS} runs${ENFORCE ? ' · ENFORCE' : ' · monitor'} ════`);
const results = SUITE.map(run);

console.log(`\n════ SUITE SUMMARY (${MODEL}) ════`);
for (const r of results) console.log(`  ${{ pass: '✅', gate: '⚠️', infra: '❌', 'report-fail': '⚠️', skip: '⏭️' }[r.status]} ${r.name} (${r.status})`);

const infra = results.filter((r) => r.status === 'infra');
const gateFails = results.filter((r) => r.status === 'gate');

// Infra errors ALWAYS fail — a misrouted/broken model must never look green.
if (infra.length) {
    console.error(`\n❌ SUITE FAILED for ${MODEL}: infra error in ${infra.map((r) => r.name).join(', ')} (broken model/key/crash — not a quality result)`);
    process.exit(2);
}
// Gate failures fail only under --enforce (monitor mode while calibrating).
if (gateFails.length) {
    if (ENFORCE) {
        console.error(`\n❌ SUITE FAILED for ${MODEL}: gate(s) ${gateFails.map((r) => r.name).join(', ')}`);
        process.exit(1);
    }
    console.log(`\n⚠️  ${MODEL}: gate(s) ${gateFails.map((r) => r.name).join(', ')} below threshold (monitor mode — not blocking)`);
}
console.log(`\n✅ SUITE OK for ${MODEL}${gateFails.length ? ' (gate warnings above)' : ''}`);
