# Como Testar CLI com API Local

A API não está rodando ainda. Siga os passos abaixo para testar a integração completa.

---

## 1. Subir a API

```bash
# No diretório da API (kodus-ai)
cd /Users/gabrielmalinosqui/dev/kodus/kodus-ai
npm run dev
```

A API deve subir em **http://localhost:3001**

---

## 2. Verificar se API está rodando

```bash
curl http://localhost:3001/health
```

Ou:

```bash
lsof -i :3001
```

---

## 3. Configurar CLI para usar API local

```bash
export KODUS_API_URL="http://localhost:3001"
```

---

## 4. Rodar Suite de Testes Automáticos

```bash
cd /Users/gabrielmalinosqui/dev/kodus/cli
./test-api-integration.sh
```

Esse script vai:
- ✅ Verificar se API está rodando
- ✅ Testar Fast Mode (só diff)
- ✅ Testar Normal Mode (diff + files)
- ✅ Testar CLI completo (review, fast, staged)
- ✅ Validar formato das respostas

---

## 5. Testes Manuais Rápidos

### 5.1 Teste simples via curl

```bash
curl -X POST http://localhost:3001/cli/trial/review \
  -H "Content-Type: application/json" \
  -d '{
    "diff": "diff --git a/test.js b/test.js\n+const x = 1;",
    "fingerprint": "my-device",
    "config": {"fast": true}
  }'
```

### 5.2 Teste Fast Mode com CLI

```bash
export KODUS_API_URL="http://localhost:3001"
node dist/index.js review src/types/index.ts --fast
```

**Esperado:**
- Resposta rápida (~10ms)
- Manda só `diff`
- `config.files` é undefined

### 5.3 Teste Normal Mode com CLI

```bash
export KODUS_API_URL="http://localhost:3001"
node dist/index.js review src/types/index.ts
```

**Esperado:**
- Resposta mais lenta (~30-60s com LLM)
- Manda `diff` + `config.files[]`
- `files[0].content` contém arquivo completo
- `files[0].diff` contém diff específico

### 5.4 Teste com múltiplos arquivos

```bash
export KODUS_API_URL="http://localhost:3001"
node dist/index.js review src/types/index.ts src/services/git.service.ts
```

**Esperado:**
- `config.files[]` com 2 elementos

### 5.5 Teste com staged files

```bash
export KODUS_API_URL="http://localhost:3001"
node dist/index.js review --staged
```

---

## 6. Validar Payload Enviado

Para ver o que o CLI está mandando, use o mock mode com logs:

```bash
# Editar src/services/api/api.real.ts e adicionar console.log antes do fetch
# Ou usar proxy/interceptor
```

Ou configure a API para logar o body do request.

---

## 7. Testar Detecção de Vulnerabilidades

Crie um arquivo com vulnerabilidade:

```bash
cat > /tmp/vulnerable.js << 'EOF'
// SQL Injection
function getUserData(userId) {
  const query = "SELECT * FROM users WHERE id = " + userId;
  return db.execute(query);
}

// XSS
app.get('/search', (req, res) => {
  res.send('<h1>Results: ' + req.query.q + '</h1>');
});
EOF

git add /tmp/vulnerable.js
export KODUS_API_URL="http://localhost:3001"
node dist/index.js review /tmp/vulnerable.js
```

**Esperado:**
- Issues detectados: SQL Injection, XSS
- Severity: `error` ou `critical`
- Sugestões de correção

---

## 8. Troubleshooting

### CLI não conecta na API

**Sintoma:**
```
Review failed
Connection refused
```

**Solução:**
1. Verificar se API está rodando: `lsof -i :3001`
2. Verificar variável de ambiente: `echo $KODUS_API_URL`
3. Testar API direto: `curl http://localhost:3001/health`

### API retorna 429 (Rate Limited)

**Sintoma:**
```
{"error": "Rate limit exceeded", "resetAt": "..."}
```

**Solução:**
- Aguardar 1 hora OU
- Usar endpoint autenticado (`/cli/review`) OU
- Mudar fingerprint

### API retorna "No issues found" sempre

**Causa:** Fast Mode não executa análise LLM completa

**Solução:** Usar modo normal (sem `--fast`)

### Timeout errors

**Causa:** Análise LLM demora ~30-60s

**Solução:**
- Aumentar timeout no CLI (default 120s)
- Ou usar `--fast` para análise rápida

---

## 9. Estrutura do Payload Enviado

### Fast Mode
```json
{
  "diff": "[unified diff completo]",
  "config": {
    "fast": true,
    "severity": "warning",
    "rules": {...}
  }
}
```

### Normal Mode
```json
{
  "diff": "[unified diff completo]",
  "config": {
    "fast": false,
    "severity": "warning",
    "rules": {...},
    "files": [
      {
        "path": "src/index.ts",
        "content": "[ARQUIVO COMPLETO]",
        "status": "modified",
        "diff": "[DIFF ESPECÍFICO DO ARQUIVO]"
      }
    ]
  }
}
```

---

## 10. Expected Response Format

```json
{
  "summary": "Found 2 issues in 1 file",
  "issues": [
    {
      "file": "dangerous.js",
      "line": 3,
      "severity": "error",
      "category": "security_vulnerability",
      "message": "SQL Injection vulnerability detected",
      "suggestion": "Use parameterized queries",
      "ruleId": "security/sql-injection",
      "fixable": true,
      "fix": {
        "type": "replace",
        "startLine": 3,
        "endLine": 3,
        "oldCode": "const query = \"SELECT * FROM users WHERE id = \" + userId;",
        "newCode": "const query = \"SELECT * FROM users WHERE id = ?\"; db.execute(query, [userId]);"
      }
    }
  ],
  "filesAnalyzed": 1,
  "duration": 45230
}
```

---

## Status da Integração

✅ CLI envia payloads corretos
✅ CLI suporta Fast Mode (só diff)
✅ CLI suporta Normal Mode (diff + files)
✅ CLI lê conteúdo completo dos arquivos
✅ CLI lê diff individual por arquivo
✅ CLI funciona com staged, commit, files específicos
⏳ API precisa estar rodando em localhost:3001
⏳ Validar formato de resposta da API
⏳ Testar detecção de vulnerabilidades real

---

## Próximos Passos

1. ✅ Subir API em localhost:3001
2. ✅ Rodar `./test-api-integration.sh`
3. ✅ Validar que Normal Mode detecta vulnerabilidades
4. ✅ Testar todos os casos de uso (staged, commit, files)
5. ✅ Ajustar timeouts se necessário
6. ✅ Deploy da API para produção

---

## Arquivos Relacionados

- `test-api-integration.sh` - Suite de testes automatizada
- `CLI_API_INTEGRATION.md` - Documentação completa da integração
- `src/services/api/api.real.ts` - Cliente HTTP da API
- `src/services/review.service.ts` - Lógica de review
- `src/types/index.ts` - Types do payload
