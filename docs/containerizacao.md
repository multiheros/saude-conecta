# 🐳 Containerização e Orquestração (Parte 3)

Como o sistema roda em containers (Docker Compose) e no cluster (Kubernetes), e por que cada decisão foi tomada. Instruções de execução no [README](../README.md#-como-executar).

## 1. Imagens (Dockerfile por serviço)

| Componente | Base | Porta | Estágios |
|------------|------|-------|----------|
| `pacientes`, `agendamento`, `notificacoes` | `node:22-alpine` | 8001 / 8002 / 8004 | 2 |
| `triagem` | `python:3.12-slim` | 8003 | 2 |
| `bff-web`, `bff-admin` | `node:22-alpine` | 3001 / 3002 | 2 |
| `gateway` (Compose) | `nginx:1.27-alpine` | 80 | 1 |
| `rabbitmq` | `rabbitmq:3.13-management-alpine` | 5672 | 1 (filas, DLQs e bindings declarados em `infra/rabbitmq`) |

**Multi-stage — ganho:**
- *Node:* o estágio `deps` roda `npm ci --omit=dev`; a imagem final recebe só `node_modules` de produção e o código, sem cache do npm. Alterar só o código reaproveita a camada de dependências (build mais rápido).
- *Python:* o estágio `builder` instala os pacotes em `/install`; a imagem final copia só esse prefixo, sem pip e sem arquivos de build.
- Todas rodam como **usuário não-root** e têm `HEALTHCHECK` apontando para `/ready`.
- O gateway tem estágio único porque só copia arquivos de configuração: não há etapa de build para separar.

Pacientes, Agendamento e Notificações compartilham `libs/comum` (banco, Outbox, broker, consumidor e base HTTP). Por isso o contexto de build deles é a raiz, e o `.dockerignore` da raiz é uma **lista do que entra** (`libs` e `services`). É código compartilhado em tempo de build: cada imagem leva a sua cópia, sem dependência em execução.

## 2. Docker Compose

`docker-compose.yml` sobe 12 containers com um comando: gateway, 2 BFFs, 4 serviços de domínio, 4 bancos e RabbitMQ. Um 13º, `chaves`, roda uma vez e termina: gera o par RSA do JWT. A chave privada fica num volume montado só em Pacientes; nada é versionado.

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
| `backend` | gateway, BFFs, serviços | Tráfego interno entre serviços |
| `mensageria` | serviços que publicam ou consomem eventos, RabbitMQ | `internal: true` |
| `data-<serviço>` (4) | um serviço e o seu banco | `internal: true`: sem saída externa; nenhum outro serviço, BFF ou gateway alcança aquele banco |

Todos os bancos exigem senha, e cada um tem a sua. Para comprovar o isolamento com a stack no ar (o script também confere que cada serviço alcança o próprio banco):

```bash
scripts/verificar_isolamento.sh
```

`depends_on` com `condition: service_healthy` garante que cada serviço só sobe depois do seu banco.

Credenciais vêm de variáveis de ambiente com valores padrão de desenvolvimento (sobrescritas por um `.env` local, não versionado; modelo em [`.env.example`](../.env.example)). O MongoDB e o PostgreSQL só criam o usuário em volume vazio: ao trocar senhas, recrie com `docker compose down -v`.

## 3. Kubernetes (`k8s/`)

| Arquivo | Conteúdo |
|---------|----------|
| `00-namespace.yaml` | Namespace `saudeconecta` |
| `01-configmap.yaml` | URLs entre serviços e host/porta de cada banco |
| `02-secrets.yaml` | Um Secret por serviço e um do RabbitMQ (valores de desenvolvimento) |
| `03-bancos.yaml` | 4 StatefulSets (um por banco) + Services headless + PVC de 1Gi cada |
| `04-aplicacoes.yaml` | 6 Deployments (2 réplicas) + Services, com probes e limites de recursos |
| `05-rabbitmq.yaml` | StatefulSet + PVC + Service |
| `06-ingress.yaml` | Ingress: `/web/v1` e `/admin/v1` (com remoção do prefixo), `/api/v1/*` e a rota de preferências de notificação |
| `07-networkpolicy.yaml` | Cada banco só aceita conexão do seu serviço |
| `scripts/k8s-chaves.sh` | Cria o Secret `jwt-privada` e o ConfigMap `jwt-publica` no cluster |
| `cluster/kind-config.yaml` | Cluster local; Ingress exposto em `localhost:8081` |

- **Deployments** para serviços stateless (escalam livremente); **StatefulSets** para bancos e RabbitMQ (identidade e volume estáveis).
- **ConfigMap** guarda o que não é sensível; **Secret** guarda credenciais e é injetado via `secretKeyRef`, fora das imagens.
- **Readiness** em `/ready` (verifica o banco): sem banco, o pod sai do balanceamento. **Liveness** em `/live` (só o processo): uma falha do banco não reinicia o serviço.
- **Ingress** faz o papel do gateway, seguindo [`gateway-routing.md`](gateway-routing.md).

> ⚠️ Os valores em `02-secrets.yaml` são **de desenvolvimento**. Em produção devem vir de um cofre (External Secrets, Sealed Secrets) e nunca ser versionados.

### Escalabilidade

```bash
kubectl -n saudeconecta scale deploy/bff-web --replicas=4
kubectl -n saudeconecta get pods -l app=bff-web
for i in $(seq 1 12); do curl -s localhost:8081/web/v1/home | grep -o '"atendidoPor":"[^"]*"'; done | sort | uniq -c
```

A resposta inclui `atendidoPor` (nome do pod), então a distribuição das requisições entre as réplicas fica visível.

## 4. Testes

| Comando | O que prova |
|---------|-------------|
| `scripts/testar.sh` | Testes de integração dos 4 serviços contra PostgreSQL, MongoDB, Redis e RabbitMQ descartáveis: SAGA com falha em cada passo, concorrência, compensação, eventos repetidos ou fora de ordem, permissões, DLQ e Outbox |
| `scripts/verificar_saga.sh` | SAGA na stack real: caminho feliz, compensação em cascata, participante morto, disputa de horário e `kill -9` no orquestrador (~70 s) |
| `scripts/verificar_outbox.sh` | Nenhum evento se perde com RabbitMQ parado, `kill -9` ou reinício do broker |
| `scripts/verificar_isolamento.sh` | Isolamento de rede e senha dos bancos (com a stack no ar) |

## 5. Limitações desta etapa
- Os 4 serviços já usam o próprio banco e RabbitMQ, e a SAGA está completa. As consultas do Agendamento ainda leem o banco de escrita (o Read Model vem na etapa de CQRS). A **Triagem** classifica por regras; LLM e RAG vêm em seguida.
- O gateway ainda não valida o JWT, e os BFFs usam uma identidade fixa de demonstração.
- O ChromaDB (base vetorial da Triagem) ainda não está na stack; entra junto com o RAG.
- O gateway do Compose é NGINX; no Kubernetes o papel é do Ingress. Autenticação JWT e rate limiting do Kong estão documentados em [`gateway-routing.md`](gateway-routing.md) e ficam para a Parte 4.
