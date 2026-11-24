#!/bin/sh
# Gera, na primeira execucao, o par RSA que assina (Pacientes) e valida (gateway) os JWTs.
# A chave privada fica num volume montado so em Pacientes; nada e versionado.
set -eu
if [ ! -s /privada/jwt.pem ]; then
  umask 077
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /privada/jwt.pem.tmp 2>/dev/null
  chown 1000:1000 /privada/jwt.pem.tmp # usuario "node" das imagens
  mv /privada/jwt.pem.tmp /privada/jwt.pem
  echo "par de chaves gerado"
fi
openssl pkey -in /privada/jwt.pem -pubout -out /publica/jwt.pub.pem
chmod 444 /publica/jwt.pub.pem
