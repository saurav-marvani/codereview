# agent-harness

Harness de agentes **agnóstico de domínio**. Code-review, business-rules,
docs-qa, etc. são **aplicações** construídas em cima daqui — este pacote
não sabe o que é um PR, um diff ou um Finding.

## Regra de dependência (inviolável)

```
domínio (libs/code-review, ...)  ──depende──▶  @libs/agent-harness
@libs/agent-harness                 ──NUNCA──▶   domínio
```

`agent-harness` não importa nada de lib de domínio. Se precisar de algo do
domínio, isso entra via **injeção** (ToolContext.services, AgentSpec,
policies fornecidas pela aplicação) — nunca por import. É ports-and-adapters:
o core define as portas (contracts), a infra/domínio fornece os adapters.

## As camadas

| camada | o que é | onde |
|---|---|---|
| L0 model | acesso model-agnostic (BYOK + Vercel AI SDK) | infra |
| **L1 runtime** | **AgentRunner (1 loop) · Tool · Policy · AgentSpec · RunState** | `domain/contracts` |
| L2 orquestração | sequential · parallel · sub-agente-como-tool | (a construir) |
| L3 aplicação | code-review (Finding, stages, prompts, tools) | `libs/code-review` |

## Os primitivos (L1)

- **Tool** — capacidade isolada `{name, schema, execute}`. Erros são valores, não exceptions.
- **ToolRegistry** — conjunto de tools; suporta `subset()` (gate de activeTools).
- **Policy** — interceptor composável (substitui os hooks inlined). Seams:
  `shouldStop` (=stopWhen), `prepareStep` (=prepareStep), lifecycle (=before/after).
  Cada policy é unit-testável sem LLM: alimenta um `StepView`, asserta o `StepDirectives`.
- **AgentSpec** — papel = **config** (prompt + tools + policies + model). Não classe.
- **AgentRunner** — o **único** loop. finder, verifier, réplicas: todos passam aqui.
- **SubAgentFactory** — expõe um AgentSpec **como tool** (isolamento de contexto, retorna resumo destilado).
- **RunState** — registro **observável por construção** (steps, artifacts, trace). Mata o "funil reconstruído por heurística".

## Princípios (da pesquisa SOTA 2024-2026)

1. **Loop fino + seams** — concern não mora no loop, mora numa Policy composável.
2. **Papel = config, não fork** — um runner só; varia prompt+tools (prática Anthropic).
3. **Sub-agente = tool** — orquestração (réplicas, parent/child) é compor o mesmo runner.
4. **Determinístico testável** — separar o scaffold determinístico do comportamento estocástico do modelo; mockar o model (`ai/test`) e testar policies isoladas.

## Estado

- [x] L1 contracts (`domain/contracts`)
- [ ] L1 infra: AgentRunner sobre Vercel AI SDK (mapeia stopWhen/prepareStep/wrapLanguageModel)
- [ ] Policies extraídas do loop legado (budget, coverage, compression, verify)
- [ ] L2 orquestração
- [ ] Migração strangler do code-review pro core
