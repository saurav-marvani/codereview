// Code-review eval suite — runs the replay evals for ONE model and gates on the
// deterministic ones. This is the per-PR/per-model replacement for the live QA
// benchmark: same engine code, same tier-0 models, but via deterministic tool
// replay (no deploy, no live reviews).
//
//   node evals/run-suite.js --model=gpt-5.4 [--prs=5] [--runs=3]
//
// Exit non-zero if any GATING eval fails. Non-gating evals (still being
// calibrated) run report-only so a flaky threshold can't block CI yet.
const { spawnSync } = require('child_process');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const MODEL = args.model || 'gpt-5.4';
const PRS = +(args.prs || 5);
const RUNS = +(args.runs || 3);
const ROOT = path.join(__dirname, '..');

// Each entry: a real-engine replay eval invoked per-model. `gate: true` means a
// non-zero exit fails the suite (the eval owns its own thresholds via --gate).
const SUITE = [
    {
        name: 'kody-rules',
        gate: true,
        cmd: ['node', 'evals/kody-rules/real-agent.js', '--dataset=github-cases', '--gate', `--model=${MODEL}`, `--runs=${RUNS}`, `--limit=${PRS}`],
    },
    {
        name: 'anchoring',
        gate: true,
        cmd: ['node', 'evals/anchoring/anchor-eval.js', '--gate', `--model=${MODEL}`, `--limit=${PRS}`],
    },
    // TODO (follow-up): wire the promptfoo evals (finder-recall, promotion,
    // safeguard, dedup) per-model and promote to gate once their thresholds are
    // calibrated for the CI sample size. They run in their own jobs today.
];

function run(step) {
    console.log(`\n┌─ eval: ${step.name} (model=${MODEL})  ${step.gate ? '[GATING]' : '[report-only]'}`);
    const r = spawnSync(step.cmd[0], step.cmd.slice(1), { cwd: ROOT, stdio: 'inherit', env: process.env });
    const ok = r.status === 0;
    console.log(`└─ ${step.name}: ${ok ? '✅ pass' : '❌ fail'} (exit ${r.status})`);
    return ok;
}

console.log(`════ code-review eval suite · model=${MODEL} · ${PRS} PRs · ${RUNS} runs ════`);
const results = SUITE.map((s) => ({ name: s.name, gate: s.gate, ok: run(s) }));

console.log(`\n════ SUITE SUMMARY (${MODEL}) ════`);
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.gate ? '' : ' (report-only)'}`);

const gatingFails = results.filter((r) => r.gate && !r.ok);
if (gatingFails.length) {
    console.error(`\n❌ SUITE FAILED for ${MODEL}: ${gatingFails.map((r) => r.name).join(', ')}`);
    process.exit(1);
}
console.log(`\n✅ SUITE PASSED for ${MODEL}`);
