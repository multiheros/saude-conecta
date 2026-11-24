#!/usr/bin/env bash
# Cena 5: falha provocada. Com Notificacoes desligado, a SAGA compensa 3 -> 2 -> 1.
. "$(dirname "$0")/_comum.sh"
trap 'dc start notificacoes >/dev/null' EXIT
n "Cena 5. SAGA com falha e compensacao"
passo "docker compose stop notificacoes"
docker compose stop notificacoes 2>/dev/null; certo "Notificacoes desligado"
S=$(livre); passo "Agendar o horario $S"
ID=$(pedir "$S" "dor de ouvido desde ontem"); espera "estado $ID" FALHOU; passos "$ID"
SAGA=$(sql "SELECT id FROM saga_instances WHERE agendamento_id='$ID'" -qtA)
ges GET "/api/v1/sagas/$SAGA" | bonito "'  '+j.estado+': '+j.motivo+'\n'+j.historico.map((h)=>'    '+h.passo.padEnd(16)+h.tipo.padEnd(13)+h.resultado).join('\n')"
pausa
passo "Os bancos voltaram ao que eram"
igual "horario no PostgreSQL" "$(sql "SELECT status FROM slots WHERE id='$S'" -qtA)" LIVRE
igual "paciente livre para agendar" "$(dc exec -T db-pacientes psql -qtA -U "${PACIENTES_DB_USER:-pacientes}" -d pacientes -c "SELECT agendamento_saga_id IS NULL FROM pacientes WHERE id='$P1'")" t
igual "triagens da SAGA no MongoDB" "$(mongot "print(db.triagens.countDocuments({sagaId:'$SAGA'}))")" 0
espera "pac GET '/web/v1/horarios?especialidade=Cl%C3%ADnica%20Geral' | grep -c '$S'" 1; certo "horario de volta na tela do paciente"
pausa
passo "docker compose start notificacoes, e o mesmo horario e agendado"
docker compose start notificacoes 2>/dev/null; espera "dc exec -T agendamento node -e \"fetch('http://notificacoes:8004/ready').then((r)=>console.log(r.status)).catch(()=>console.log(0))\"" 200
ID=$(pedir "$S" "dor de ouvido desde ontem"); espera "estado $ID" CONCLUIDA; certo "SAGA concluida"
pac POST "/web/v1/agendamentos/$ID/cancelamento" '{"motivo":"fim da cena"}' >/dev/null
