# Apoio das cenas da demonstracao. Usa a stack ja no ar (docker compose up -d --no-build).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
G=${G:-http://localhost:${GATEWAY_PORTA:-8080}}
UBS=a1000000-0000-4000-8000-000000000001; P1=c1000000-0000-4000-8000-000000000001
n() { printf '\033[1m%s\033[0m\n' "$1"; }                       # titulo
passo() { printf '\n\033[36m» %s\033[0m\n' "$1"; }              # o que vai acontecer
certo() { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
erro()  { printf '\033[31m  ✕ %s\033[0m\n' "$1"; exit 1; }
igual() { [ "$2" = "$3" ] && certo "$1: $2" || erro "$1: esperado '$3', obtido '$2'"; }
pausa() { [ -n "${DIRETO:-}" ] || read -rp $'\n  [Enter para continuar] ' _; } # DIRETO=1 roda sem parar
dc()  { docker compose "$@" 2>/dev/null; }
espera() { for _ in $(seq 160); do [ "$(eval "$1" 2>/dev/null)" = "$2" ] && return; sleep 0.25; done; erro "$1: esperado $2, obtido $(eval "$1")"; }
login() { curl -s "$G/api/v1/auth/login" -H 'content-type: application/json' -d "{\"cpf\":\"$1\",\"senha\":\"${SEED_SENHA:-demo12345}\"}" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p'; }
PAC=$(login 10000000108); GES=$(login 90000000175)
[ -n "$PAC" ] && [ -n "$GES" ] || erro "a stack nao responde em $G"
pac() { curl -s -m 25 -X "$1" -H "Authorization: Bearer $PAC" -H 'content-type: application/json' ${3:+-d "$3"} ${4:+-H "$4"} "$G$2"; }
ges() { curl -s -m 25 -X "$1" -H "Authorization: Bearer $GES" -H 'content-type: application/json' ${3:+-d "$3"} "$G$2"; }
campo() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
bonito() { dc exec -T agendamento node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($1)})"; }
sql()   { dc exec -T db-agendamento psql -U "${AGENDAMENTO_DB_USER:-agendamento}" -d agendamento "${@:2}" -c "$1"; }
mongo() { dc exec -T db-agendamento-leitura sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin agendamento_leitura --eval "$0"' "$1"; }
mongot() { dc exec -T db-triagem sh -c 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin triagem --eval "$0"' "$1"; }
livre() { pac GET "/web/v1/horarios?especialidade=Cl%C3%ADnica%20Geral" | grep -o '"slotId":"[^"]*' | sed -n "${1:-12}p" | cut -d'"' -f4; }
pedir() { pac POST /web/v1/agendamentos "{\"slotId\":\"$1\",\"sintomas\":\"${2:-dor de garganta ha dois dias}\"}" "X-Correlation-Id: ${3:-demo-$RANDOM}" | campo id; }
estado() { pac GET "/web/v1/agendamentos/$1/andamento" | campo estado; }
passos() { pac GET "/web/v1/agendamentos/$1/andamento" | bonito "j.passos.map((p)=>'     '+p.situacao.padEnd(14)+p.nome).join('\n')"; }
