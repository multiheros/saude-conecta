#!/usr/bin/env bash
# Prova as duas telas com um navegador real (Playwright), na stack completa e so pelo gateway:
#   1. app do paciente: login, triagem, agendamento com a SAGA na tela, confirmar, trocar e cancelar; emergencia;
#      clique duplo; sessao invalida;
#   2. painel do gestor: numeros, graficos (mouse e teclado), filtros, escala, sem dado pessoal;
#   3. com Notificacoes desligado: compensacao visivel na tela e painel parcial;
#   4. em toda tela: acessibilidade (axe, WCAG 2 A e AA), sem rolagem lateral, claro e escuro.
# Uso: scripts/verificar_telas.sh [pasta]    (~4 min; com pasta, guarda as imagens nela)
set -uo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=saudeconecta-telas GATEWAY_PORTA=${GATEWAY_PORTA:-18082} LIMITE_POR_MINUTO=5000 CACHE_SEGUNDOS=1
G=http://127.0.0.1:$GATEWAY_PORTA
SAIDA=${1:+$(mkdir -p "$1" && cd "$1" && pwd)}; SAIDA=${SAIDA:-$(mktemp -d)}; chmod 777 "$SAIDA"
trap 'docker compose down -v >/dev/null 2>&1' EXIT
espera() { for _ in $(seq 240); do [ "$(eval "$1" 2>/dev/null)" = "$2" ] && return; sleep 0.5; done; echo "  FALHA $1: esperado $2"; exit 1; }
teste()  { docker run --rm --network saudeconecta-telas_frontend --ipc=host -e SEED_SENHA="${SEED_SENHA:-demo12345}" -v "$SAIDA:/saida" saudeconecta-e2e npx playwright test "$@" 2>&1 | grep -E '✓|✘|passed|failed|Error:|Expected|Received'; return "${PIPESTATUS[0]}"; }
cod()    { curl -s -m 5 -o /dev/null -w '%{http_code}' "$@"; }

echo "0. Subindo a stack"
docker build -q -t saudeconecta-e2e clientes/e2e >/dev/null || exit 1
SUBIDA=$(docker compose up -d --build --quiet-pull 2>&1) || { echo "  FALHA nao subiu: $(grep -iE 'error|unhealthy|failed' <<< "$SUBIDA" | tail -3)"; exit 1; }
espera "cod $G/" 200; espera "cod $G/painel" 200; espera "cod $G/health" 200
for _ in $(seq 300); do [ "$(docker inspect -f '{{.State.Status}}' "$(docker compose ps -aq triagem-ingestao 2>/dev/null)")" = exited ] && break; sleep 1; done
for _ in $(seq 10); do G=$G scripts/demo/dados.sh >/dev/null 2>&1 && break; sleep 3; done
echo "1. Telas"; teste --project=paciente --project=gestor || exit 1
echo "2. Com Notificacoes desligado"
docker compose stop notificacoes >/dev/null 2>&1
teste --project=falha || exit 1
echo; echo "TELAS OK"
