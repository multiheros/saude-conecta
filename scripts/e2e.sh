#!/usr/bin/env bash
# Roda todas as provas, uma por vez, e mostra um resumo. Cada uma sobe e apaga o proprio ambiente.
#   scripts/e2e.sh                  tudo (~25 min)
#   scripts/e2e.sh saga telas       so as informadas
#   SEM_BUILD=1 scripts/e2e.sh      usa as imagens ja prontas (scripts/preparar.sh)
# Os registros ficam em ${REGISTROS:-/tmp/saudeconecta-e2e}. Nao precisa de chave do LLM.
set -uo pipefail
cd "$(dirname "$0")/.."
export GEMINI_API_KEY= # as provas nao gastam cota, mesmo com .env preenchido
R=${REGISTROS:-/tmp/saudeconecta-e2e}; mkdir -p "$R"
PROVAS=("$@"); [ $# -gt 0 ] || PROVAS=(testes isolamento outbox saga cqrs rag llm gateway telas offline)

isolamento() { # precisa da stack inteira no ar
  export COMPOSE_PROJECT_NAME=saudeconecta-iso GATEWAY_PORTA=18086
  docker compose up -d $([ -n "${SEM_BUILD:-}" ] && echo --no-build || echo --build) 2>&1 | tail -3 && scripts/verificar_isolamento.sh
  local r=$?; docker compose down -v >/dev/null 2>&1; return $r
}
total=0; falhas=0; resumo=()
for p in "${PROVAS[@]}"; do
  t0=$SECONDS
  case $p in
    testes)     scripts/testar.sh ;;
    isolamento) (isolamento) ;;
    *)          scripts/verificar_"$p".sh ;;
  esac > "$R/$p.txt" 2>&1 && r=ok || r=FALHA
  total=$((total + 1)); [ $r = ok ] || falhas=$((falhas + 1))
  itens=$(grep -cE '^ +(ok|✓)' "$R/$p.txt"); [ "$p" = testes ] && itens=$(grep -oE '(ℹ pass [0-9]+|^[0-9]+ passed)' "$R/$p.txt" | grep -oE '[0-9]+' | awk '{s+=$1} END {print s+0}')
  printf '%-12s %-6s %4s verificacoes  %4ss\n' "$p" "$r" "$itens" $((SECONDS - t0))
  [ $r = ok ] || { echo "             ver $R/$p.txt"; grep -E 'FALHA|✖|✘|FAILED' "$R/$p.txt" | head -3 | sed 's/^/             /'; }
done
echo; [ $falhas = 0 ] && echo "TUDO OK ($total provas em $((SECONDS / 60)) min)" || { echo "$falhas de $total falharam"; exit 1; }
