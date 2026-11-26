#!/usr/bin/env bash
# Prova a SAGA na stack real (4 servicos, 4 bancos, RabbitMQ), num ambiente proprio e descartavel:
#   1. caminho feliz, conferido em cada banco;
#   2. Notificacoes desligado: compensacao em cascata 3 -> 2 -> 1, e o paciente consegue agendar depois;
#   3. Triagem travada e morta durante a compensacao: fica pendente e termina quando ela volta;
#   4. dois pacientes no mesmo horario;
#   5. kill -9 no Agendamento no meio da SAGA: outra execucao retoma.
# Uso: scripts/verificar_saga.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export GEMINI_API_KEY= DEEPSEEK_API_KEY= # a prova nao gasta a cota do provedor, mesmo com .env preenchido
BUILD=--build; [ -n "${SEM_BUILD:-}" ] && BUILD=--no-build # SEM_BUILD=1: usa as imagens ja prontas
export COMPOSE_PROJECT_NAME=saudeconecta-saga
dc() { docker compose "$@" 2>/dev/null; }
trap 'dc down -v >/dev/null' EXIT
ok()    { echo "  ok    $1"; }
falha() { echo "  FALHA $1"; dc logs agendamento --tail 12 --no-log-prefix; exit 1; }
igual() { [ "$2" = "$3" ] && ok "$1" || falha "$1: esperado '$3', obtido '$2'"; }

P() { printf 'c1000000-0000-4000-8000-%012d' "$1"; }
sql()      { dc exec -T db-agendamento psql -qtA -U "${AGENDAMENTO_DB_USER:-agendamento}" -d agendamento -c "$1"; }
flag()     { dc exec -T db-pacientes psql -qtA -U "${PACIENTES_DB_USER:-pacientes}" -d pacientes -c "SELECT count(agendamento_saga_id) FROM pacientes WHERE id='$1'"; }
triagens() { dc exec -T db-triagem mongosh --quiet -u "${TRIAGEM_DB_USER:-triagem}" -p "${TRIAGEM_DB_PASSWORD:-troque-me-triagem}" triagem --authenticationDatabase admin --eval "db.triagens.countDocuments({pacienteId:'$1'})"; }
notifs()   { dc exec -T db-notificacoes redis-cli --raw ZCARD "pac:$1"; }
# js <codigo>: roda no container do Agendamento, dentro da rede interna
js() { dc exec -T agendamento node -e "(async()=>{const h={'content-type':'application/json'};const gestor={...h,'X-User-Role':'gestor'};$1})()"; }
agendar() { js "const r=await fetch('http://127.0.0.1:8002/api/v1/agendamentos',{method:'POST',headers:{...h,'X-User-Role':'paciente','X-User-Id':'$1'},body:JSON.stringify({pacienteId:'$1',slotId:'$2',sintomas:'tosse e coriza ha dois dias',idade:40})});console.log((await r.json()).id)"; }
saga() { sql "SELECT estado FROM saga_instances WHERE agendamento_id='$1'"; }
historico() { sql "SELECT string_agg(left(tipo,1)||left(passo,1)||':'||resultado, ' ' ORDER BY l.id) FROM saga_log l JOIN saga_instances s ON s.id=l.saga_id WHERE agendamento_id='$1'"; }
livre() { sql "SELECT id FROM slots WHERE status='LIVRE' AND inicio > now()+interval '3 days' ORDER BY inicio, id OFFSET $1 LIMIT 1"; }
ate() { for _ in $(seq 150); do [[ " $2 " == *" $(saga "$1") "* ]] && return; sleep 0.2; done; falha "SAGA parou em $(saga "$1") (esperado: $2)"; }
espera() { for _ in $(seq 60); do [ "$(eval "$1")" = "$2" ] && return; sleep 0.25; done; falha "$1: esperado $2, obtido $(eval "$1")"; }
pronto() { for _ in $(seq 100); do [ "$(js "try{console.log((await fetch('http://$1/ready')).status)}catch{}")" = 200 ] && return; sleep 0.3; done; falha "$1 nao ficou pronto"; }

echo "0. Subindo os quatro servicos"
SUBIDA=$(docker compose up -d $BUILD agendamento pacientes triagem notificacoes rabbitmq 2>&1) || falha "nao subiu: $(grep -iE 'error|unhealthy|failed' <<< "$SUBIDA" | tail -3)"
for s in 127.0.0.1:8002 pacientes:8001 triagem:8003 notificacoes:8004; do pronto $s; done
ok "prontos"

