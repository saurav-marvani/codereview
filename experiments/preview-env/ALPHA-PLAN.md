# Preview-env → Kody alpha: complementary integration plan

Answers every integration question, mapped to the REAL kodus-ai pipeline, with
reusable-vs-net-new. Correction baked in: **the preview-env is COMPLEMENTARY,
not a sandbox swap.** e2b stays the sandbox for the normal review's file tools;
the preview VM is its own thing that runs the app + a bug-finding agent, in
parallel, and merges its findings into the same downstream.

## DESIGN CORRECTION (PR2 was wrong)
- WRONG: register VmSandboxProvider as the global `SANDBOX_PROVIDER=vm` — that
  REPLACES e2b, breaking the normal review's grep/read/cross-file tools.
- RIGHT: `RunPreviewEnvStage` owns the VM lifecycle directly (via a
  PreviewEnvService wrapping vm-client). The global sandbox provider stays e2b.
  The VM is used ONLY to boot+exercise the app and run the validate agent.
  Keep vm-client.ts; drop the SANDBOX_PROVIDER=vm registration.

## Where it plugs in (the pipeline)
Main strategy order already has `RunPreviewEnvStage` between createSandbox and
agentReview. For the alpha it must run **in parallel-effect** (independent of
agentReview) and MERGE findings, not replace. It:
1. boots the app from `environment:` playbook (already does),
2. runs the bug-finding agent (validate recipe) → produces findings WITH proof,
3. appends them to `context.validSuggestions` as `CodeSuggestion[]`.

## The 10 questions, answered

**1. Onde liga em config?** DONE — `environment:` on `CodeReviewConfig`
(`codeReview.type.ts`), in `default-kodus-config.yml` + `codereview.json`.
Opt-in per repo via `environment.enabled` (default false). Committed
`kodus-config.yml`, read by `codeBaseConfig.service.ts`.

**2. Arquivo de install?** DONE — `environment.setup` / `environment.build`
(command lists) are the install/build steps; the detect agent authors them or
the customer edits. Run in the VM by `RunPreviewEnvStage`.

**3. .env / secrets?** NET-NEW. `environment.requiredEnv` (var NAMES) exists in
the type but is INERT (referenced nowhere at runtime). Build: a new encrypted
per-repo secret store (reuse the BYOK pattern: `organizationParameters` +
`crypto.encrypt`, new key e.g. `environment_secrets` keyed by repoId) + an
injection step in the stage that writes them into the VM's env before boot.

**4. Vai pro dedup?** NET-NEW. Dedup is LLM-based INSIDE agentReview
(`deduplicateSuggestions()`), before `validSuggestions` is set → preview
findings appended after won't be deduped. Fix: run the preview agent, then
inject its findings into the list BEFORE agentReview's dedup call (or add a
small post-dedup pass keyed on file+line+similarity). Preferred: a post-merge
dedup step so preview + normal findings are deduped together.

**5. Vai pro verify?** The old "is this a real bug" verify was REMOVED (hurt
recall). `validateSuggestions` is only the *committable* (Apply-button)
validator. So **the preview-env's executed proof IS the verification** — that's
the whole point (execution > reasoning). Preview findings carry their repro.

**6. Paralelo + centralizar?** YES — preview findings become `CodeSuggestion`
in the SAME `context.validSuggestions`, so they centralize with normal findings
through createFileComments → aggregateResults → summary → gating. Complementary,
one unified comment set.

**7. Como vai pro git? Formato?** Via `commentManagerService.createLineComments`
(the existing path). A finding = `Partial<CodeSuggestion>`
(relevantFile/relevantLinesStart/End, severity, suggestionContent, label). Posts
as a normal line comment. To mark provenance, set a distinct `label`
(e.g. `kody_preview_env`) so the UI/summary can badge "verified by running it".

**8. Como mandar a prova junto?** NET-NEW (small). No evidence field on the
comment. Put the executed proof as a **collapsed markdown block** appended to
`suggestionContent`:
```
<details><summary>✅ Reproduced by running it</summary>
$ <command>
<real output>
expected X, got Y
</details>
```
Optionally a link to the artifact bundle (browser video/trace) once persisted.

**9. Onde ficam os logs?** NET-NEW. `ObservabilityService` is token/trace only —
no artifact/blob store. For alpha: persist the agent transcript + VM phase logs
+ browser artifacts to the existing `AutomationExecutionEntity.dataExecution`
(JSON) keyed by the review run, and/or a new lightweight artifacts table; link
from the comment. Full blob store (S3) is post-alpha.

**10. Comando / automático / CLI?** automatic (webhook) + `@kody` command
ALREADY route through the main `CodeReviewPipeline` that contains
`RunPreviewEnvStage` → they get preview-env for free once the stage produces
findings. **CLI is a SEPARATE strategy** (`CliReviewPipelineStrategy`) without
the stage → NET-NEW: add `RunPreviewEnvStage` to the CLI strategy too.

## Alpha build order (net-new, on the feature branch, not merged)
1. **Fix PR2**: drop SANDBOX_PROVIDER=vm; a `PreviewEnvService` owns the VM
   (vm-client) so e2b is untouched. (complementary)
2. **Findings spine**: `RunPreviewEnvStage` runs the validate agent → maps each
   finding to `Partial<CodeSuggestion>` (severity, file, lines, suggestionContent
   + the `<details>` proof block, label `kody_preview_env`) → appends to
   `context.validSuggestions`. → flows to comments + critical gating for free.
3. **Dedup**: post-merge dedup of preview vs normal findings (file+line first,
   LLM similarity fallback).
4. **Secrets**: encrypted per-repo `environment_secrets` store + inject into VM.
5. **CLI**: add the stage to CliReviewPipelineStrategy.
6. **Artifacts/logs**: persist transcript + phase logs + browser artifacts to
   dataExecution; link from the comment.

Alpha-minimum = 1+2 (+ gating, which is free). 3-6 harden it.
