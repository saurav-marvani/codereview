# Kodus CLI - Integração com API Backend

## Visão Geral

O Kodus CLI é uma ferramenta de code review com IA que analisa mudanças no código via git. Este documento detalha como o CLI se comunica com a API backend.

---

## Arquitetura do Review

### Fluxo Completo

```
1. Usuário executa: kodus review
   ↓
2. CLI detecta mudanças via git (git diff)
   ↓
3. CLI lê arquivos de contexto (.cursorrules, claude.md, etc)
   ↓
4. CLI enriquece diff com contexto
   ↓
5. [MODO NÃO-FAST] CLI lê conteúdo completo de cada arquivo modificado
   ↓
6. CLI monta payload e envia para API
   ↓
7. API analisa e retorna issues
   ↓
8. CLI formata e exibe resultados
```

---

## Endpoints da API

### 1. POST `/cli/review?teamId=<organizationId>` (Autenticado)

**Query Parameters:**
- `teamId` (required): Organization ID extraído do JWT

**Headers:**
```
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Payload:**
```typescript
{
  diff: string;           // Diff unificado de TODAS as mudanças
  config?: {
    severity?: 'info' | 'warning' | 'error' | 'critical';
    rules?: {
      security?: boolean;
      performance?: boolean;
      style?: boolean;
      bestPractices?: boolean;
    };
    rulesOnly?: boolean;  // Se true, só aplica regras configuradas
    fast?: boolean;       // Se true, análise mais rápida
    files?: Array<{       // NOVO: Arquivos completos (só se fast !== true)
      path: string;
      content: string;    // Conteúdo COMPLETO do arquivo
      status: 'added' | 'modified' | 'deleted' | 'renamed';
      diff: string;       // Diff ESPECÍFICO desse arquivo
    }>;
  };
}
```

**Response:**
```typescript
{
  summary: string;
  issues: Array<{
    file: string;
    line: number;
    endLine?: number;
    severity: 'info' | 'warning' | 'error' | 'critical';
    category?: 'security_vulnerability' | 'performance' | 'code_quality' | 'best_practices' | 'style' | 'bug' | 'complexity' | 'maintainability';
    message: string;
    suggestion?: string;
    recommendation?: string;
    ruleId?: string;
    fixable?: boolean;
    fix?: {
      type: 'replace' | 'insert' | 'delete';
      startLine: number;
      endLine: number;
      oldCode: string;
      newCode: string;
    };
  }>;
  filesAnalyzed: number;
  duration: number;
}
```

---

### 2. POST `/cli/trial/review` (Não Autenticado)

**Payload:**
```typescript
{
  diff: string;        // Diff unificado
  fingerprint: string; // Machine ID para rate limiting
  // NÃO INCLUI files[] - trial só recebe diff
}
```

**Response:**
```typescript
{
  summary: string;
  issues: Array<...>;  // Mesmo formato do autenticado
  filesAnalyzed: number;
  duration: number;
  trialInfo: {
    reviewsUsed: number;
    reviewsLimit: number;
    resetsAt: string;  // ISO date
  };
}
```

---

## Diferenças entre Modos

### Modo Normal (default)
```bash
kodus review
```
**Envia:**
- ✅ Diff unificado completo
- ✅ `config.files[]` com conteúdo completo de cada arquivo
- ✅ Diff individual de cada arquivo

### Modo Fast
```bash
kodus review --fast
```
**Envia:**
- ✅ Diff unificado completo
- ❌ `config.files[]` é undefined/null

### Modo Trial (não autenticado)
```bash
kodus review  # sem login
```
**Envia:**
- ✅ Diff unificado completo
- ❌ `config.files[]` NÃO é enviado (sempre como trial)
- ✅ Fingerprint para rate limiting

---

## Exemplos de Payloads

### Exemplo 1: Review Normal (2 arquivos modificados)

```json
POST /cli/review
Authorization: Bearer eyJhbGc...

