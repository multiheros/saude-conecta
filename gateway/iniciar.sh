#!/usr/bin/env bash
# Poe a chave publica do JWT (gerada na instalacao, nunca versionada) na configuracao e inicia o Kong.
set -euo pipefail
CHAVE=${JWT_CHAVE_PUBLICA:-/chaves/jwt.pub.pem}
for _ in $(seq 60); do [ -s "$CHAVE" ] && break; echo "esperando $CHAVE"; sleep 1; done
awk -v limite="${LIMITE_POR_MINUTO:-100}" -v redis="${LIMITE_REDIS_HOST:-cache-gateway}" -v chave="$CHAVE" '
  /@@CHAVE_PUBLICA@@/ { match($0, /^ */); recuo = substr($0, 1, RLENGTH); while ((getline linha < chave) > 0) print recuo linha; close(chave); next }
  { gsub(/@@LIMITE@@/, limite); gsub(/@@REDIS@@/, redis); print }' /etc/kong/kong.modelo.yml > /tmp/kong.yml
exec /docker-entrypoint.sh kong docker-start
