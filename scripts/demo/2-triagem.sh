#!/usr/bin/env bash
# Cena 2: triagem com RAG (fonte e pagina) e tool que le a agenda real. Use a queixa do roteiro: fica no cache.
. "$(dirname "$0")/_comum.sh"
Q=${1:-dor de cabeca muito forte que comecou de repente e pescoco duro}
n "Cena 2. Triagem com RAG e LangChain"
passo "O que o RAG recupera para: \"$Q\""
dc exec -T triagem python -m app.rag.busca "$Q" | grep -E '^0' | sed 's/^/  /'
pausa
passo "A triagem, pelo gateway"
T0=$(date +%s%3N); R=$(pac POST /web/v1/triagem "{\"sintomas\":\"$Q\"}"); MS=$(( $(date +%s%3N) - T0 ))
bonito "'  '+j.urgencia.nivel+' ('+j.urgencia.texto+'), origem '+j.origem+', $MS ms\n  '+j.justificativa+'\n  Fontes:\n'+j.fontes.map((f)=>'    - '+f).join('\n')+'\n  Horarios (agenda real):\n'+j.horarios.map((h)=>'    - '+h.quando+(h.dentroDoPrazo?'':' (fora do prazo)')).join('\n')" <<< "$R"
[ "$(grep -c 'Caderno de Aten' <<< "$R")" -gt 0 ] && certo "resposta com fonte e pagina" || erro "sem fonte"
pausa
passo "A tool reflete a agenda: reservado o primeiro horario, ele sai da recomendacao"
V='dor de garganta ha dois dias'
S=$(pac POST /web/v1/triagem "{\"sintomas\":\"$V\"}" | campo slotId); echo "  recomendado antes: $S"
ID=$(pedir "$S" "$V"); espera "estado $ID" CONCLUIDA; certo "horario reservado pela SAGA"
for _ in 1 2 3 4 5 6; do D=$(pac POST /web/v1/triagem "{\"sintomas\":\"$V\"}"); grep -q "$S" <<< "$D" || break; sleep 1; done
grep -q "$S" <<< "$D" && erro "ainda recomendado" || { echo "  recomendado agora: $(campo slotId <<< "$D")"; certo "a recomendacao mudou"; }
pac POST "/web/v1/agendamentos/$ID/cancelamento" '{"motivo":"fim da cena"}' >/dev/null
