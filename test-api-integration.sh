#!/bin/bash

# Script de Testes - Kodus CLI com API Local
# API deve estar rodando em localhost:3001

set -e

API_URL="http://localhost:3001"
CLI_BIN="node dist/index.js"

echo "🧪 Kodus CLI API Integration Tests"
echo "===================================="
echo ""

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Função auxiliar
test_api() {
  local test_name="$1"
  local endpoint="$2"
  local payload="$3"

  echo -e "${YELLOW}Testing:${NC} $test_name"

  response=$(curl -s -w "\n%{http_code}" -X POST "$API_URL$endpoint" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>&1)

  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | head -n -1)

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    echo -e "${GREEN}✓ Pass${NC} (HTTP $http_code)"
    echo "$body" | jq '.' 2>/dev/null || echo "$body"
  else
    echo -e "${RED}✗ Fail${NC} (HTTP $http_code)"
    echo "$body"
  fi

  echo ""
}

# 1. Verificar se API está rodando
echo "1️⃣  Checking if API is running..."
if ! curl -s "$API_URL/health" > /dev/null 2>&1; then
  echo -e "${RED}✗ API is not running on $API_URL${NC}"
  echo "Start the API first: cd kodus-ai && npm run dev"
  exit 1
fi
echo -e "${GREEN}✓ API is running${NC}"
echo ""

# 2. Teste Fast Mode (só diff)
test_api \
  "Fast Mode - Trial Review" \
  "/cli/trial/review" \
  '{
    "diff": "diff --git a/test.js b/test.js\nindex abc123..def456 100644\n--- a/test.js\n+++ b/test.js\n@@ -1,1 +1,2 @@\n-const x = 1;\n+const x = 2;",
    "fingerprint": "test-fast-mode",
    "config": {
      "fast": true
    }
  }'

# 3. Teste Normal Mode com arquivo completo
test_api \
  "Normal Mode - With File Content" \
  "/cli/trial/review" \
  '{
    "diff": "diff --git a/dangerous.js b/dangerous.js\nindex abc123..def456 100644\n--- a/dangerous.js\n+++ b/dangerous.js\n@@ -1,3 +1,10 @@\n+// SQL Injection\n+function getUserData(userId) {\n+  const query = \"SELECT * FROM users WHERE id = \" + userId;\n+  return db.execute(query);\n+}",
    "fingerprint": "test-normal-mode",
    "config": {
      "fast": false,
      "files": [{
        "path": "dangerous.js",
        "content": "// SQL Injection\nfunction getUserData(userId) {\n  const query = \"SELECT * FROM users WHERE id = \" + userId;\n  return db.execute(query);\n}",
        "status": "added",
        "diff": "diff --git a/dangerous.js b/dangerous.js\nindex abc123..def456 100644\n--- a/dangerous.js\n+++ b/dangerous.js\n@@ -1,3 +1,10 @@\n+// SQL Injection\n+function getUserData(userId) {\n+  const query = \"SELECT * FROM users WHERE id = \" + userId;\n+  return db.execute(query);\n+}"
      }]
    }
  }'

# 4. Teste com CLI real
echo "4️⃣  Testing with Real CLI..."
echo ""

# Build CLI
echo "Building CLI..."
npm run build > /dev/null 2>&1
echo -e "${GREEN}✓ CLI built${NC}"
echo ""

# Configurar API URL
export KODUS_API_URL="http://localhost:3001"

# Teste 1: Review com arquivo específico
echo -e "${YELLOW}Test:${NC} CLI Review with specific file"
$CLI_BIN review src/types/index.ts --format json --quiet 2>&1 | jq '.' || echo "Failed"
echo ""

# Teste 2: Review fast mode
echo -e "${YELLOW}Test:${NC} CLI Review with --fast flag"
$CLI_BIN review src/types/index.ts --fast --format json --quiet 2>&1 | jq '.' || echo "Failed"
echo ""

# Teste 3: Review staged
echo -e "${YELLOW}Test:${NC} CLI Review with --staged"
$CLI_BIN review --staged --format json --quiet 2>&1 | jq '.' || echo "Failed"
echo ""

echo "===================================="
echo -e "${GREEN}✓ Tests completed${NC}"
echo ""
echo "Notes:"
echo "- Fast Mode should return quickly (~10ms)"
echo "- Normal Mode should detect vulnerabilities (~30-60s)"
echo "- CLI should send config.files[] in Normal Mode"
