#!/usr/bin/env bash
# Prova o LLM como dependencia falivel, na stack real, com um servidor que fala a API do Gemini no lugar do
# provedor (nao precisa de chave; nao mede a qualidade do modelo):
#   1. SAGA com o LLM: classificacao com fontes; repetir a queixa vem do cache;
#   2. nada que identifique o paciente sai para o provedor;
#   3. a tool le a agenda real: reservado o horario, a recomendacao muda;
#   4. a regra de seguranca vence o modelo: VERMELHO nao agenda;
#   5. provedor travado: SAGA conclui por regras em ate 8 s; circuito aberto responde em menos de 1 s;
#   6. depois de 30 s o circuito testa e fecha; provedor desligado e modelo sem chave tambem nao param a SAGA.
# Uso: scripts/verificar_llm.sh      (~3 min)
set -uo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=saudeconecta-llm COMPOSE_FILE=docker-compose.yml:scripts/llm-falso.compose.yml
dc() { docker compose "$@" 2>/dev/null; }
trap 'dc down -v >/dev/null' EXIT
ok()    { echo "  ok    $1"; }
falha() { echo "  FALHA $1"; dc logs triagem --tail 12 --no-log-prefix; exit 1; }
igual() { [ "$2" = "$3" ] && ok "$1" || falha "$1: esperado '$3', obtido '$2'"; }
espera()  { for _ in $(seq 160); do [ "$(eval "$1")" = "$2" ] && return; sleep 0.5; done; falha "$1: esperado $2, obtido $(eval "$1")"; }