{
  "diff": "diff --git a/src/index.ts b/src/index.ts\nindex 1234567..abcdefg 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -10,7 +10,7 @@\n-const x = 1;\n+const x = 2;\n\ndiff --git a/src/utils.ts b/src/utils.ts\n...",
  "config": {
    "severity": "warning",
    "rules": {
      "security": true,
      "performance": true,
      "style": true,
      "bestPractices": true
    },
    "rulesOnly": false,
    "fast": false,
    "files": [
      {
        "path": "src/index.ts",
        "content": "import { something } from './utils';\n\nconst x = 2;\n\nexport function main() {\n  console.log(x);\n}\n",
        "status": "modified",
        "diff": "diff --git a/src/index.ts b/src/index.ts\nindex 1234567..abcdefg 100644\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -10,7 +10,7 @@\n-const x = 1;\n+const x = 2;\n"
      },
      {
        "path": "src/utils.ts",
        "content": "export function helper() {\n  return 'updated';\n}\n",
        "status": "modified",
        "diff": "diff --git a/src/utils.ts b/src/utils.ts\n..."
      }
    ]
  }
}
```

### Exemplo 2: Review Fast Mode

```json
POST /cli/review
Authorization: Bearer eyJhbGc...

{
  "diff": "diff --git a/src/index.ts b/src/index.ts\n...",
  "config": {
    "severity": "warning",
    "rules": {
      "security": true,
      "performance": true,
      "style": true,
      "bestPractices": true
    },
    "rulesOnly": false,
    "fast": true
    // files NÃO está presente
  }
}
```

### Exemplo 3: Trial Mode

```json
POST /cli/trial/review

{
  "diff": "diff --git a/src/index.ts b/src/index.ts\n...",
  "fingerprint": "a1b2c3d4e5f6g7h8i9j0"
}
```

---

## Casos de Uso

### 1. Review de Working Tree (padrão)
```bash
kodus review
```
**Comportamento:**
- Pega diff de arquivos staged + unstaged
- Envia conteúdo completo de todos os arquivos modificados

### 2. Review de Staged Files
```bash
kodus review --staged
```
**Comportamento:**
- Pega diff apenas dos arquivos staged
- Envia conteúdo completo apenas dos staged

### 3. Review de Commit Específico
```bash
kodus review --commit HEAD~1
```
**Comportamento:**
- Pega diff do commit
- Lê conteúdo dos arquivos **do commit** (via `git show <commit>:<file>`)

### 4. Review de Arquivos Específicos
```bash
kodus review src/index.ts src/utils.ts
```
**Comportamento:**
- Pega diff apenas desses arquivos
- Envia conteúdo completo apenas desses arquivos

---

## Enriquecimento com Contexto

Antes de enviar, o diff é enriquecido com arquivos de contexto do projeto:

**Arquivos lidos automaticamente:**
- `.cursorrules`
- `claude.md` ou `.claude.md`
- `.kodus.md` ou `.kodus/rules.md`

**Formato final do diff:**
```
=== Cursor Rules (.cursorrules) ===
[conteúdo do .cursorrules]

=== Claude Rules (claude.md) ===
[conteúdo do claude.md]

=== Code Changes ===
diff --git a/src/index.ts b/src/index.ts
...
```

---

## Estrutura de Dados Completa (TypeScript)

```typescript
// Request Types
export interface FileContent {
  path: string;
  content: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  diff: string;
}

export interface ReviewConfig {
  org?: string;
  repo?: string;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  rules?: {
    security?: boolean;
    performance?: boolean;
    style?: boolean;
    bestPractices?: boolean;
  };
  rulesOnly?: boolean;
  fast?: boolean;
  files?: FileContent[];  // NOVO
}

export interface AuthenticatedReviewRequest {
  diff: string;
  config?: ReviewConfig;
}

export interface TrialReviewRequest {
  diff: string;
  fingerprint: string;
}

// Response Types
export interface CodeFix {
  type: 'replace' | 'insert' | 'delete';
  startLine: number;
  endLine: number;
  oldCode: string;
  newCode: string;
}

export interface ReviewIssue {
  file: string;
  line: number;
  endLine?: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category?: 'security_vulnerability' | 'performance' | 'code_quality'
    | 'best_practices' | 'style' | 'bug' | 'complexity' | 'maintainability';
  message: string;
  suggestion?: string;
  recommendation?: string;
  ruleId?: string;
  fixable?: boolean;
  fix?: CodeFix;
}

export interface ReviewResult {
  summary: string;
  issues: ReviewIssue[];
  filesAnalyzed: number;
  duration: number;
}

