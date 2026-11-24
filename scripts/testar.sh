#!/usr/bin/env bash
# Roda os testes de todos os servicos e BFFs (ou dos informados), em ambiente descartavel.
set -uo pipefail
cd "$(dirname "$0")/.."
dc() { docker compose -f docker-compose.test.yml "$@"; }
trap 'dc down -v >/dev/null 2>&1' EXIT
erro=0
for s in "${@:-agendamento pacientes notificacoes triagem bff-web bff-admin}"; do for servico in $s; do
  echo "== $servico"
  dc build -q "$servico" >/dev/null 2>&1 || { echo "build falhou"; erro=1; continue; }
  saida=$(dc run --rm "$servico" 2>/dev/null) || erro=1
  grep -E '^(✖|ℹ (tests|pass|fail)|FAILED|ERROR|E  |[0-9]+ (passed|failed)|.*AssertionError|.*Error:)' <<< "$saida"
done; done
exit $erro
