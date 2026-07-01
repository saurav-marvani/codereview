# Prose-findings recovery eval

Two layers validate the prose-findings recovery (`recoverFindingsFromProse` /
`extractFindingsWithRecovery` in `finder.agent.ts`) — the fallback that recovers
findings when the model writes them as prose in `reasoning` and omits the
`suggestions` array (the dominant Anthropic omission mode).

## Layer 1 — wiring (deterministic, in CI)

`libs/code-review/infrastructure/agents/core/finder.agent.spec.ts` →
`describe('prose-findings recovery')`. No LLM: a mocked recoverer + hand-built
`RunState` fixtures assert the logic that silently breaks in refactors:

- `extractFindings` **preserves the prose** `reasoning` when `suggestions` is omitted.
- `extractFindingsWithRecovery` only calls the recoverer when `suggestions` is
  empty, passes it the prose, merges the result, keeps empty on no-recovery, and
  is a safe no-op when no recoverer is injected.

Run: `pnpm test --testPathPatterns="finder.agent.spec"`

## Layer 2 — recovery quality (real LLM, on demand)

`run.js` + `fixtures.json`. Feeds REAL captured prose payloads through the ACTUAL
production `recoverFindingsFromProse` (via `getInternalModel`, same per-mode
resolution prod uses) and checks the recovery is faithful: it extracts at least
the expected number of findings and references the right files.

Not a CI test — it calls a real LLM and is non-deterministic.

```bash
# cloud path (gpt-5.4-mini):
API_OPEN_AI_API_KEY=$BYOK_OPENAI_API_KEY node evals/parser/run.js
```

Fixtures are Sonnet-5 reasoning-only payloads captured from the finder-recall
eval. Add new ones to `fixtures.json` as new omission shapes appear.
