#!/usr/bin/env bash
# Cena 7: o provedor do LLM some. Circuito abre, o fallback responde e a SAGA conclui.
. "$(dirname "$0")/_comum.sh"
religar() { dc exec -T -u root triagem sh -c "sed '/$HOST/d' /etc/hosts > /tmp/h && cat /tmp/h > /etc/hosts" >/dev/null; }
trap religar EXIT
saude() { ges GET /admin/v1/saude-ia | bonito "$1"; }
HOST=$( [ "$(saude j.provedor)" = gemini ] && echo generativelanguage.googleapis.com || echo api.deepseek.com )
n "Cena 7. LLM como dependencia falivel"
igual "LLM habilitado (chave no .env)" "$(saude j.habilitado)" true
echo "  provedor $(saude j.provedor), modelo $(saude j.modelo)"
passo "Com o provedor no ar"
T0=$(date +%s%3N); R=$(pac POST /web/v1/triagem '{"sintomas":"dor de dente leve ao mastigar ha dois dias"}'); echo "  origem $(campo origem <<< "$R"), $(( $(date +%s%3N) - T0 )) ms"
pausa
passo "Cortar o provedor: o nome dele passa a apontar para lugar nenhum"
dc exec -T -u root triagem sh -c "echo '127.0.0.1 $HOST' >> /etc/hosts"; sleep 6 # conexoes ociosas fecham em 5 s
for q in "dor no joelho depois de correr" "mancha na pele do braco ha uma semana" "azia depois de comer ha tres dias"; do
  T0=$(date +%s%3N); R=$(pac POST /web/v1/triagem "{\"sintomas\":\"$q\"}"); MS=$(( $(date +%s%3N) - T0 ))
  echo "  \"$q\": $(campo origem <<< "$R"), $MS ms, circuito $(saude j.circuito)"; [ "$MS" -lt 9000 ] || erro "demorou demais"
done
espera "saude j.circuito" ABERTO; certo "circuito aberto"
T0=$(date +%s%3N); R=$(pac POST /web/v1/triagem '{"sintomas":"coceira nas costas ha dois dias"}'); MS=$(( $(date +%s%3N) - T0 ))
[ "$MS" -lt 1500 ] && certo "com o circuito aberto: $MS ms, $(campo origem <<< "$R"), com fontes do RAG" || erro "$MS ms"
pausa
passo "A SAGA conclui sem o modelo"
ID=$(pedir "$(livre)" "coceira no braco ha dois dias"); espera "estado $ID" CONCLUIDA; passos "$ID"
pac POST "/web/v1/agendamentos/$ID/cancelamento" '{"motivo":"fim da cena"}' >/dev/null
pausa
passo "Religar o provedor: em ate 30 s o circuito testa e fecha"
religar; for _ in $(seq 25); do pac POST /web/v1/triagem '{"sintomas":"olho vermelho com remela ha um dia"}' >/dev/null; [ "$(saude j.circuito)" = FECHADO ] && break; sleep 4; done
igual "circuito" "$(saude j.circuito)" FECHADO
saude "'  chamadas '+j.chamadas+', repeticoes '+j.repeticoes+', cache '+j.acertosCache+', regras '+j.fallbacks+', falhas '+JSON.stringify(j.falhasPorMotivo)"
