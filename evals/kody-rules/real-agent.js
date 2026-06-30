// Kody-rules adherence eval — REAL ENGINE (not a prototype).
//
// Runs the production `KodyRulesAgentProvider.execute()` end-to-end: the same
// system/category/user prompts, the same agent loop (runAgentLoop), the same
// verify / coverage-recovery / second-chance passes, the same ruleUuid
// reconciliation and @@PATH_MISMATCH@@ drop. Tools are served from a
// deterministic replay (no sandbox / GitHub), exactly like the finder eval.
//
//   node evals/kody-rules/real-agent.js [--runs=3] [--model=gpt-5.4-mini]
//
// The model is driven through the real `byokToVercelModel` self-hosted path:
// API_LLM_PROVIDER_MODEL + API_OPEN_AI_API_KEY (+ optional API_OPENAI_FORCE_BASE_URL).
// esbuild require-hook for .ts (NOT ts-node): agent-loop.ts places value
// imports mid-file (line 296), which ts-node/transpile-only leaves un-hoisted →
// "Cannot access 'llm_1' before initialization". esbuild hoists imports
// correctly, so the real provider graph loads.
const fs = require('fs');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });

if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const RUNS = +(args.runs || 3);
const MODELKEY = args.model || 'gpt-5.4-mini';
const DATASET = args.dataset || 'github-cases';
// CI gate: with --gate, exit non-zero if metrics fall below baselines. Thresholds
// are tunable (--occ-min=, --spec-min=) and reflect the validated gpt-5.4 numbers
// with a margin (occ-recall 82%, specificity 100%).
const GATE = !!args.gate;
const OCC_MIN = +(args['occ-min'] || 70);
const SPEC_MIN = +(args['spec-min'] || 95);

