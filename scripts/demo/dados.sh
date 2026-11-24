#!/usr/bin/env bash
# Enche a agenda com dados ficticios para a demonstracao, pela API real (cada agendamento passa pela SAGA).
# Uso, com a stack no ar:  scripts/demo/dados.sh [quantidade]      (padrao 40; G=http://host:porta muda o destino)
set -euo pipefail
G=${G:-http://localhost:${GATEWAY_PORTA:-8080}}; N=${1:-40}
UBS=a1000000-0000-4000-8000-000000000001
QUEIXAS=("dor de garganta ha dois dias" "tosse e coriza desde ontem" "febre alta e dor no corpo" "preciso renovar minha receita" "dor lombar ao levantar peso"
  "dor muito forte na barriga" "coceira no braco ha tres dias" "dor no peito ao subir escada" "dor de ouvido desde ontem" "exame de rotina e check-up")
T=$(curl -sf "$G/api/v1/auth/login" -H 'content-type: application/json' -d "{\"cpf\":\"90000000175\",\"senha\":\"${SEED_SENHA:-demo12345}\"}" | sed 's/.*"accessToken":"\([^"]*\).*/\1/')
# O limite do gateway e 100 por minuto: diante de um 429, espera e repete.
api() { local r; while :; do r=$(curl -s -w '\n%{http_code}' -X "$1" -H "Authorization: Bearer $T" -H 'content-type: application/json' ${3:+-d "$3"} "$G$2"); [ "${r##*$'\n'}" = 429 ] || break; sleep 5; done; echo "${r%$'\n'*}"; }
mapfile -t SLOTS < <(api GET "/api/v1/slots?ubsId=$UBS" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
[ "${#SLOTS[@]}" -ge "$N" ] || { echo "so ha ${#SLOTS[@]} horarios livres"; exit 1; }
ids=()
for ((i = 0; i < N; i++)); do
  # O dia mais proximo fica cheio, para aparecer o alerta de lotacao; o resto se espalha pelos seguintes.
  s=$(( i < 21 ? i : (21 + (i - 21) * 7) % ${#SLOTS[@]} ))
  r=$(api POST /api/v1/agendamentos "{\"pacienteId\":\"c1000000-0000-4000-8000-$(printf %012d $((i % 10 + 1)))\",\"slotId\":\"${SLOTS[$s]}\",\"sintomas\":\"${QUEIXAS[$((i % 10))]}\",\"idade\":40}")
  id=$(grep -o '"id":"[^"]*"' <<< "$r" | head -1 | cut -d'"' -f4); [ -n "$id" ] && ids+=("$id")
  (( i % 10 == 9 )) && sleep 4 # cada paciente so agenda de novo quando a SAGA anterior termina
done
sleep 5
for ((i = 0; i < ${#ids[@]}; i++)); do
  case $((i % 6)) in
    0|1) api POST "/api/v1/agendamentos/${ids[$i]}/confirmacao" '{}' ;;
    2|4) api POST "/api/v1/agendamentos/${ids[$i]}/comparecimento" '{"compareceu":true}' ;;
    3) (( i % 12 == 3 )) && api POST "/api/v1/agendamentos/${ids[$i]}/comparecimento" '{"compareceu":false}' ;;
  esac > /dev/null || true
done
echo "${#ids[@]} pedidos enviados. Painel: $G/painel (CPF 90000000175). App: $G (CPF 10000000108)."
