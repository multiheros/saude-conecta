#!/usr/bin/env bash
# Verifica, com a stack do Compose no ar, que:
#   1. cada servico alcanca o PROPRIO banco (controle positivo);
#   2. nenhum servico, BFF ou gateway alcanca o banco de outro, nem por nome nem por IP;
#   3. nenhum banco aceita acesso sem senha.
# Uso: scripts/verificar_isolamento.sh     (sai com 1 se algo falhar)
set -uo pipefail
cd "$(dirname "$0")/.."

falhas=0
ok()   { echo "  ok    $1"; }
erro() { echo "  FALHA $1"; falhas=$((falhas + 1)); }

# servidor:porta:dono
BANCOS="db-pacientes:5432:pacientes db-agendamento:5432:agendamento db-agendamento-leitura:27017:agendamento cache-agendamento:6379:agendamento db-triagem:27017:triagem db-triagem-vetores:8000:triagem db-notificacoes:6379:notificacoes cache-gateway:6379:gateway"
ORIGENS="pacientes agendamento triagem notificacoes bff-web bff-admin gateway"

ip_de() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \
    "$(docker compose ps -q "$1")" | awk '{print $1}'
}

# Sai com 0 se a origem abre conexao TCP com host:porta; 1 se nao abre.
# A sonda imprime ABERTA/FECHADA; qualquer outra saida e erro da propria sonda.
conecta() {
  local origem=$1 host=$2 porta=$3 saida
  case $origem in
    triagem)
      saida=$(docker compose exec -T "$origem" python -c "
import socket
try:
    socket.create_connection(('$host', $porta), 2).close(); print('ABERTA')
except OSError:
    print('FECHADA')" 2>&1) ;;
    gateway)
      saida=$(docker compose exec -T "$origem" bash -c "timeout 2 bash -c 'exec 3<>/dev/tcp/$host/$porta' 2>/dev/null && echo ABERTA || echo FECHADA" 2>&1) ;;
    *)
      saida=$(docker compose exec -T "$origem" node -e "
const s = require('net').connect({ host: '$host', port: $porta, timeout: 2000 });
const fim = (t) => { console.log(t); process.exit(0); };
s.on('connect', () => fim('ABERTA')); s.on('error', () => fim('FECHADA')); s.on('timeout', () => fim('FECHADA'));" 2>&1) ;;
  esac
  case $saida in
    *ABERTA*)  return 0 ;;
    *FECHADA*) return 1 ;;
    *) echo "  sonda de $origem nao executou: $saida" >&2; exit 2 ;;
  esac
}

echo "1. Cada servico alcanca o proprio banco"
for b in $BANCOS; do
  IFS=: read -r host porta dono <<< "$b"
  conecta "$dono" "$host" "$porta" && ok "$dono -> $host" || erro "$dono nao alcanca $host"
done

echo "2. Ninguem alcanca o banco alheio"
for o in $ORIGENS; do
  for b in $BANCOS; do
    IFS=: read -r host porta dono <<< "$b"
    [ "$dono" = "$o" ] && continue
    ip=$(ip_de "$host")
    [ -n "$ip" ] || { echo "  $host nao esta no ar" >&2; exit 2; }
    if conecta "$o" "$host" "$porta" || conecta "$o" "$ip" "$porta"; then
      erro "$o alcanca $host"
    else
      ok "$o bloqueado em $host"
    fi
  done
done

echo "3. Bancos exigem senha"
for pg in pacientes agendamento; do
  # Pelo IP de rede: em 127.0.0.1 a imagem oficial confia sem senha.
  saida=$(docker compose exec -T -e PGPASSWORD=senha-errada "db-$pg" \
    psql -h "$(ip_de "db-$pg")" -U "$pg" -d "$pg" -w -c 'select 1' 2>&1)
  [[ $saida == *"password authentication failed"* ]] && ok "db-$pg recusa senha errada" || erro "db-$pg: $saida"
done
for r in db-notificacoes cache-agendamento cache-gateway; do
  saida=$(docker compose exec -T $r sh -c 'unset REDISCLI_AUTH; redis-cli ping' 2>&1)
  [[ $saida == *NOAUTH* ]] && ok "$r recusa sem senha" || erro "$r respondeu: $saida"
done
for m in db-triagem db-agendamento-leitura; do
  saida=$(docker compose exec -T $m mongosh --quiet --eval 'db.adminCommand({listDatabases:1})' 2>&1)
  [[ $saida == *"requires authentication"* ]] && ok "$m recusa sem senha" || erro "$m aceitou acesso sem senha"
done

echo
[ "$falhas" -eq 0 ] && echo "Isolamento OK" || { echo "$falhas falha(s)"; exit 1; }
