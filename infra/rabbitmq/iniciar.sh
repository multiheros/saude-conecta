#!/bin/sh
# Com definicoes carregadas no boot, o RabbitMQ nao cria o usuario padrao.
# Este script injeta no arquivo o usuario e a senha vindos do ambiente.
set -eu
: "${RABBITMQ_USER:?}" "${RABBITMQ_PASSWORD:?}"
case "$RABBITMQ_USER$RABBITMQ_PASSWORD" in
  *[!A-Za-z0-9._-]*) echo "RABBITMQ_USER/RABBITMQ_PASSWORD: use apenas letras, numeros, ponto, hifen e sublinhado" >&2; exit 1 ;;
esac
umask 077
rm -f /etc/rabbitmq/definitions.json
sed -e "s/__USUARIO__/$RABBITMQ_USER/g" -e "s/__SENHA__/$RABBITMQ_PASSWORD/g" \
  /etc/rabbitmq/definitions.modelo.json > /etc/rabbitmq/definitions.json
chown rabbitmq /etc/rabbitmq/definitions.json
exec docker-entrypoint.sh rabbitmq-server
