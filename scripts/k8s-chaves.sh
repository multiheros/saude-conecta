#!/usr/bin/env bash
# Cria no cluster o par de chaves do JWT, se ainda nao existir. Nada e gravado no repositorio.
set -euo pipefail
cd "$(dirname "$0")/.."
NS=saudeconecta
if kubectl -n $NS get secret jwt-privada >/dev/null 2>&1; then echo "chaves ja existem"; exit 0; fi
docker build -q -t saudeconecta/chaves:1.0 infra/chaves >/dev/null
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
docker run --rm saudeconecta/chaves:1.0 openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null > "$T/jwt.pem"
docker run --rm -i saudeconecta/chaves:1.0 openssl pkey -pubout < "$T/jwt.pem" > "$T/jwt.pub.pem"
kubectl -n $NS create secret generic jwt-privada --from-file="$T/jwt.pem"
kubectl -n $NS create configmap jwt-publica --from-file="$T/jwt.pub.pem"
