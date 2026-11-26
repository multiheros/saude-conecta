#!/usr/bin/env bash
# Prova o RAG na stack real (base -> embeddings -> ChromaDB -> recuperacao -> triagem), num ambiente proprio e
# descartavel:
#   1. a ingestao carrega a base inteira sem internet, e repetir nao duplica;
#   2. a recuperacao traz documento, secao e pagina, e nada para pergunta fora do assunto;
#   3. o agendamento pela SAGA guarda a triagem com as fontes;
#   4. ChromaDB parado ou travado: a SAGA conclui, sem fontes, e as fontes voltam depois;
#   5. base vetorial perdida: a ingestao refaz tudo.
# Uso: scripts/verificar_rag.sh      (~3 min; a ingestao gera os vetores na CPU)
set -uo pipefail
cd "$(dirname "$0")/.."
export GEMINI_API_KEY= DEEPSEEK_API_KEY= # a prova nao gasta a cota do provedor, mesmo com .env preenchido
BUILD=--build; [ -n "${SEM_BUILD:-}" ] && BUILD=--no-build # SEM_BUILD=1: usa as imagens ja prontas
export COMPOSE_PROJECT_NAME=saudeconecta-rag
dc() { docker compose "$@" 2>/dev/null; }
trap 'dc down -v >/dev/null' EXIT
ok()    { echo "  ok    $1"; }
falha() { echo "  FALHA $1"; dc logs triagem triagem-ingestao --tail 12 --no-log-prefix; exit 1; }
igual() { [ "$2" = "$3" ] && ok "$1" || falha "$1: esperado '$3', obtido '$2'"; }
espera()  { for _ in $(seq 120); do [ "$(eval "$1")" = "$2" ] && return; sleep 0.5; done; falha "$1: esperado $2, obtido $(eval "$1")"; }

UBS=a1000000-0000-4000-8000-000000000001
P() { printf 'c1000000-0000-4000-8000-%012d' "$1"; }
sql()   { dc exec -T db-agendamento psql -qtA -U "${AGENDAMENTO_DB_USER:-agendamento}" -d agendamento -c "$1"; }
js()    { dc exec -T agendamento node -e "(async()=>{const J={'content-type':'application/json'};$1})()"; }
agendar() { js "const r=await fetch('http://127.0.0.1:8002/api/v1/agendamentos',{method:'POST',headers:{...J,'X-User-Role':'gestor'},body:JSON.stringify({pacienteId:'$1',slotId:'$(sql "SELECT id FROM slots WHERE ubs_id='$UBS' AND status='LIVRE' AND inicio > now()+interval '3 days' ORDER BY inicio, id LIMIT 1")',sintomas:'dor de cabeca forte e febre ha dois dias',idade:40})});console.log((await r.json()).id)"; }
saga()  { sql "SELECT estado FROM saga_instances WHERE agendamento_id='$1'"; }
# fontes <agendamento>: quantas fontes a triagem da SAGA guardou, e se alguma tem pagina do Caderno
fontes() { dc exec -T triagem python -c "
from app.repositorio import Repositorio
t=Repositorio().db.triagens.find_one({'agendamentoId':'$1'}) or {}
f=t.get('fontes',[]); print(len(f)>0, any(x['pagina'] and 'Caderno' in x['documento'] for x in f))"; }
pronto() { espera "js \"try{console.log((await fetch('http://$1/ready')).status)}catch{}\"" 200; }
ingerir() { dc run --rm --no-deps -T triagem-ingestao; }
buscar() { dc exec -T triagem python -m app.rag.busca "$1"; }
demora() { js "const t=Date.now(),r=await fetch('http://triagem:8003/api/v1/triagens',{method:'POST',headers:{...J,'X-User-Role':'servico','X-Saga-Id':crypto.randomUUID()},body:JSON.stringify({pacienteId:'$(P 9)',sintomas:'dor no peito desde ontem'})});console.log(r.status,(await r.json()).fontes.length>0,Date.now()-t<2500)"; }

echo "0. Subindo a stack"
SUBIDA=$(docker compose up -d $BUILD agendamento pacientes triagem notificacoes rabbitmq db-triagem-vetores triagem-ingestao 2>&1) || falha "nao subiu: $(grep -iE 'error|unhealthy|failed' <<< "$SUBIDA" | tail -3)"
for s in 127.0.0.1:8002 pacientes:8001 triagem:8003 notificacoes:8004; do pronto $s; done
ok "servicos prontos antes da base: a triagem nao espera por ela"

echo "1. Ingestao"
for _ in $(seq 300); do [ "$(docker inspect -f '{{.State.Status}}' "$(dc ps -aq triagem-ingestao)")" = exited ] && break; sleep 1; done
igual "terminou sem erro" "$(docker inspect -f '{{.State.ExitCode}}' "$(dc ps -aq triagem-ingestao)")" 0
echo "        $(dc logs triagem-ingestao --no-log-prefix | tail -1)"
igual "sem rota para a internet" "$(dc run --rm --no-deps -T triagem-ingestao python -c "
import socket
try: socket.create_connection(('1.1.1.1', 443), 3); print('aberta')
except OSError: print('fechada')")" fechada
R=$(ingerir); [[ $R == *"ja esta completa"* ]] && ok "repetir nao duplica: $R" || falha "repeticao: $R"

echo "2. Recuperacao"
R=$(buscar "aperto no peito que vai para o braco"); [[ $R == *"vol. II, p. 12"*"2.13 Dor torácica"* ]] && ok "fonte, secao e pagina" || falha "busca: $R"
sed -n 's/^0/        0/p' <<< "$R"
igual "pergunta fora do assunto nao traz nada" "$(buscar "como faco um bolo de cenoura")" ""

echo "3. Triagem dentro da SAGA"
AG=$(agendar "$(P 1)"); espera "saga $AG" CONCLUIDA; espera "fontes $AG" "True True"; ok "triagem guardada com documento e pagina"

echo "4. ChromaDB indisponivel"
dc stop db-triagem-vetores
igual "parado: triagem responde em menos de 2,5 s, sem fontes" "$(demora)" "201 false true"
AG=$(agendar "$(P 2)"); espera "saga $AG" CONCLUIDA; espera "fontes $AG" "False False"; ok "a SAGA conclui sem a base"
igual "servico continua pronto" "$(js "console.log((await fetch('http://triagem:8003/ready')).status)")" 200
dc start db-triagem-vetores; espera demora "201 true true"; ok "as fontes voltam"
dc pause db-triagem-vetores
igual "travado: triagem responde em menos de 2,5 s, sem fontes" "$(demora)" "201 false true"
dc unpause db-triagem-vetores; espera demora "201 true true"; ok "as fontes voltam"

echo "5. Base vetorial perdida"
dc rm -sfv db-triagem-vetores >/dev/null; docker volume rm saudeconecta-rag_triagem-vetores-data >/dev/null 2>&1
dc up -d --no-deps --wait db-triagem-vetores
espera demora "201 false true"; ok "sem base, a triagem segue"
R=$(ingerir); [[ $R == *" trechos em "* ]] && ok "refeita: $R" || falha "reingestao: $R"
espera demora "201 true true"; ok "as fontes voltam sem reiniciar a triagem"
echo; echo "RAG OK"
