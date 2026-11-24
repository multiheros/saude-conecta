#!/usr/bin/env bash
# Antes de apresentar (~2 min): poe no cache do LLM as queixas do roteiro (vale 24 h) e enche a agenda.
# A camada gratuita permite 15 chamadas por minuto e cada triagem nova usa 3; por isso a espera entre elas.
. "$(dirname "$0")/_comum.sh"
QUEIXAS=("dor de cabeca muito forte que comecou de repente e pescoco duro" "dor de garganta ha dois dias" "tosse e coriza ha dois dias" "dor lombar ao levantar peso" "dor de ouvido desde ontem")
n "Aquecendo a demonstracao"
faltou=0
if [ "$(ges GET /admin/v1/saude-ia | bonito j.habilitado)" = true ]; then
  for q in "${QUEIXAS[@]}"; do
    for t in 1 2 3 4 5 6; do
      o=$(pac POST /web/v1/triagem "{\"sintomas\":\"$q\"}" | campo origem)
      [ "$o" = LLM ] || [ "$o" = CACHE ] && break
      printf '  . provedor instavel, nova tentativa em 20 s: %s\n' "$q"; sleep 20
    done
    if [ "$o" = LLM ] || [ "$o" = CACHE ]; then certo "no cache: $q"; else printf '  ! por regras: %s\n' "$q"; faltou=$((faltou + 1)); fi
    [ "$o" = LLM ] && sleep 13
  done
else echo "  sem chave do LLM: a triagem vai responder por regras"; fi
R=$(ges GET "/admin/v1/agendamentos/resumo?ubsId=$UBS&periodo=$(date +%Y-%m)" | grep -oE '"reservados":[0-9]+' | cut -d: -f2)
[ "${R:-0}" -ge 10 ] && certo "agenda ja tem dados ($R reservas no mes)" || G=$G scripts/demo/dados.sh
[ $faltou = 0 ] && certo "pronto" || { echo "  ! $faltou queixa(s) fora do cache: rode de novo"; exit 1; }
