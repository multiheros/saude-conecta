#!/usr/bin/env bash
# Prova o CQRS na stack real (PostgreSQL -> Outbox -> RabbitMQ -> projetor -> MongoDB + Redis), num
# ambiente proprio e descartavel:
#   1. uma escrita aparece na leitura, e o paciente ve a propria escrita na hora (read-your-writes);
#   2. defasagem medida em 30 comandos;
#   3. Read Model fora: comandos continuam, consultas dao 503, e ao voltar tudo e projetado;
#   4. Redis fora: consultas seguem pelo MongoDB;
#   5. RabbitMQ fora: a leitura fica atrasada, mas alcanca a escrita depois;
#   6. MongoDB perdido (banco apagado): o servico reconstroi sozinho a partir do PostgreSQL.
# Uso: scripts/verificar_cqrs.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export GEMINI_API_KEY= DEEPSEEK_API_KEY= # a prova nao gasta a cota do provedor, mesmo com .env preenchido
BUILD=--build; [ -n "${SEM_BUILD:-}" ] && BUILD=--no-build # SEM_BUILD=1: usa as imagens ja prontas
export COMPOSE_PROJECT_NAME=saudeconecta-cqrs
dc() { docker compose "$@" 2>/dev/null; }
trap 'dc down -v >/dev/null' EXIT
ok()    { echo "  ok    $1"; }
falha() { echo "  FALHA $1"; dc logs agendamento --tail 12 --no-log-prefix; exit 1; }
igual() { [ "$2" = "$3" ] && ok "$1" || falha "$1: esperado '$3', obtido '$2'"; }

UBS=a1000000-0000-4000-8000-000000000001
P() { printf 'c1000000-0000-4000-8000-%012d' "$1"; }
sql()   { dc exec -T db-agendamento psql -qtA -U "${AGENDAMENTO_DB_USER:-agendamento}" -d agendamento -c "$1"; }
mongo() { dc exec -T db-agendamento-leitura mongosh --quiet -u "${AGENDAMENTO_LEITURA_USER:-leitura}" -p "${AGENDAMENTO_LEITURA_PASSWORD:-troque-me-leitura}" agendamento_leitura --authenticationDatabase admin --eval "$1"; }
# js <codigo>: roda no container do Agendamento, dentro da rede interna
js() { dc exec -T agendamento node -e "(async()=>{const u='http://127.0.0.1:8002/api/v1',h={'content-type':'application/json','X-User-Role':'gestor'};const get=async(c)=>{const r=await fetch(u+c,{headers:h});return{status:r.status,corpo:await r.json()}};const post=async(c,b={})=>{const r=await fetch(u+c,{method:'POST',headers:h,body:JSON.stringify(b)});return{status:r.status,loc:r.headers.get('location'),corpo:await r.json()}};$1})()"; }
agendar() { js "const r=await post('/agendamentos',{pacienteId:'$1',slotId:'$2',sintomas:'tosse e coriza ha dois dias',idade:40});console.log(r.corpo.id)"; }
livre()   { sql "SELECT id FROM slots WHERE ubs_id='$UBS' AND status='LIVRE' AND inicio > now()+interval '3 days' ORDER BY inicio, id OFFSET $1 LIMIT 1"; }
saga()    { sql "SELECT estado FROM saga_instances WHERE agendamento_id='$1'"; }
status()  { js "const r=await get('/agendamentos/$1');console.log(r.status===200?r.corpo.status:r.status)"; }
oferece() { js "const r=await get('/slots?ubsId=$UBS');console.log(r.status===200?r.corpo.some((s)=>s.id==='$1'):r.status)"; }
espera()  { for _ in $(seq 120); do [ "$(eval "$1")" = "$2" ] && return; sleep 0.25; done; falha "$1: esperado $2, obtido $(eval "$1")"; }
pronto()  { espera "js \"try{console.log((await fetch('http://$1/ready')).status)}catch{}\"" 200; }
saude()   { js "console.log((await (await fetch('http://127.0.0.1:8002/ready')).json()).$1)"; }
consumindo() { js "console.log((await (await fetch('http://127.0.0.1:8002/metricas')).json()).projetor.fila!==null)"; }
# Compara os dois lados: agendamentos por status e vagas por situacao.
escrita() { sql "SELECT (SELECT string_agg(status||'='||n, ' ' ORDER BY status) FROM (SELECT status, count(*) n FROM agendamentos GROUP BY 1) x) || ' | ' || (SELECT count(*)||' '||count(*) FILTER (WHERE status='RESERVADO') FROM slots)"; }
leitura() { mongo "const a=db.agendamentos_view.aggregate([{\$group:{_id:'\$status',n:{\$sum:1}}},{\$sort:{_id:1}}]).toArray().map((x)=>x._id+'='+x.n).join(' ');const o=db.ocupacao_ubs.aggregate([{\$group:{_id:null,t:{\$sum:'\$total'},r:{\$sum:'\$reservados'}}}]).toArray()[0];print(a+' | '+o.t+' '+o.r)"; }

