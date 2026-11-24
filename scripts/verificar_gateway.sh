#!/usr/bin/env bash
# Prova o gateway (Kong) e os BFFs na stack real, so com requisicoes que entram pela porta publicada:
#   1. JWT: sem token, expirado, adulterado, sem assinatura, de outra chave, de outro publico -> 401;
#   2. perfil por rota -> 403; dado de outro paciente -> 403; rotas internas nao existem por fora -> 404;
#   3. identidade forjada em cabecalho e descartada;
#   4. fluxo completo do paciente pelo BFF, com o mesmo X-Correlation-Id no log de todos os servicos;
#   5. painel do gestor: agregado, sem dado pessoal, e parcial quando um servico cai;
#   6. limite de 100 por minuto: a 101a da 429, token invalido tambem conta, e sem o Redis o gateway libera.
# Uso: scripts/verificar_gateway.sh      (~3 min; usa a porta 18080)
set -uo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=saudeconecta-gateway GATEWAY_PORTA=${GATEWAY_PORTA:-18080} LIMITE_POR_MINUTO=5000 CACHE_SEGUNDOS=0
G=http://127.0.0.1:$GATEWAY_PORTA
dc() { docker compose "$@" 2>/dev/null; }
trap 'dc down -v >/dev/null' EXIT
ok()    { echo "  ok    $1"; }
falha() { echo "  FALHA $1"; dc logs gateway bff-web bff-admin --tail 8 --no-log-prefix; exit 1; }
igual() { [ "$2" = "$3" ] && ok "$1" || falha "$1: esperado '$3', obtido '$2'"; }
espera()  { for _ in $(seq 120); do [ "$(eval "$1")" = "$2" ] && return; sleep 0.5; done; falha "$1: esperado $2, obtido $(eval "$1")"; }
cod()  { curl -s -m 20 -o /dev/null -w '%{http_code}' "$@"; }
# campo <expressao js sobre j>: le JSON da entrada
campo() { docker run --rm -i --network none node:22-alpine node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"; }
P1=c1000000-0000-4000-8000-000000000001; P2=c1000000-0000-4000-8000-000000000002; UBS=a1000000-0000-4000-8000-000000000001
login() { curl -s "$G/api/v1/auth/login" -H 'content-type: application/json' -d "{\"cpf\":\"$1\",\"senha\":\"${SEED_SENHA:-demo12345}\"}" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'; }
# token <opcoes js>: assina com a chave verdadeira, dentro de Pacientes (so para o teste)
token() { dc exec -T pacientes node -e "const jwt=require('jsonwebtoken'),fs=require('fs');const k=fs.readFileSync('/chaves/jwt.pem');console.log($1)"; }
OK="algorithm:'RS256',subject:'$P1',issuer:'saudeconecta-paciente',audience:'saudeconecta',expiresIn:600"

echo "0. Subindo a stack"
docker compose up -d --build gateway bff-web bff-admin agendamento pacientes triagem notificacoes rabbitmq db-agendamento-leitura cache-agendamento cache-gateway >/dev/null 2>&1 || falha "nao subiu"
espera "cod $G/health" 200; espera "login 10000000108 | cut -c1-3" eyJ
PAC=$(login 10000000108); GES=$(login 90000000175); AP="Authorization: Bearer $PAC"; AG="Authorization: Bearer $GES"
[ -n "$GES" ] || falha "login da gestora"
espera "cod -H '$AP' $G/web/v1/home" 200; espera "cod -H '$AP' '$G/api/v1/slots?ubsId=$UBS'" 200; espera "cod -H '$AG' $G/api/v1/triagens/saude-llm" 200; ok "login do paciente e da gestora pelo gateway"

echo "1. JWT"
igual "sem token" "$(cod $G/web/v1/home)" 401
igual "token valido assinado a mao (controle)" "$(cod -H "Authorization: Bearer $(token "jwt.sign({role:'paciente'},k,{$OK})")" $G/web/v1/home)" 200
igual "expirado" "$(cod -H "Authorization: Bearer $(token "jwt.sign({role:'paciente'},k,{${OK/600/-10}})")" $G/web/v1/home)" 401
igual "sem exp" "$(cod -H "Authorization: Bearer $(token "jwt.sign({role:'paciente'},k,{${OK%,expiresIn:600}})")" $G/web/v1/home)" 401
igual "outro publico (aud)" "$(cod -H "Authorization: Bearer $(token "jwt.sign({},k,{${OK/audience:\'saudeconecta\'/audience:\'outro\'}})")" $G/web/v1/home)" 401
igual "emissor desconhecido" "$(cod -H "Authorization: Bearer $(token "jwt.sign({},k,{${OK/saudeconecta-paciente/x}})")" $G/web/v1/home)" 401
igual "sub que nao e id" "$(cod -H "Authorization: Bearer $(token "jwt.sign({},k,{${OK/$P1/admin}})")" $G/web/v1/home)" 401
igual "outra chave" "$(cod -H "Authorization: Bearer $(token "jwt.sign({},require('crypto').generateKeyPairSync('rsa',{modulusLength:2048}).privateKey,{$OK})")" $G/web/v1/home)" 401
igual "alg none" "$(cod -H "Authorization: Bearer $(token "jwt.sign({},'',{${OK/RS256/none}})")" $G/web/v1/home)" 401
igual "HS256 com a chave publica" "$(cod -H "Authorization: Bearer $(token "((b)=>{const e=(x)=>Buffer.from(JSON.stringify(x)).toString('base64url');const c=e({alg:'HS256',typ:'JWT'})+'.'+e({sub:'$P1',iss:'saudeconecta-paciente',aud:'saudeconecta',exp:Math.floor(Date.now()/1000)+600});return c+'.'+require('crypto').createHmac('sha256',b).update(c).digest('base64url')})(require('crypto').createPublicKey(k).export({type:'spki',format:'pem'}))")" $G/web/v1/home)" 401
igual "perfil trocado sem refazer a assinatura" "$(cod -H "Authorization: Bearer $(cut -d. -f1 <<< "$PAC").$(cut -d. -f2 <<< "$GES").$(cut -d. -f3 <<< "$PAC")" "$G/admin/v1/unidades")" 401
igual "token na URL nao vale" "$(cod "$G/web/v1/home?jwt=$PAC")" 401
igual "erro no formato RFC 7807, com correlacao" "$(curl -si -H 'X-Correlation-Id: abc-1' $G/web/v1/home | tr -d '\r' | grep -ciE '^content-type: application/problem\+json|^x-correlation-id: abc-1|"correlationId":"abc-1"')" 3

echo "2. Perfil e rotas"
igual "paciente no painel" "$(cod -H "$AP" "$G/admin/v1/unidades")" 403
igual "gestora no app do paciente" "$(cod -H "$AG" $G/web/v1/home)" 403
igual "gestora no painel (controle)" "$(cod -H "$AG" "$G/admin/v1/unidades")" 200
for u in escalas relatorios/ocupacao pacientes pacientes/estatisticas notificacoes/alertas triagens/saude-llm; do igual "paciente em /$u" "$(cod -H "$AP" "$G/api/v1/$u")" 403; done
igual "gestora em /pacientes (controle)" "$(cod -H "$AG" "$G/api/v1/pacientes")" 200
igual "dados de outro paciente" "$(cod -H "$AP" "$G/api/v1/pacientes/$P2")" 403
igual "os proprios dados (controle)" "$(cod -H "$AP" "$G/api/v1/pacientes/$P1")" 200
igual "agendamentos de outro paciente" "$(cod -H "$AP" "$G/api/v1/agendamentos?pacienteId=$P2")" 403
for m in "POST triagens" "DELETE triagens" "POST notificacoes" "POST pacientes/$P1/validacao" "DELETE pacientes/$P1/validacao" "GET ../../metricas" "GET ../../ready"; do
  igual "interno: ${m/$P1/ID}" "$(cod --path-as-is -X ${m% *} -H "$AG" "$G/api/v1/${m#* }")" 404; done
igual "metricas e ready sem rota" "$(cod $G/metricas)$(cod $G/ready)" 404404
igual "administracao do Kong desligada" "$(dc exec -T bff-web node -e "const s=require('net').connect({host:'gateway',port:8001,timeout:2000});const f=(t)=>{console.log(t);process.exit()};s.on('connect',()=>f('aberta'));s.on('error',()=>f('fechada'));s.on('timeout',()=>f('fechada'))")" fechada

echo "3. Identidade forjada"
igual "sem token, com X-User-Role" "$(cod -H 'X-User-Role: servico' -H "X-User-Id: $P1" "$G/api/v1/pacientes/$P1")" 401
for h in "X-User-Role: servico" "X-User-Role: gestor" "x-user-role: gestor" "X_User_Role: gestor" "X-User-Id: $P2"; do igual "paciente com '${h/$P2/OUTRO}'" "$(cod -H "$AP" -H "$h" "$G/api/v1/pacientes/$P2")" 403; done
igual "rota publica com X-User-Role nao vira interna" "$(cod -X POST -H 'X-User-Role: servico' -H 'content-type: application/json' -d '{}' "$G/api/v1/pacientes")" 422

echo "4. Fluxo do paciente pelo BFF"
w() { curl -s -m 20 -X "$1" -H "$AP" -H 'content-type: application/json' ${3:+-d "$3"} ${4:+-H "$4"} "$G$2"; }
Q='{"sintomas":"dor de garganta ha dois dias"}'
S=$(w POST /web/v1/triagem "$Q" | campo "j.horarios[0].slotId"); [[ $S =~ ^[0-9a-f-]{36}$ ]] && ok "triagem recomenda horario real" || falha "triagem: $S"
CORR=demo-$(date +%s)
R=$(w POST /web/v1/agendamentos "{\"slotId\":\"$S\",\"sintomas\":\"dor de garganta ha dois dias\"}" "X-Correlation-Id: $CORR")
ID=$(campo "j.id" <<< "$R"); igual "pedido aceito" "$(campo "j.status" <<< "$R")" PENDENTE
espera "w GET /web/v1/agendamentos/$ID/andamento | campo \"j.estado+' '+j.passos.map((p)=>p.situacao).join()\"" "CONCLUIDA CONCLUIDO,CONCLUIDO,CONCLUIDO,CONCLUIDO"; ok "andamento da SAGA na linguagem da tela"
espera "w GET /web/v1/agendamentos/$ID | campo j.status" AGENDADO
igual "detalhe pronto para a tela" "$(w GET /web/v1/agendamentos/$ID | campo "!!(j.titulo&&j.quando&&j.onde&&j.profissional&&j.urgencia.texto&&j.orientacoes.length&&j._links.cancelar)")" true
for s in bff-web agendamento pacientes triagem notificacoes; do [ "$(dc logs $s --no-log-prefix | grep -c "$CORR")" -gt 0 ] && ok "correlacao no log de $s" || falha "correlacao ausente em $s"; done
L=$(w GET /web/v1/agendamentos/$ID | campo "j._links.confirmar.href"); igual "confirmar pelo link recebido" "$(w POST "$L" '{}' | campo j.status)" CONFIRMADO
igual "horario ja tomado: pedido falha e explica" "$(I=$(curl -s -X POST -H "Authorization: Bearer $(login "$(dc exec -T db-pacientes psql -qtA -U "${PACIENTES_DB_USER:-pacientes}" -d pacientes -c "SELECT cpf FROM pacientes WHERE id='$P2'")")" -H 'content-type: application/json' -d "{\"slotId\":\"$S\",\"sintomas\":\"tosse e coriza ha dois dias\"}" $G/web/v1/agendamentos | campo j.id); for _ in $(seq 40); do e=$(curl -s -H "$AG" "$G/api/v1/agendamentos/$I" | campo "j.status+' '+!!j.motivo"); [ "$e" = "CANCELADO true" ] && break; sleep 0.5; done; echo "$e")" "CANCELADO true"
L=$(w GET /web/v1/agendamentos/$ID | campo "j._links.cancelar.href"); igual "cancelar pelo link recebido" "$(w POST "$L" '{"motivo":"teste"}' | campo j.status)" CANCELADO

echo "5. Painel do gestor"
RES="$G/admin/v1/agendamentos/resumo?ubsId=$UBS&periodo=$(date +%Y-%m)"
igual "resumo agregado e completo" "$(curl -s -H "$AG" "$RES" | campo "j.ubs.nome+' '+(j.capacidade.slotsTotais>0)+' '+j.parcial")" "UBS Centro true false"
igual "sem dado pessoal" "$(curl -s -H "$AG" "$RES" | grep -ciE 'cpf|email|telefone|pacienteId|pacienteNome')" 0
dc stop notificacoes >/dev/null
igual "Notificacoes fora: resposta parcial, sem erro" "$(curl -s -H "$AG" "$RES" | campo "j.parcial+' '+j.alertas+' '+(j.capacidade.slotsTotais>0)")" "true null true"
dc stop triagem >/dev/null
igual "Triagem fora: 503 no formato padrao" "$(curl -s -X POST -H "$AP" -H 'content-type: application/json' -d "$Q" $G/web/v1/triagem | campo "j.status+' '+j.title")" "503 Servico indisponivel"
igual "e a home continua abrindo" "$(cod -H "$AP" $G/web/v1/home)" 200

echo "6. Limite de requisicoes"
LIMITE_POR_MINUTO=100 docker compose up -d --no-deps gateway >/dev/null 2>&1; espera "cod $G/nada" 404
virada() { while [ $((10#$(date +%S))) -gt 35 ]; do sleep 1; done; }
novo() { dc exec -T cache-gateway redis-cli flushall >/dev/null; virada; }
novo; n=0; for i in $(seq 100); do [ "$(cod -H "$AP" $G/web/v1/home)" = 200 ] && n=$((n+1)); done
igual "100 requisicoes passam" "$n" 100
igual "a 101a e recusada" "$(cod -H "$AP" $G/web/v1/home)" 429
igual "com Retry-After e RFC 7807" "$(curl -si -H "$AP" $G/web/v1/home | tr -d '\r' | grep -ciE '^retry-after: [0-9]|^content-type: application/problem\+json')" 2
igual "vale para o IP, nao para a rota nem para o token" "$(cod $G/api/v1/escalas) $(cod -H "$AG" $G/admin/v1/unidades)" "429 429"
novo; for i in $(seq 100); do cod -H 'Authorization: Bearer lixo' $G/web/v1/home >/dev/null; done
igual "token invalido tambem gasta a cota" "$(cod -H 'Authorization: Bearer lixo' $G/web/v1/home)" 429
dc stop cache-gateway >/dev/null
igual "sem o Redis o gateway libera, em menos de 1 s" "$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -H "$AP" $G/web/v1/home | awk '{print $1, ($2<1)}')" "200 1"
echo; echo "GATEWAY OK"