UBS=a1000000-0000-4000-8000-000000000001
P() { printf 'c1000000-0000-4000-8000-%012d' "$1"; }
sql()  { dc exec -T db-agendamento psql -qtA -U "${AGENDAMENTO_DB_USER:-agendamento}" -d agendamento -c "$1"; }
js()   { dc exec -T agendamento node -e "(async()=>{const J={'content-type':'application/json'};const pede=async(m,u,h,b)=>{const t=Date.now();const r=await fetch(u,{method:m,headers:{...J,...h},body:b&&JSON.stringify(b)});const c=await r.json().catch(()=>null);return{status:r.status,c,ms:Date.now()-t}};const T='http://triagem:8003/api/v1/triagens',S={'X-User-Role':'servico'};$1})()"; }
modo() { js "await pede('POST','http://gemini-falso:9000/_modo',{},$1)"; }
pedidos() { js "console.log((await pede('GET','http://gemini-falso:9000/_pedidos',{})).c.length)"; }
pronto()  { espera "js \"try{console.log((await fetch('http://$1/ready')).status)}catch{}\"" 200; }
base()    { js "console.log((await pede('GET','http://triagem:8003/ready',{})).c.base)"; }
agendar() { js "const r=await pede('POST','http://127.0.0.1:8002/api/v1/agendamentos',{'X-User-Role':'gestor'},{pacienteId:'$1',slotId:'$2',sintomas:'$3',idade:40});console.log(r.c.id)"; }
livre()   { sql "SELECT id FROM slots WHERE ubs_id='$UBS' AND status='LIVRE' AND especialidade='Clínica Geral' AND inicio > now()+interval '3 days' ORDER BY inicio, id LIMIT 1"; }
saga()    { sql "SELECT estado FROM saga_instances WHERE agendamento_id='$1'"; }
# triagem <campo>: classifica direto na Triagem e imprime campo e se demorou menos que o limite
triar()   { js "const r=await pede('POST',T,{...S,'X-Saga-Id':crypto.randomUUID()},{pacienteId:'$(P 9)',sintomas:'$1',idade:40});console.log(r.status,r.c.classificacao,r.c.origem,r.c.fontes.length>0,r.ms<$2)"; }
saude()   { js "console.log((await pede('GET',T+'/saude-llm',S)).c.$1)"; }
guardada() { dc exec -T triagem python -c "
from app.repositorio import Repositorio
t=Repositorio().db.triagens.find_one({'agendamentoId':'$1'}) or {}
print(t.get('origem'), len(t.get('fontes',[]))>0)"; }
recomendar() { js "const r=await pede('POST',T+'/recomendacoes',{'X-User-Role':'paciente'},{sintomas:'$1',idade:40,ubsId:'$UBS'});console.log($2)"; }

echo "0. Subindo a stack (com a base do RAG)"
docker compose up -d --build agendamento pacientes triagem notificacoes rabbitmq db-agendamento-leitura cache-agendamento db-triagem-vetores triagem-ingestao gemini-falso >/dev/null 2>&1 || falha "nao subiu"
for s in 127.0.0.1:8002 pacientes:8001 triagem:8003 notificacoes:8004; do pronto $s; done
for _ in $(seq 300); do [ "$(docker inspect -f '{{.State.Status}}' "$(dc ps -aq triagem-ingestao)")" = exited ] && break; sleep 1; done
espera "triar 'aquecimento da base de conhecimento' 9000 >/dev/null; base" up; ok "pronta"

echo "1. SAGA com o LLM e cache"
Q='dor de cabeca leve desde ontem'
AG=$(agendar "$(P 1)" "$(livre)" "$Q"); espera "saga $AG" CONCLUIDA; espera "guardada $AG" "LLM True"; ok "triagem pelo LLM, com fontes"
n=$(pedidos); igual "mesma queixa vem do cache, em menos de 100 ms" "$(triar "$Q" 100)" "201 VERDE CACHE true true"
igual "sem nova chamada ao provedor" "$(pedidos)" "$n"

echo "2. Privacidade"
NOME=$(dc exec -T db-pacientes psql -qtA -U "${PACIENTES_DB_USER:-pacientes}" -d pacientes -c "SELECT nome FROM pacientes WHERE id='$(P 1)'")
[ -n "$NOME" ] || falha "nome do paciente nao lido"
igual "provedor nao recebe nome, id nem CPF" "$(js "const t=JSON.stringify((await pede('GET','http://gemini-falso:9000/_pedidos',{})).c);console.log(['$NOME','$(P 1)','10000000108'].some((x)=>t.includes(x)),t.includes('$Q'))")" "false true"

echo "3. Tool com a agenda real"
A=$(recomendar "$Q" "r.c.horarios[0].slotId"); igual "recomenda horario que existe e esta livre" "$(sql "SELECT status FROM slots WHERE id='$A'")" LIVRE
igual "pelo modelo, dentro do formato" "$(recomendar "$Q" "r.status,r.c.origemHorarios,r.c.prazoMaximoHoras")" "200 LLM 72"
AG=$(agendar "$(P 2)" "$A" "$Q"); espera "saga $AG" CONCLUIDA
espera "recomendar '$Q' \"r.c.horarios.some((h)=>h.slotId==='$A')\"" false; ok "reservado, o horario sai da recomendacao"

echo "4. Regra de seguranca vence o modelo"
modo "{resposta:{classificacao:'AZUL'}}"
igual "modelo diz AZUL, a regra eleva" "$(triar 'nao consigo respirar direito' 8000 | cut -d' ' -f2)" VERMELHO
AG=$(agendar "$(P 3)" "$(livre)" 'nao consigo respirar direito'); espera "saga $AG" FALHOU; ok "VERMELHO nao agenda"

echo "5. Provedor travado"
modo "{modo:'mudo'}"
igual "responde por regras, com fontes, em ate 8 s" "$(triar 'dor de garganta ha dois dias' 8000)" "201 VERDE REGRAS true true"
AG=$(agendar "$(P 4)" "$(livre)" 'tosse e coriza ha dois dias'); espera "saga $AG" CONCLUIDA; espera "guardada $AG" "REGRAS True"; ok "a SAGA conclui por regras"
espera "saude circuito" ABERTO
igual "circuito aberto: menos de 1 s" "$(triar 'dor de ouvido leve desde ontem' 1000)" "201 VERDE REGRAS true true"
igual "cache continua valendo" "$(triar "$Q" 1000 | cut -d' ' -f3)" CACHE
igual "recomendacao sem o modelo ainda traz horarios reais" "$(recomendar 'dor de ouvido leve desde ontem' "r.c.origem,r.c.origemHorarios,r.c.horarios.length>0")" "REGRAS REGRAS true"

echo "6. Recuperacao"
modo "{}"; espera "saude circuito" MEIO_ABERTO
igual "a chamada de teste passa" "$(triar 'azia depois do almoco ha dois dias' 8000 | cut -d' ' -f3)" LLM
igual "circuito fechado" "$(saude circuito)" FECHADO
dc stop gemini-falso
AG=$(agendar "$(P 5)" "$(livre)" 'coceira no braco ha dois dias'); espera "saga $AG" CONCLUIDA; ok "provedor desligado: a SAGA conclui"
echo "        $(js "const s=(await pede('GET',T+'/saude-llm',S)).c;console.log(JSON.stringify({chamadas:s.chamadas,repeticoes:s.repeticoes,fallbacks:s.fallbacks,acertosCache:s.acertosCache,recusadasPeloCircuito:s.recusadasPeloCircuito,falhas:s.falhasPorMotivo}))")"
COMPOSE_FILE=docker-compose.yml docker compose up -d --no-deps triagem >/dev/null 2>&1; pronto triagem:8003
igual "sem chave: por regras, com fontes" "$(triar 'dor de garganta ha tres dias' 2000)" "201 VERDE REGRAS true true"
igual "e o painel informa" "$(saude habilitado)" false
echo; echo "LLM OK"
