# Structured Outputs Repro

Manual reproduction of the bug filed in the "self-hosted vLLM falls back to
prompt-based JSON" issue: `@ai-sdk/openai-compatible` defaults to
`supportsStructuredOutputs: false`, so the project's structured-output call
sites (`review-structure-fallback` / `verify-structure-fallback` in
`libs/code-review/infrastructure/agents/llm/agent-loop.ts`, and
`dedup-suggestions` in `libs/code-review/pipeline/stages/agent-review.stage.ts`)
send `response_format: { type: "json_object" }` without a schema. vLLM
xgrammar (and the equivalent Structured Outputs path on Moonshot / OpenRouter
/ OpenAI) is bypassed, the LLM falls back to prompt-injected schema
extraction, and the generalist agent runs an order of magnitude slower.

## Why this is not a `*.spec.ts`

Jest's `testMatch` in `jest.config.ts` is
`['**/*.spec.ts', '**/*.integration.spec.ts', '**/*.e2e-spec.ts']`. This file
is named `repro.ts`, so it is invisible to `yarn test`. It is manually invoked
during the fix work and parked here as a regression check.

## Hermetic mode (default)

Stubs `globalThis.fetch`, captures the outgoing chat-completions request body,
and asserts that the project's structured-output factory produces a request
with `response_format.type === "json_schema"`.

```bash
yarn repro:structured-outputs
```

Requires only `API_CRYPTO_KEY` (already in your `.env`; used to encrypt the
dummy BYOK key). No network call.

Expected today (broken state): exits 1, prints
`response_format = {"type":"json_object"}`.

Expected after the fix: exits 0, prints
`response_format = {"type":"json_schema","json_schema":{...}}`.

## Live mode

Passes the captured request through to OpenRouter so we can verify the same
contract against a real provider. Uses `moonshotai/kimi-k2-thinking` by
default (set `REPRO_MODEL` to override).

```bash
yarn repro:structured-outputs --live
```

Requires `API_OPENROUTER_KEY` in addition to `API_CRYPTO_KEY`. Costs cents
per run.

## What the assertions mean

1. **`getInternalModel` structured-output path emits native json_schema** —
   the failing assertion today. Captures the request the SDK would send for
   the `review-structure-fallback` / `dedup-suggestions` call sites.

2. **agentic tool-loop path keeps response_format unset** — guardrail that
   should keep passing both before and after the fix. The proposed fix is
   scoped per-call (only the structured-output sites opt in), so the tool
   loop must stay unchanged.
