#!/usr/bin/env bash
# Deixa tudo pronto para subir sem internet: baixa as imagens de terceiros e constroi as do projeto.
# Repete sozinho se o Docker Hub falhar. Rode uma vez com internet, e de novo se o codigo mudar.
#   scripts/preparar.sh             depois:  docker compose up -d --no-build
set -uo pipefail
cd "$(dirname "$0")/.."
tentar() { # tentar <descricao> <comando...>
  local d=$1; shift
  for n in 1 2 3 4 5; do
    "$@" && { echo "  ok    $d"; return; }
    echo "  nova tentativa ($n) em 10 s: $d"; sleep 10
  done
  echo "  FALHA $d"; exit 1
}
echo "1. Imagens de terceiros"
for i in $(docker compose config --images | grep -v '^saudeconecta/' | sort -u); do
  docker image inspect "$i" >/dev/null 2>&1 && echo "  ok    $i (ja estava)" || tentar "$i" docker pull -q "$i"
done
echo "2. Imagens do projeto (a primeira vez baixa o modelo de embeddings, 350 MB)"
for s in $(docker compose config --format json | docker run --rm -i --network none node:22-alpine node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(Object.entries(JSON.parse(s).services).filter(([,v])=>v.build).map(([k])=>k).join(' ')))"); do
  tentar "$s" docker compose build -q "$s"
done
echo "3. Conferencia"
falta=0
for i in $(docker compose config --images | sort -u); do docker image inspect "$i" >/dev/null 2>&1 || { echo "  FALTA $i"; falta=1; }; done
[ $falta = 0 ] && echo "  ok    todas as imagens presentes. Suba com: docker compose up -d --no-build" || exit 1
