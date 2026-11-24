#!/usr/bin/env bash
# Avaliacao do RAG e medida de latencia com o modelo real. Usa a chave do .env e GASTA COTA (~110 + ~70 chamadas).
#   scripts/avaliar_rag.sh             coleta (retoma de onde parou) e mostra o relatorio
#   scripts/avaliar_rag.sh relatorio   so o relatorio, sem chamar o modelo
#   scripts/avaliar_rag.sh confirmar   12 perguntas novas, com o resultado final de producao
#   scripts/avaliar_rag.sh latencia    mede latencia e tokens
set -uo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=saudeconecta-avaliacao
py() { docker compose run --rm --no-deps -T -u "$(id -u)" -e PYTHONPATH=/app -e AVALIACAO_DIR=/avaliacao -v "$PWD/services/triagem/avaliacao:/avaliacao" triagem python "$@" 2> >(grep -v -iE 'warn|request = ' >&2); }
if [ "${1:-}" != relatorio ]; then
  trap 'docker compose down >/dev/null 2>&1' EXIT # o volume fica: a base nao precisa ser refeita
  docker compose up -d $([ -n "${SEM_BUILD:-}" ] && echo --no-build || echo --build) --wait db-triagem db-triagem-vetores >/dev/null 2>&1
  docker compose run --rm --no-deps -T triagem-ingestao 2>/dev/null || exit 1
fi
case ${1:-} in
  relatorio) py /avaliacao/avaliar.py relatorio ;;
  confirmar) py /avaliacao/confirmar.py ;;
  latencia)  py /avaliacao/latencia.py ${2:-} ;;
  *)         py /avaliacao/avaliar.py && py /avaliacao/avaliar.py relatorio ;;
esac
