#!/usr/bin/env bash
# Cena 4: escrita no PostgreSQL, leitura no MongoDB e Redis, com a defasagem medida.
. "$(dirname "$0")/_comum.sh"
n "Cena 4. CQRS"
S=$(livre); ID=$(pedir "$S" "dor lombar ao levantar peso"); espera "estado $ID" CONCLUIDA
passo "Escrita: a linha no PostgreSQL"
sql "SELECT id, status, version, atualizado_em FROM agendamentos WHERE id='$ID'"
passo "Leitura: o documento no MongoDB, pronto para a tela"
espera "mongo \"print((db.agendamentos_view.findOne({_id:'$ID'})||{}).status)\"" AGENDADO
mongo "const a=db.agendamentos_view.findOne({_id:'$ID'});printjson({_id:a._id,status:a.status,versao:a.versao,ubs:a.ubs.nome,profissional:a.profissional.nome,atualizadoEm:a.atualizadoEm,projetadoEm:a.projetadoEm})"
certo "mesma versao nos dois lados"
pausa
passo "Uma escrita nova (confirmar) e quanto a leitura demora para refleti-la"
for i in 1 2 3; do
  if [ $i = 1 ]; then R=$(pac POST "/web/v1/agendamentos/$ID/confirmacao" '{}'); else R=$(pac POST "/web/v1/agendamentos/$ID/reagendamento" "{\"novoSlotId\":\"$(livre $((14 + i)))\"}"); fi
  V=$(grep -o '"versao":[0-9]*' <<< "$R" | cut -d: -f2)
  D=$(ges GET "/api/v1/agendamentos/$ID?versaoMinima=$V" | bonito "Date.parse(j.projetadoEm)-Date.parse(j.atualizadoEm)")
  [ "$D" -lt 5000 ] && certo "versao $V refletida em $D ms (meta: 5000)" || erro "defasagem de $D ms"
done
pac POST "/web/v1/agendamentos/$ID/cancelamento" '{"motivo":"fim da cena"}' >/dev/null
