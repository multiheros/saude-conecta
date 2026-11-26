#!/usr/bin/env bash
# Prova o Transactional Outbox com falhas reais, num ambiente proprio e descartavel:
#   1. com o RabbitMQ parado, o servico aceita comandos e guarda o evento;
#   2. o evento sobrevive a kill -9 do servico;
#   3. quando o RabbitMQ volta, o evento chega a fila, sem perda nem duplicata;
#   4. a mensagem sobrevive ao reinicio do RabbitMQ.
# Uso: scripts/verificar_outbox.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export GEMINI_API_KEY= DEEPSEEK_API_KEY= # a prova nao gasta a cota do provedor, mesmo com .env preenchido
BUILD=--build; [ -n "${SEM_BUILD:-}" ] && BUILD=--no-build # SEM_BUILD=1: usa as imagens ja prontas
export COMPOSE_PROJECT_NAME=saudeconecta-outbox
dc() { docker compose "$@" 2>/dev/null; }
trap 'dc down -v >/dev/null' EXIT
falha() { echo "  FALHA $1"; dc logs agendamento --tail 15; exit 1; }
ok()    { echo "  ok    $1"; }

sql()        { dc exec -T db-agendamento psql -qtA -U "${AGENDAMENTO_DB_USER:-agendamento}" -d agendamento -c "$1"; }
pendentes()  { sql "SELECT count(*) FROM outbox_events WHERE status='PENDING'"; }
fila()       { dc exec -T -u rabbitmq rabbitmq rabbitmqctl -q list_queues name messages | awk '$1=="agendamento.projetor"{print $2}'; }
http()       { dc exec -T agendamento node -e "fetch('http://127.0.0.1:8002$2',{method:'$1',headers:{'content-type':'application/json','X-User-Role':'gestor'},body:$( [ -n "${3:-}" ] && echo "JSON.stringify($3)" || echo undefined )}).then(r=>console.log(r.status))"; }
espera()     { local t0; t0=$(date +%s%N); for _ in $(seq 150); do [ "$(eval "$1")" = "$2" ] && { echo $(( ($(date +%s%N) - t0) / 1000000 )); return 0; }; sleep 0.2; done; return 1; }

echo "0. Subindo Agendamento, PostgreSQL e RabbitMQ"
SUBIDA=$(docker compose up -d $BUILD --no-deps db-agendamento rabbitmq agendamento 2>&1) || falha "nao subiu: $(grep -iE 'error|unhealthy|failed' <<< "$SUBIDA" | tail -3)"
espera 'http GET /ready' 200 >/dev/null || falha "servico nao ficou pronto"
espera pendentes 0 >/dev/null || falha "outbox nao esvaziou"
sleep 2; antes=$(fila); ok "outbox vazio, $antes mensagens na fila"

echo "1. RabbitMQ parado"
dc stop rabbitmq
E="{profissionalId:'b1000000-0000-4000-8000-000000000001',ubsId:'a1000000-0000-4000-8000-000000000001',diaSemana:7,horaInicio:'08:00',horaFim:'09:00',duracaoSlotMin:30}"
[ "$(http POST /api/v1/escalas "$E")" = 201 ] && ok "comando aceito (201)" || falha "comando recusado sem broker"
[ "$(http GET /ready)" = 200 ] && ok "servico continua pronto" || falha "servico saiu do ar sem broker"
[ "$(pendentes)" = 1 ] && ok "1 evento pendente no outbox" || falha "pendentes: $(pendentes)"

echo "2. kill -9 no servico"
dc kill -s KILL agendamento
[ "$(pendentes)" = 1 ] && ok "evento continua no banco" || falha "evento perdido"
dc up -d agendamento
espera 'http GET /ready' 200 >/dev/null || falha "servico nao voltou"
sleep 8
[ "$(sql "SELECT attempts||' '||status FROM outbox_events WHERE status<>'PUBLISHED'")" = "0 PENDING" ] && ok "indisponibilidade nao gastou tentativas" || falha "tentativas gastas"

echo "3. RabbitMQ de volta"
dc start rabbitmq
ms=$(espera pendentes 0) && ok "publicado ${ms} ms apos o start (inclui o boot do broker)" || falha "evento nao publicado"
sleep 1; depois=$(fila)
[ "$depois" = $((antes + 1)) ] && ok "fila: $antes -> $depois (sem perda nem duplicata)" || falha "fila: $antes -> $depois"

echo "4. Reinicio do RabbitMQ"
dc restart rabbitmq
espera fila "$depois" >/dev/null && ok "$depois mensagens preservadas" || falha "mensagens perdidas: $(fila)"
echo; echo "Outbox OK"
