#!/usr/bin/env bash
# Sobe tudo no Kubernetes local (kind) com um comando: cluster, Ingress, imagens, chaves e manifestos.
#   scripts/k8s-subir.sh                      cluster "saudeconecta" em http://localhost:8081
#   CLUSTER=outro PORTA=8091 scripts/k8s-subir.sh
# Precisa de kind, kubectl e internet (o cluster baixa as imagens dos bancos). Se houver DEEPSEEK_API_KEY ou GEMINI_API_KEY
# no .env, cria o Secret com elas; as chaves nao passam por nenhum arquivo versionado.
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER=${CLUSTER:-saudeconecta}; PORTA=${PORTA:-8081}; NS=saudeconecta
export KUBE_CONTEXT=kind-$CLUSTER
K="kubectl --context $KUBE_CONTEXT"
tentar() { for n in 1 2 3 4 5; do "$@" && return; echo "  nova tentativa ($n) em 10 s"; sleep 10; done; return 1; }

echo "1. Cluster"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then echo "  ja existe"; else
  sed "s/hostPort: 8081/hostPort: $PORTA/; s/^name: .*/name: $CLUSTER/" k8s/cluster/kind-config.yaml | tentar kind create cluster --config - --wait 120s
fi
echo "2. Ingress"
tentar $K apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/kind/deploy.yaml >/dev/null
tentar $K -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=240s
echo "3. Imagens do projeto"
[ -n "${SEM_BUILD:-}" ] || scripts/preparar.sh | grep -E 'FALHA|presentes'
for i in $(docker compose config --images | grep '^saudeconecta/' | grep -v '/chaves:' | sort -u); do
  kind load docker-image "$i" --name "$CLUSTER" >/dev/null 2>&1 && echo "  ok    $i" || { echo "  FALHA ao carregar $i"; exit 1; }
done
echo "4. Chaves e manifestos"
$K apply -f k8s/00-namespace.yaml >/dev/null
scripts/k8s-chaves.sh
CHAVES=$(grep -E '^(DEEPSEEK|GEMINI)_API_KEY=.' .env 2>/dev/null | tr -d '\r' || true)
if [ -n "$CHAVES" ]; then
  $K -n $NS create secret generic triagem-llm --from-env-file=<(printf '%s\n' "$CHAVES") --dry-run=client -o yaml | $K apply -f - >/dev/null && echo "  Secret do LLM criado a partir do .env"
else echo "  sem chave do LLM: a triagem trabalha por regras"; fi
unset CHAVES
tentar $K apply -f k8s/ >/dev/null # o Ingress pode precisar de mais de uma vez: o webhook dele demora a responder
echo "5. Esperando (o Kubernetes baixa os bancos e a Triagem carrega a base do RAG)"
for d in db-pacientes db-agendamento db-agendamento-leitura db-triagem db-triagem-vetores db-notificacoes rabbitmq; do $K -n $NS rollout status statefulset/$d --timeout=420s | tail -1; done
for d in $($K -n $NS get deploy -o name); do $K -n $NS rollout status "$d" --timeout=420s | tail -1; done
$K -n $NS wait --for=condition=complete job/triagem-ingestao --timeout=600s
for _ in $(seq 60); do [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$PORTA/health")" = 200 ] && break; sleep 2; done
echo; $K -n $NS get pods --no-headers | awk '{print $3}' | sort | uniq -c
echo "App: http://localhost:$PORTA   Painel: http://localhost:$PORTA/painel"
echo "Contexto: kubectl --context $KUBE_CONTEXT -n $NS ..."