export interface TrialReviewResult extends ReviewResult {
  trialInfo: {
    reviewsUsed: number;
    reviewsLimit: number;
    resetsAt: string;
  };
}
```

---

## Mudanças Implementadas (Janeiro 2025)

### ✅ NOVA FEATURE: Envio de Arquivos Completos

**Antes:**
- CLI enviava apenas o diff unificado
- API recebia só as linhas modificadas

**Agora:**
- CLI envia diff unificado + conteúdo completo de cada arquivo
- API recebe contexto completo para análise mais inteligente
- `config.files[]` contém:
  - `path`: caminho do arquivo
  - `content`: conteúdo COMPLETO do arquivo (não só diff)
  - `status`: se é adicionado/modificado/deletado/renomeado
  - `diff`: diff ESPECÍFICO desse arquivo

### Flags de controle:

- `--fast`: **NÃO** envia arquivos completos (modo econômico)
- Modo normal: **ENVIA** arquivos completos
- Trial mode: **NÃO** envia arquivos completos (sempre)

---

## Como a API Deve Lidar com Isso

### Backend precisa:

1. **Verificar se `config.files` existe:**
   ```typescript
   if (request.config?.files && request.config.files.length > 0) {
     // Análise com contexto completo
     // Usar `files[].content` para análise completa
     // Usar `files[].diff` para focar nas mudanças
   } else {
     // Análise apenas com diff (modo fast ou trial)
     // Usar apenas `request.diff`
   }
   ```

2. **Estratégia recomendada:**
   - Se `files[]` presente: usar IA com contexto completo do arquivo
   - Se `files[]` ausente: usar IA apenas com diff (mais rápido/barato)

3. **Exemplo de uso na análise:**
   ```typescript
   for (const file of request.config.files) {
     // file.content = arquivo completo (pode ver imports, outras funções, etc)
     // file.diff = só o que mudou (para focar na análise)

     const prompt = `
       Arquivo completo:
       ${file.content}

       Mudanças:
       ${file.diff}

       Analise as mudanças no contexto do arquivo completo.
     `;
   }
   ```

---

## Rate Limiting (Trial Mode)

**Limites atuais:**
- 5 reviews por dia
- 10 arquivos por review
- 500 linhas por arquivo
- Reset: meia-noite (00:00)

**Identificação:**
- `fingerprint`: machine ID único por máquina

---

## Autenticação

**IMPORTANTE:** Signup só via https://app.kodus.io (não via CLI)

### Endpoints de Auth:
- `POST /auth/signup` - Signup (requer `name`, `email`, `password`)
- `POST /auth/login` - Login (retorna `accessToken` e `refreshToken`)
- `POST /auth/refresh` - Refresh token
- `POST /auth/logout` - Logout
- `POST /auth/ci-token` - Gerar token CI/CD

### Token Flow:
1. Login retorna `accessToken` + `refreshToken`
2. CLI guarda em `~/.kodus/credentials.json`
3. Toda request usa `Authorization: Bearer <accessToken>`
4. Se token expira, CLI usa refresh token automaticamente

---

## Telemetria

CLI coleta telemetria anônima via PostHog:

**Eventos enviados:**
- `review_started`
- `review_completed`
- `review_failed`
- `interactive_mode_used`
- `fix_mode_used`

**Dados coletados:**
- Comandos usados
- Flags utilizadas
- Performance (duração, arquivos analisados)
- Quantidade de issues encontradas

**Dados NÃO coletados:**
- Código fonte
- Nomes de arquivos completos
- Secrets/tokens
- Dados pessoais

---

## Próximos Passos para Backend

1. ✅ Adicionar campo `files?: FileContent[]` ao tipo `ReviewConfig`
2. ✅ Atualizar endpoint `/cli/review` para aceitar `files[]`
3. ✅ Implementar lógica de análise com arquivos completos
4. ✅ Manter compatibilidade com requests antigos (sem `files[]`)
5. ✅ Otimizar análise: usar `files[].content` para contexto, `files[].diff` para foco

---

## Testes Manuais

```bash
# Teste 1: Review normal
kodus review
# Deve enviar: diff + files[]

# Teste 2: Review fast
kodus review --fast
# Deve enviar: só diff

# Teste 3: Review staged
kodus review --staged
# Deve enviar: diff staged + files[] dos staged

# Teste 4: Review commit
kodus review --commit HEAD~1
# Deve enviar: diff do commit + files[] do commit

# Teste 5: Arquivos específicos
kodus review src/index.ts
# Deve enviar: diff do arquivo + files[] com só esse arquivo
```

---

## Contato

Para dúvidas sobre a integração, verificar:
- Código fonte: `/Users/gabrielmalinosqui/dev/kodus/cli/`
- Types: `src/types/index.ts`
- API client: `src/services/api/api.real.ts`
- Review service: `src/services/review.service.ts`