echo "0. Subindo a stack"
SUBIDA=$(docker compose up -d $BUILD agendamento pacientes triagem notificacoes rabbitmq db-agendamento-leitura cache-agendamento 2>&1) || falha "nao subiu: $(grep -iE 'error|unhealthy|failed' <<< "$SUBIDA" | tail -3)"
for s in 127.0.0.1:8002 pacientes:8001 triagem:8003 notificacoes:8004; do pronto $s; done
espera "saude rabbitmq" up; espera consumindo true; espera "saude leitura" up; espera "saude cache" up; espera "oferece $(livre 0)" true; ok "pronta, vagas do seed projetadas"

echo "1. Escrita -> leitura"
S=$(livre 0)
igual "GET em Location logo apos o 202" "$(js "const r=await post('/agendamentos',{pacienteId:'$(P 1)',slotId:'$S',sintomas:'tosse e coriza ha dois dias'});const g=await get(r.loc.replace('/api/v1',''));console.log(r.status,g.status)")" "202 200"
AG=$(sql "SELECT agendamento_id FROM saga_instances"); espera "saga $AG" CONCLUIDA; espera "status $AG" AGENDADO
igual "PostgreSQL" "$(sql "SELECT status||' v'||version FROM agendamentos WHERE id='$AG'")" "AGENDADO v2"
igual "MongoDB" "$(mongo "const a=db.agendamentos_view.findOne({_id:'$AG'});print(a.status+' v'+a.versao)")" "AGENDADO v2"
igual "documento pronto para a tela" "$(js "const a=(await get('/agendamentos/$AG')).corpo;console.log([a.ubs.nome,!!a.profissional.nome,!!a.pacienteNome].join(' '))")" "UBS Centro true true"
igual "vaga fora da lista (Redis)" "$(oferece "$S")" false
igual "leitura e escrita batem" "$(leitura)" "$(escrita)"

echo "2. Defasagem em 30 comandos"
ESP=$(sql "SELECT especialidade FROM slots WHERE id='$S'")
M=$(js "const s=(await get('/slots?ubsId=$UBS&especialidade='+encodeURIComponent('$ESP'))).corpo,d=[];for(let i=0;i<30;i++){const r=await post('/agendamentos/$AG/reagendamento',{novoSlotId:s[20+i].id});const a=(await get('/agendamentos/$AG?versaoMinima='+r.corpo.versao)).corpo;if(r.status!==200||a.versao!==r.corpo.versao)throw new Error(r.status+' '+a.versao);d.push(Date.parse(a.projetadoEm)-Date.parse(a.atualizadoEm));await new Promise(o=>setTimeout(o,Math.random()*500));}d.sort((a,b)=>a-b);console.log('p50 '+d[15]+' ms, p95 '+d[28]+' ms, maximo '+d[29]+' ms',d[28]<5000)")
[[ $M == *true ]] && ok "dentro do SLA de 5 s: ${M% true}" || falha "fora do SLA: $M"
espera leitura "$(escrita)"