echo "1. Caminho feliz"
A=$(P 1); S=$(livre 0); AG=$(agendar "$A" "$S"); ate "$AG" CONCLUIDA
igual "historico" "$(historico "$AG")" "A1:OK A2:OK A3:OK A4:OK"
igual "PostgreSQL Agendamento: agendamento e vaga" "$(sql "SELECT a.status||' '||s.status FROM agendamentos a JOIN slots s ON s.id=slot_id WHERE a.id='$AG'")" "AGENDADO RESERVADO"
igual "MongoDB Triagem: 1 triagem" "$(triagens "$A")" 1
igual "Redis Notificacoes: 3 notificacoes" "$(notifs "$A")" 3
espera "flag $A" 0; ok "PostgreSQL Pacientes: flag limpa pelo evento AgendamentoCriado"
igual "tempo da SAGA abaixo de 3 s" "$(sql "SELECT atualizado_em-criado_em < interval '3 s' FROM saga_instances WHERE agendamento_id='$AG'")" t

echo "2. Notificacoes desligado"
B=$(P 2); S2=$(livre 0)
dc stop notificacoes; AG=$(agendar "$B" "$S2"); ate "$AG" "FALHOU COMPENSACAO_PENDENTE"
igual "cascata 3 -> 2 -> 1" "$(historico "$AG")" "A1:OK A2:OK A3:OK A4:FALHA C3:OK C2:OK C1:OK"
igual "estado final" "$(saga "$AG")" FALHOU
igual "vaga livre de novo" "$(sql "SELECT status FROM slots WHERE id='$S2'")" LIVRE
igual "triagem descartada" "$(triagens "$B")" 0
igual "flag do paciente limpa" "$(flag "$B")" 0
dc start notificacoes; pronto notificacoes:8004
AG=$(agendar "$B" "$S2"); ate "$AG" CONCLUIDA; ok "o mesmo paciente agenda o mesmo horario depois"

echo "3. Compensacao com participante fora"
C=$(P 3); S3=$(livre 0)
dc pause notificacoes; AG=$(agendar "$C" "$S3")
for _ in $(seq 100); do [ "$(sql "SELECT passo_atual FROM saga_instances WHERE agendamento_id='$AG'")" = 4 ] && break; sleep 0.1; done
dc kill -s KILL triagem
ate "$AG" COMPENSACAO_PENDENTE
igual "vaga liberada sem esperar a Triagem" "$(sql "SELECT status FROM slots WHERE id='$S3'")" LIVRE
igual "flag limpa sem esperar a Triagem" "$(flag "$C")" 0
dc unpause notificacoes; dc up -d triagem; pronto triagem:8003; ate "$AG" FALHOU
igual "triagem descartada quando o servico voltou" "$(triagens "$C")" 0
[ "$(dc exec -T db-notificacoes redis-cli --raw EVAL "local n=0 for _,id in ipairs(redis.call('ZRANGE','pac:$C',0,-1)) do if redis.call('HGET','n:'..id,'status')=='AGENDADA' then n=n+1 end end return n" 0)" = 0 ] && ok "nenhuma notificacao ativa" || falha "notificacao orfa"

echo "4. Dois pacientes no mesmo horario"
S4=$(livre 0); D=$(agendar "$(P 4)" "$S4"); E=$(agendar "$(P 5)" "$S4")
ate "$D" "CONCLUIDA FALHOU"; ate "$E" "CONCLUIDA FALHOU"
igual "um agenda, o outro e compensado" "$(printf '%s\n%s\n' "$(saga "$D")" "$(saga "$E")" | sort | tr '\n' ' ')" "CONCLUIDA FALHOU "
igual "uma reserva ativa" "$(sql "SELECT count(*) FROM agendamentos WHERE slot_id='$S4' AND status='AGENDADO'")" 1

echo "5. kill -9 no Agendamento no meio da SAGA"
F=$(P 6); S5=$(livre 0)
dc pause pacientes; AG=$(agendar "$F" "$S5")
for _ in $(seq 100); do [ "$(sql "SELECT passo_atual FROM saga_instances WHERE agendamento_id='$AG'")" = 2 ] && break; sleep 0.1; done
dc kill -s KILL agendamento; dc unpause pacientes
igual "SAGA parada no passo 2" "$(sql "SELECT estado||' '||passo_atual FROM saga_instances WHERE agendamento_id='$AG'")" "EM_ANDAMENTO 2"
dc up -d agendamento; pronto 127.0.0.1:8002; ate "$AG" CONCLUIDA
igual "retomada sem repetir a triagem" "$(triagens "$F") $(historico "$AG")" "1 A1:OK A2:OK A3:OK A4:OK"
echo; echo "SAGA OK"
