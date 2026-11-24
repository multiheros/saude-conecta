#!/usr/bin/env bash
# Cena 3: caminho feliz da SAGA, com o mesmo X-Correlation-Id em todos os servicos.
. "$(dirname "$0")/_comum.sh"
n "Cena 3. SAGA, caminho feliz"
CORR=cena3-$(date +%s); S=$(livre)
passo "Agendar (X-Correlation-Id: $CORR)"
ID=$(pedir "$S" "tosse e coriza ha dois dias" "$CORR"); echo "  202 Aceito, agendamento $ID"
espera "estado $ID" CONCLUIDA; passos "$ID"; certo "4 passos concluidos"
pausa
passo "O historico gravado pelo orquestrador (GET /sagas/{id})"
SAGA=$(sql "SELECT id FROM saga_instances WHERE agendamento_id='$ID'" -qtA)
ges GET "/api/v1/sagas/$SAGA" | bonito "'  '+j.estado+'\n'+j.historico.map((h)=>'    '+h.passo.padEnd(16)+h.tipo.padEnd(8)+h.resultado.padEnd(6)+String(h.duracaoMs??'').padStart(6)+' ms  '+(h.detalhe||'')).join('\n')"
pausa
passo "A mesma correlacao no log de cada servico"
for s in bff-web agendamento pacientes triagem notificacoes; do c=$(dc logs "$s" --no-log-prefix | grep -c "$CORR"); [ "$c" -gt 0 ] && certo "$s: $c linha(s)" || erro "$s sem a correlacao"; done
echo "$ID" > /tmp/saudeconecta-cena3