// Model presets → drive the real self-hosted byokToVercelModel path via env.
const MODELS = {
    'gpt-5.4-mini': { model: 'gpt-5.4-mini', keyEnv: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'gpt-5.4': { model: 'gpt-5.4', keyEnv: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'deepseek-v4-pro': { model: 'deepseek-v4-pro', keyEnv: ['DO_MODEL_ACCESS_KEY'], baseURL: 'https://inference.do-ai.run/v1' },
    'sonnet-4.6': { model: 'anthropic-claude-4.6-sonnet', keyEnv: ['DO_MODEL_ACCESS_KEY'], baseURL: 'https://inference.do-ai.run/v1' },
};

const cases = require('./' + DATASET);

// --- replay (same shape/semantics as evals/investigation/agent-provider.js) ---
function normalizePath(v) { return String(v || '').replace(/^\/+/, '').replace(/\\/g, '/').replace(/\/+/g, '/'); }
function fixtureMatches(match, actual) {
    return Object.entries(match || {}).every(([k, exp]) => {
        if (exp == null) return true;
        const a = actual[k];
        if (k.toLowerCase().includes('path')) return normalizePath(exp) === normalizePath(a);
        return exp === a;
    });
}
class ReplayRemoteCommands {
    constructor(replay) {
        this.replay = replay || {};
        this.calls = [];
        this.unexpectedCalls = [];
        this.corpus = (this.replay.readFile || [])
            .map((e) => ({ path: normalizePath(e?.match?.path), content: String(e?.result || '') }))
            .filter((e) => e.path && e.content);
    }
    _find(kind, actual) { return (this.replay[kind] || []).find((e) => fixtureMatches(e.match || {}, actual)) || null; }
    _searchCorpus(actual) {
        let rx; try { rx = new RegExp(String(actual.pattern || '')); } catch { rx = new RegExp(String(actual.pattern || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
        const out = [];
        for (const e of this.corpus) {
            if (actual.path && actual.path !== '.' && e.path !== actual.path && !e.path.startsWith(actual.path + '/')) continue;
            const lines = e.content.split('\n');
            for (let i = 0; i < lines.length; i++) { rx.lastIndex = 0; if (rx.test(lines[i])) { out.push(`${e.path}:${i + 1}:${lines[i]}`); if (out.length >= 40) return out.join('\n'); } }
        }
        return out.length ? out.join('\n') : null;
    }
    async grep(pattern, searchPath, glob) {
        const actual = { pattern: pattern || '', path: normalizePath(searchPath || '.'), glob: glob || '' };
        const f = this._find('grep', actual);
        if (f) { this.calls.push({ kind: 'grep', actual, matched: true }); return f.result || ''; }
        const s = this._searchCorpus(actual);
        if (s !== null) { this.calls.push({ kind: 'grep', actual, matched: 'synthetic' }); return s; }
        this.calls.push({ kind: 'grep', actual, matched: false }); this.unexpectedCalls.push({ kind: 'grep', actual }); return 'No matches found.';
    }
    async read(filePath, start, end) {
        const actual = { path: normalizePath(filePath), startLine: start || 0, endLine: end || 0 };
        const f = this._find('readFile', actual);
        this.calls.push({ kind: 'readFile', actual, matched: !!f }); if (!f) this.unexpectedCalls.push({ kind: 'readFile', actual });
        return f ? (f.result || '') : `No replay fixture matched readFile(${actual.path}).`;
    }
    async listDir(dirPath) {
        const actual = { path: normalizePath(dirPath || '.') };
        const f = this._find('listDir', actual);
        this.calls.push({ kind: 'listDir', actual, matched: !!f }); return f ? (f.result || '') : '';
    }
}

function buildProvider() {
    const { KodyRulesAgentProvider } = require(path.join(__dirname, '../../libs/code-review/infrastructure/agents/kody-rules-agent.provider.ts'));
    const permissionValidationService = { getBYOKConfig: async () => null };
    const observabilityService = {
        runInSpan: async (_n, fn) => (typeof fn === 'function' ? fn() : undefined),
        runLLMInSpan: async ({ exec }) => exec([]),
        startSpan: () => ({ end() {}, update() {} }),
    };
    return new KodyRulesAgentProvider({}, permissionValidationService, observabilityService);
}

// Normalize a real-diff case into the pieces the runner needs: the changedFiles
// to review, the tool replay, and the violating/clean file ground truth. Cases
// come from build-bench-cases.js (benchmark diffs) or harvest-github-cases.js
// (live GitHub PRs) — both carry real `realChangedFiles` + `toolReplay`.
function normalizeCase(c) {
    return {
        changedFiles: c.realChangedFiles.map((f) => ({ filename: f.filename, patchWithLinesStr: f.patchWithLinesStr || f.patch || '', patch: f.patch || f.patchWithLinesStr || '' })),
        replay: c.toolReplay || {},
        violFiles: (c.violatingFiles || []).map(normalizePath),
        okFiles: (c.cleanFiles || []).map(normalizePath),
        fileCount: c.realChangedFiles.length,
    };
}

async function runCase(provider, c, changedFiles, replay) {
    const remoteCommands = new ReplayRemoteCommands(replay);
    const out = await provider.execute({
        organizationAndTeamData: { organizationId: 'eval-org', teamId: 'eval-team' },
        changedFiles,
        remoteCommands,
        prNumber: 1,
        repositoryId: 'eval-repo',
        repositoryFullName: 'eval/repo',
        baseBranch: 'main',
        reviewMode: 'normal',
        maxSteps: c.maxSteps || 20,
        prTitle: c.title || 'eval PR',
        prBody: c.body || '',
        kodyRules: [{ ...c.rule, type: 'standard', status: 'active', scope: c.rule.scope || 'file' }],
    });
    return out.suggestions || [];
}

async function main() {
    const spec = MODELS[MODELKEY];
    if (!spec) throw new Error(`unknown model ${MODELKEY}`);
    const key = spec.keyEnv.map((e) => process.env[e]).find(Boolean);
    if (!key) throw new Error(`no key (${spec.keyEnv.join('/')})`);
    // Drive the real self-hosted model seam.
    process.env.API_LLM_PROVIDER_MODEL = spec.model;
    process.env.API_OPEN_AI_API_KEY = key;
    if (spec.baseURL) process.env.API_OPENAI_FORCE_BASE_URL = spec.baseURL;

    const provider = buildProvider();

    const LINE_TOL = 2; // a flag "lands" on a real site if within ±2 lines
    let multiTotalSites = 0, multiCaughtSites = 0, caughtAllRuns = 0, totalMultiRuns = 0;
    let cleanFiles = 0, falseAlarmFiles = 0;
    // occurrence-level (only for cases that carry per-line groundTruth)
    let occTotal = 0, occCaught = 0, lineNoiseTotal = 0, flaggedTotal = 0;
    const haveGT = cases.some((c) => c.groundTruth);
    // flatten groundTruth → [{file, line}]
    const gtSites = (c) => Object.entries(c.groundTruth || {})
        .flatMap(([fn, hits]) => hits.map((h) => ({ file: normalizePath(fn), line: h.line })));
    for (const c of cases) {
        const { changedFiles, replay, violFiles, okFiles, fileCount } = normalizeCase(c);
        const sites = gtSites(c);
        const perRun = [];
        for (let r = 0; r < RUNS; r++) {
            let sugg = [];
            try { sugg = await runCase(provider, c, changedFiles, replay); }
            catch (e) { console.error(`  [case ${c.rule.uuid} run ${r}] ${String(e.message).slice(0, 140)}`); }
            const flaggedFiles = new Set(sugg.map((s) => normalizePath(s.relevantFile)).filter(Boolean));
            const hit = violFiles.filter((f) => flaggedFiles.has(f)).length;
            const falseOnClean = okFiles.filter((f) => flaggedFiles.has(f)).length;
            // occurrence-level: distinct real sites covered by some flag (±tol)
            const flags = sugg.map((s) => ({ file: normalizePath(s.relevantFile), line: s.relevantLinesStart })).filter((x) => x.file && Number.isFinite(x.line));
            const coveredSites = sites.filter((g) => flags.some((x) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
            const onTargetFlags = flags.filter((x) => sites.some((g) => x.file === g.file && Math.abs(x.line - g.line) <= LINE_TOL)).length;
            perRun.push({ hit, falseOnClean, coveredSites, flags: flags.length, lineNoise: flags.length - onTargetFlags });
        }
        const N = violFiles.length;
        const allRuns = perRun.filter((p) => p.hit >= N).length;
        multiTotalSites += N * RUNS; multiCaughtSites += perRun.reduce((a, b) => a + b.hit, 0);
        caughtAllRuns += allRuns; totalMultiRuns += RUNS;
        cleanFiles += okFiles.length * RUNS; falseAlarmFiles += perRun.reduce((a, b) => a + b.falseOnClean, 0);
        if (c.groundTruth) {
            occTotal += sites.length * RUNS; occCaught += perRun.reduce((a, b) => a + b.coveredSites, 0);
            lineNoiseTotal += perRun.reduce((a, b) => a + b.lineNoise, 0); flaggedTotal += perRun.reduce((a, b) => a + b.flags, 0);
            console.log(`${c.rule.uuid.padEnd(22)} files=${fileCount} sites=${sites.length}  file-hits/run=[${perRun.map((p) => p.hit).join(',')}]  occ-caught/run=[${perRun.map((p) => p.coveredSites).join(',')}]  flags/run=[${perRun.map((p) => p.flags).join(',')}]`);
        } else {
            console.log(`${c.rule.uuid.padEnd(22)} files=${fileCount} viol=${N}  hits/run=[${perRun.map((p) => p.hit).join(',')}]  caught-all ${allRuns}/${RUNS}  false-on-clean ${perRun.reduce((a, b) => a + b.falseOnClean, 0)}`);
        }
    }
    const pct = (a, b) => (b ? (100 * a / b).toFixed(0) : '—');
    console.log(`\n════ kody-rules adherence — REAL ENGINE (${MODELKEY}, ${RUNS} runs/case) ════`);
    console.log(`FILE-level recall:    ${pct(multiCaughtSites, multiTotalSites)}%  (${multiCaughtSites}/${multiTotalSites} violating files flagged ≥once)`);
    if (haveGT) {
        console.log(`OCCURRENCE recall:    ${pct(occCaught, occTotal)}%  (${occCaught}/${occTotal} real in-diff sites flagged, ±${LINE_TOL} lines)  ← did it catch EVERY spot`);
        console.log(`line precision:       ${pct(flaggedTotal - lineNoiseTotal, flaggedTotal)}%  (${lineNoiseTotal}/${flaggedTotal} flags landed off any real site)`);
    }
    console.log(`specificity (files):  ${pct(cleanFiles - falseAlarmFiles, cleanFiles)}%  (${falseAlarmFiles}/${cleanFiles} clean files false-alarmed)`);

    if (GATE) {
        const occ = occTotal ? (100 * occCaught / occTotal) : 0;
        const spec = cleanFiles ? (100 * (cleanFiles - falseAlarmFiles) / cleanFiles) : 100;
        const fails = [];
        if (haveGT && occ < OCC_MIN) fails.push(`occurrence-recall ${occ.toFixed(0)}% < ${OCC_MIN}%`);
        if (spec < SPEC_MIN) fails.push(`specificity ${spec.toFixed(0)}% < ${SPEC_MIN}%`);
        if (fails.length) { console.error(`\n❌ GATE FAILED: ${fails.join('; ')}`); process.exit(1); }
        console.log(`\n✅ GATE PASSED (occurrence-recall ≥ ${OCC_MIN}%, specificity ≥ ${SPEC_MIN}%)`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
