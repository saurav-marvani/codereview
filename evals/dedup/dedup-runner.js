// Invokes the REAL production dedup decision (prompt + schema from
// libs/.../llm/dedup-prompt.ts) on a list of suggestions, on ANY model — so we
// can A/B which small model dedups well (production defaults to gemini-3-flash,
// but Google can get rate-denied; this finds resilient alternatives).
// Loaded via ts-node so it reads the live TS prompt module — no drift.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { generateObject, jsonSchema } = require('ai');
const {
    buildDedupPrompt,
    DEDUP_SCHEMA,
    DEDUP_MODEL_ID,
} = require('@libs/code-review/infrastructure/agents/llm/dedup-prompt');

const normSeverity = (s) => (s == null ? 'medium' : String(s).toLowerCase());

// Model registry for the dedup A/B. provider drives which SDK + key env.
// `default` is production's model. Add small candidates here.
const DEDUP_MODELS = {
    'gemini-3-flash': { provider: 'google', model: 'gemini-3-flash-preview', keyEnv: ['API_GOOGLE_AI_API_KEY', 'BYOK_GOOGLE_API_KEY'] },
    'gemini-2.5-flash': { provider: 'google', model: 'gemini-2.5-flash', keyEnv: ['API_GOOGLE_AI_API_KEY', 'BYOK_GOOGLE_API_KEY'] },
    'haiku-4.5': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', keyEnv: ['ANTHROPIC_API_KEY', 'BYOK_ANTHROPIC_API_KEY'] },
    'kimi-k2.7': { provider: 'openai-compatible', model: 'kimi-k2.7-code', baseURL: 'https://api.moonshot.ai/v1', keyEnv: ['BYOK_MOONSHOT_API_KEY'] },
    'glm-5.1': { provider: 'openai-compatible', model: 'glm-5.1', baseURL: 'https://api.z.ai/api/paas/v4', keyEnv: ['BYOK_ZHIPU_API_KEY'] },
    'gpt-5.4-mini': { provider: 'openai', model: 'gpt-5.4-mini', keyEnv: ['BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'] },
    'deepseek-v4': { provider: 'openai-compatible', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com', keyEnv: ['DEEPSEEK_API_KEY'] },
};

function resolveKey(keyEnvs) {
    for (const e of keyEnvs) if (process.env[e]) return process.env[e];
    return null;
}

async function buildModel(spec) {
    const apiKey = resolveKey(spec.keyEnv);
    if (!apiKey) throw new Error(`no key (${spec.keyEnv.join('/')})`);
    if (spec.provider === 'google') {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        return createGoogleGenerativeAI({ apiKey })(spec.model);
    }
    if (spec.provider === 'anthropic') {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({ apiKey })(spec.model);
    }
    if (spec.provider === 'openai') {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({ apiKey })(spec.model);
    }
    if (spec.provider === 'openai-compatible') {
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        return createOpenAICompatible({ name: spec.provider, apiKey, baseURL: spec.baseURL })(spec.model);
    }
    throw new Error(`unsupported provider ${spec.provider}`);
}

/**
 * @param {Array} suggestions
 * @param {string} modelKey   key into DEDUP_MODELS (default 'gemini-3-flash' = prod)
 */
async function runDedup(suggestions, modelKey = 'gpt-5.4-mini') {
    if (suggestions.length <= 1) {
        return { groups: [], unique: suggestions.map((_, i) => i), kept: suggestions.map((_, i) => i), dropped: [], unmentioned: [], raw: { skipped: true } };
    }
    const spec = DEDUP_MODELS[modelKey];
    if (!spec) throw new Error(`unknown dedup model '${modelKey}' (have: ${Object.keys(DEDUP_MODELS).join(', ')})`);
    const model = await buildModel(spec);

    const { object } = await generateObject({
        model,
        schema: jsonSchema(DEDUP_SCHEMA),
        prompt: buildDedupPrompt(suggestions, normSeverity),
    });

    const rawGroups = Array.isArray(object?.groups) ? object.groups : [];
    const rawUnique = Array.isArray(object?.unique) ? object.unique : [];
    const n = suggestions.length;
    const valid = (i) => Number.isInteger(i) && i >= 0 && i < n;

    // Small models often drift from the exact schema (kimi returns
    // {representative:"[0] file", discarded:[]} instead of {keep:0,duplicates:[]}).
    // Coerce index | "[i] ..." → number; accept keep|representative and
    // duplicates|discarded. Track whether the EXACT schema was honored — that
    // reliability signal is itself a model-selection criterion for dedup.
    let schemaExact = true;
    const toIdx = (v) => {
        if (Number.isInteger(v)) return v;
        if (typeof v === 'string') { const m = v.match(/^\s*\[(\d+)\]/); if (m) { schemaExact = false; return +m[1]; } }
        schemaExact = false; return NaN;
    };
    const groups = rawGroups.map((g) => {
        if (g && (g.keep === undefined) && g.representative !== undefined) schemaExact = false;
        const keep = toIdx(g?.keep ?? g?.representative);
        const dupsRaw = g?.duplicates ?? g?.discarded ?? [];
        return { keep, duplicates: (Array.isArray(dupsRaw) ? dupsRaw : []).map(toIdx) };
    });
    const unique = rawUnique.map(toIdx);

    const kept = new Set();
    for (const i of unique) if (valid(i)) kept.add(i);
    for (const g of groups) if (valid(g?.keep)) kept.add(g.keep);

    const seenAsDup = new Set();
    for (const g of groups) for (const d of g?.duplicates || []) if (valid(d) && d !== g.keep) seenAsDup.add(d);
    const dropped = [];
    for (const d of seenAsDup) if (!kept.has(d)) {
        const into = groups.find((g) => (g.duplicates || []).includes(d))?.keep;
        dropped.push({ idx: d, keptInto: into });
    }

    const accounted = new Set([...kept, ...dropped.map((x) => x.idx)]);
    const unmentioned = [];
    for (let i = 0; i < n; i++) if (!accounted.has(i)) unmentioned.push(i);

    // Production safety: if the model returned nothing usable, keep all (the
    // stage does the same). Flag it — a model that frequently no-ops here is a
    // poor dedup driver regardless of how "safe" keeping-all is.
    let noOp = false;
    if (kept.size === 0 && dropped.length === 0) {
        noOp = true;
        for (let i = 0; i < n; i++) kept.add(i);
        unmentioned.length = 0;
    }

    return { groups, unique, kept: [...kept].sort((a, b) => a - b), dropped, unmentioned, schemaExact, noOp, raw: object };
}

module.exports = { runDedup, DEDUP_MODELS };
