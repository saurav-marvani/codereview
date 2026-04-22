#!/usr/bin/env bash
set -euo pipefail

if [ $# -gt 0 ]; then
  ENVIRONMENT=$1
  shift
else
  ENVIRONMENT=local
fi

COMPOSE_FILE="docker-compose.dev.yml"
PROFILE_ARGS=()

case "$ENVIRONMENT" in
  local)
    export ENV_FILE=${ENV_FILE:-.env}
    export API_DATABASE_ENV=${API_DATABASE_ENV:-development}
    # profiling=on por padrao em dev; desative com ENABLE_PROFILING=false
    PROFILE_ARGS=(--profile local-db)
    if [ "${ENABLE_PROFILING:-true}" != "false" ]; then
      PROFILE_ARGS+=(--profile profiling)
    fi
    ENV_LABEL="local"
    ;;
  qa|homolog)
    export ENV_FILE=${ENV_FILE:-.env}
    export API_DATABASE_ENV=${API_DATABASE_ENV:-homolog}
    ENV_LABEL="homolog"
    ;;
  prod|production)
    export ENV_FILE=${ENV_FILE:-.env}
    export API_DATABASE_ENV=${API_DATABASE_ENV:-production}
    ENV_LABEL="production"
    ;;
  *)
    echo "Uso: $0 [local|qa|prod] [comandos docker compose]" >&2
    exit 1
    ;;

esac

if [ ! -f "$ENV_FILE" ]; then
  echo "Arquivo de ambiente '$ENV_FILE' não encontrado. Ajuste suas variáveis no .env ou informe ENV_FILE com o caminho desejado." >&2
  exit 1
fi

if [ $# -eq 0 ]; then
  set -- up
fi

echo "Iniciando docker compose ($ENV_LABEL) com arquivo $ENV_FILE ..."

if [ ${#PROFILE_ARGS[@]} -gt 0 ]; then
  docker compose -f "$COMPOSE_FILE" "${PROFILE_ARGS[@]}" "$@"
else
  docker compose -f "$COMPOSE_FILE" "$@"
fi
