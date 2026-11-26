#!/usr/bin/env bash
# Prova que a stack sobe e funciona sem internet, com as imagens ja preparadas (scripts/preparar.sh):
#   sem baixar nem construir nada; servicos sem rota para fora; login, triagem por regras com fontes do RAG, SAGA e painel.
# Uso: scripts/verificar_offline.sh     (~2 min; porta 18085)
set -uo pipefail
cd "$(dirname "$0")/.."
export GEMINI_API_KEY= DEEPSEEK_API_KEY= # a prova nao gasta a cota do provedor, mesmo com .env preenchido
export COMPOSE_PROJECT_NAME=saudeconecta-offline GATEWAY_PORTA=${GATEWAY_PORTA:-18085} LIMITE_POR_MINUTO=2000 COMPOSE_FILE=docker-compose.yml:scripts/offline.compose.yml
G=http://127.0.0.1:$GATEWAY_PORTA
trap 'docker compose down -v >/dev/null 2>&1' EXIT
ok()    { echo "  ok    $1"; }
falha() { echo "  FALHA $1"; exit 1; }
igual() { [ "$2" = "$3" ] && ok "$1" || falha "$1: esperado '$3', obtido '$2'"; }
espera() { for _ in $(seq 240); do [ "$(eval "$1" 2>/dev/null)" = "$2" ] && return; sleep 0.5; done; falha "$1: esperado $2, obtido $(eval "$1")"; }
cod()   { curl -s -m 5 -o /dev/null -w '%{http_code}' "$@"; }
login() { curl -s "$G/api/v1/auth/login" -H 'content-type: application/json' -d "{\"cpf\":\"$1\",\"senha\":\"${SEED_SENHA:-demo12345}\"}" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'; }

echo "1. Subida sem construir e sem baixar"
SUBIDA=$(docker compose up -d --no-build --pull never 2>&1) || falha "nao subiu: $(tail -3 <<< "$SUBIDA")"
espera "cod $G/health" 200; espera "cod $G/" 200; espera "login 10000000108 | cut -c1-3" eyJ; ok "gateway, telas e login"
for _ in $(seq 400); do [ "$(docker inspect -f '{{.State.Status}}' "$(docker compose ps -aq triagem-ingestao)")" = exited ] && break; sleep 1; done
igual "base do RAG carregada" "$(docker inspect -f '{{.State.ExitCode}}' "$(docker compose ps -aq triagem-ingestao)")" 0
for s in triagem pacientes; do igual "$s sem rota para a internet" "$(docker compose exec -T $s $([ $s = triagem ] && echo "python -c" || echo "node -e") "$([ $s = triagem ] && echo "
import socket
try: socket.create_connection(('1.1.1.1', 443), 3); print('aberta')
except OSError: print('fechada')" || echo "const c=require('net').connect({host:'1.1.1.1',port:443,timeout:3000});const f=(t)=>{console.log(t);process.exit()};c.on('connect',()=>f('aberta'));c.on('error',()=>f('fechada'));c.on('timeout',()=>f('fechada'))")")" fechada; done

echo "2. Funciona sem internet"
A="Authorization: Bearer $(login 10000000108)"
w() { curl -s -m 25 -X "$1" -H "$A" -H 'content-type: application/json' ${3:+-d "$3"} "$G$2"; }
espera "w GET '/web/v1/horarios' | grep -c slotId" 1
R=$(w POST /web/v1/triagem '{"sintomas":"dor de garganta ha dois dias"}')
igual "triagem por regras" "$(grep -o '"origem":"[A-Z]*"' <<< "$R")" '"origem":"REGRAS"'
[[ $R == *"Caderno de Atenção Básica"* ]] && ok "com fontes do RAG" || falha "sem fontes: $R"
S=$(grep -o '"slotId":"[^"]*' <<< "$R" | head -1 | cut -d'"' -f4)
ID=$(w POST /web/v1/agendamentos "{\"slotId\":\"$S\",\"sintomas\":\"dor de garganta ha dois dias\"}" | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
espera "w GET /web/v1/agendamentos/$ID/andamento | grep -o '\"estado\":\"[A-Z]*\"'" '"estado":"CONCLUIDA"'; ok "SAGA conclui"
igual "painel do gestor" "$(cod -H "Authorization: Bearer $(login 90000000175)" "$G/admin/v1/agendamentos/resumo?ubsId=a1000000-0000-4000-8000-000000000001&periodo=$(date +%Y-%m)")" 200
echo; echo "OFFLINE OK"
