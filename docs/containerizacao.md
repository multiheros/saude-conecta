# 🐳 Containerização e Orquestração (Parte 3)

Como o sistema roda em containers (Docker Compose) e no cluster (Kubernetes), e por que cada decisão foi tomada. Instruções de execução no [README](../README.md#-como-executar).

## 1. Imagens (Dockerfile por serviço)

| Componente | Base | Porta | Estágios |
|------------|------|-------|----------|
| `pacientes`, `agendamento`, `notificacoes` | `node:22-alpine` | 8001 / 8002 / 8004 | 2 |
| `triagem` | `python:3.12-slim` | 8003 | 2 |
| `bff-web`, `bff-admin` | `node:22-alpine` | 3001 / 3002 | 2 |
| `gateway` (Compose) | `nginx:1.27-alpine` | 80 | 1 |

**Multi-stage — ganho:**
- *Node:* o estágio `deps` roda `npm ci --omit=dev`; a imagem final recebe só `node_modules` de produção e o código, sem cache do npm. Alterar só o código reaproveita a camada de dependências (build mais rápido).
- *Python:* o estágio `builder` instala os pacotes em `/install`; a imagem final copia só esse prefixo, sem pip e sem arquivos de build.
- Todas rodam como **usuário não-root** e têm `HEALTHCHECK` apontando para `/health`.
- O gateway tem estágio único porque só copia arquivos de configuração: não há etapa de build para separar.

Cada serviço tem `.dockerignore` para não enviar `node_modules` nem arquivos desnecessários ao contexto de build.

## 2. Docker Compose

`docker-compose.yml` sobe 12 containers com um comando: gateway, 2 BFFs, 4 serviços de domínio, 4 bancos e RabbitMQ.

**Database per Service, instâncias separadas:**

| Serviço | Banco | Volume |
|---------|-------|--------|
| pacientes | PostgreSQL (`db-pacientes`) | `pacientes-data` |
| agendamento | PostgreSQL (`db-agendamento`) | `agendamento-data` |
| triagem | MongoDB (`db-triagem`) | `triagem-data` |
| notificacoes | Redis (`db-notificacoes`) | `notificacoes-data` |
| (mensageria) | RabbitMQ | `rabbitmq-data` |

**Redes (isolamento entre camadas):**

| Rede | Quem participa | Observação |
|------|----------------|------------|
| `frontend` | gateway, BFFs | Única com porta publicada (8080, via gateway) |
| `backend` | gateway, BFFs, serviços, RabbitMQ | Tráfego interno entre serviços |
| `data` | serviços, bancos | `internal: true`: sem saída externa; gateway e BFFs **não alcançam** os bancos |

`depends_on` com `condition: service_healthy` garante que cada serviço só sobe depois do seu banco.

Credenciais vêm de variáveis de ambiente com valores padrão de desenvolvimento (sobrescritas por um `.env` local, que não é versionado).

## 3. Kubernetes (`k8s/`)

| Arquivo | Conteúdo |
|---------|----------|
| `00-namespace.yaml` | Namespace `saudeconecta` |
| `01-configmap.yaml` | URLs entre serviços e host/porta de cada banco |
| `02-secrets.yaml` | Credenciais dos bancos e do RabbitMQ (valores de desenvolvimento) |
| `03-bancos.yaml` | 4 StatefulSets (um por banco) + Services headless + PVC de 1Gi cada |
| `04-aplicacoes.yaml` | 6 Deployments (2 réplicas) + Services, com probes e limites de recursos |
| `05-rabbitmq.yaml` | StatefulSet + PVC + Service |
| `06-ingress.yaml` | Ingress: `/web/v1` e `/admin/v1` (com remoção do prefixo) e `/api/v1/*` |
| `cluster/kind-config.yaml` | Cluster local; Ingress exposto em `localhost:8081` |

- **Deployments** para serviços stateless (escalam livremente); **StatefulSets** para bancos e RabbitMQ (identidade e volume estáveis).
- **ConfigMap** guarda o que não é sensível; **Secret** guarda credenciais e é injetado via `secretKeyRef`, fora das imagens.
- **Readiness/liveness probes** em `/health`: o tráfego só chega em pods prontos e pods travados são reiniciados.
- **Ingress** faz o papel do gateway, seguindo [`gateway-routing.md`](gateway-routing.md).

> ⚠️ Os valores em `02-secrets.yaml` são **de desenvolvimento**. Em produção devem vir de um cofre (External Secrets, Sealed Secrets) e nunca ser versionados.

### Escalabilidade

```bash
kubectl -n saudeconecta scale deploy/bff-web --replicas=4
kubectl -n saudeconecta get pods -l app=bff-web
for i in $(seq 1 12); do curl -s localhost:8081/web/v1/home | grep -o '"atendidoPor":"[^"]*"'; done | sort | uniq -c
```

A resposta inclui `atendidoPor` (nome do pod), então a distribuição das requisições entre as réplicas fica visível.

## 4. Limitações desta etapa
- Os serviços são mínimos, com dados fixos. SAGA, CQRS, Outbox e RAG serão implementados na Parte 4.
- O ChromaDB (base vetorial da Triagem) ainda não está na stack; entra junto com o RAG.
- O gateway do Compose é NGINX; no Kubernetes o papel é do Ingress. Autenticação JWT e rate limiting do Kong estão documentados em [`gateway-routing.md`](gateway-routing.md) e ficam para a Parte 4.