echo "3. MongoDB de leitura fora"
dc stop db-agendamento-leitura
S3=$(livre 0); AG3=$(agendar "$(P 3)" "$S3"); espera "saga $AG3" CONCLUIDA; ok "a SAGA conclui sem o Read Model"
igual "consulta responde 503" "$(status "$AG3")" 503
igual "servico continua pronto" "$(js "console.log((await fetch('http://127.0.0.1:8002/ready')).status)")" 200
dc start db-agendamento-leitura; espera "status $AG3" AGENDADO; espera leitura "$(escrita)"; ok "ao voltar, tudo foi projetado"
dc pause db-agendamento-leitura
igual "MongoDB travado: 503 em menos de 6 s, sem pendurar" "$(js "const t=Date.now(),r=await get('/agendamentos/$AG3');console.log(r.status,Date.now()-t<6000)")" "503 true"
igual "servico continua pronto" "$(js "console.log((await fetch('http://127.0.0.1:8002/ready')).status)")" 200
dc unpause db-agendamento-leitura; espera "status $AG3" AGENDADO
dc stop db-agendamento-leitura agendamento; dc up -d --no-deps agendamento; pronto 127.0.0.1:8002
igual "servico parte sem o MongoDB" "$(status "$AG3") $(saude leitura)" "503 down"
sleep 4; dc start db-agendamento-leitura; espera "status $AG3" AGENDADO; espera consumindo true; ok "e se conecta quando ele chega"
igual "nada na DLQ" "$(js "console.log((await (await fetch('http://127.0.0.1:8002/metricas')).json()).projetor.fila?.naDlq)")" 0

echo "4. Redis fora"
dc stop cache-agendamento
S4=$(livre 0); igual "vagas pelo MongoDB" "$(oferece "$S4")" true
AG4=$(agendar "$(P 4)" "$S4"); espera "saga $AG4" CONCLUIDA; espera "oferece $S4" false; ok "vaga sai da lista mesmo sem cache"
dc start cache-agendamento; espera "saude cache" up
igual "cache de volta, sem ressuscitar a vaga" "$(oferece "$S4")" false

echo "5. RabbitMQ fora"
dc stop rabbitmq
S5=$(livre 0); AG5=$(agendar "$(P 5)" "$S5"); espera "saga $AG5" CONCLUIDA
igual "leitura atrasada: ainda oferece a vaga" "$(oferece "$S5")" true
igual "a escrita decide: segunda reserva da vaga e recusada" "$(AG6=$(agendar "$(P 6)" "$S5"); espera "saga $AG6" FALHOU; saga "$AG6")" FALHOU
dc start rabbitmq; espera "status $AG5" AGENDADO; espera "oferece $S5" false; ok "leitura alcancou a escrita"

echo "6. Read Model perdido"
antes=$(escrita)
mongo "db.dropDatabase()" >/dev/null
espera "mongo \"print(db.controle.countDocuments({_id:'reconstrucao'}))\"" 1
# agendamentos_view tambem tem os pedidos que falharam antes da reserva (sem linha em agendamentos)
igual "vagas e reservas reconstruidas" "$(leitura | sed 's/.*| //')" "$(sed 's/.*| //' <<< "$antes")"
igual "agendamento reconstruido, com o nome vindo de Pacientes" "$(js "const a=(await get('/agendamentos/$AG5')).corpo;console.log(a.status,!!a.pacienteNome)")" "AGENDADO true"
igual "reprojecao manual" "$(dc exec -T agendamento node reprojetar.js | grep -c 'read model reconstruido')" 1
igual "leitura identica apos reprojetar" "$(leitura | sed 's/.*| //')" "$(sed 's/.*| //' <<< "$antes")"
echo; echo "CQRS OK"
