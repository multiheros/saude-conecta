# 🐳 Containerização e Orquestração

Como o sistema roda em containers (Docker Compose) e no cluster (Kubernetes), e por que cada decisão foi tomada. Instruções de execução no [README](../README.md#-como-executar).

## 1. Imagens (Dockerfile por serviço)

| Componente | Base | Porta | Estágios |
|------------|------|-------|----------|
| `pacientes`, `agendamento`, `notificacoes` | `node:22-alpine` | 8001 / 8002 / 8004 | 2 |
| `triagem` | `python:3.12-slim` | 8003 | 3 (o terceiro baixa o modelo de embeddings, com hash conferido) |
| `bff-web`, `bff-admin` | `node:22-alpine` | 3001 / 3002 | 2 |
| `gateway` | `kong:3.9.1` | 8000 | 1 (configuração declarativa e 2 plugins) |
| `web-paciente`, `web-gestor` | `nginxinc/nginx-unprivileged:1.27-alpine` | 8080 | 2 (o primeiro compila o React) |
| `rabbitmq` | `rabbitmq:3.13-management-alpine` | 5672 | 1 (filas, DLQs e bindings declarados em `infra/rabbitmq`) |

**Multi-stage — ganho:**
- *Node:* o estágio `deps` roda `npm ci --omit=dev`; a imagem final recebe só `node_modules` de produção e o código, sem cache do npm. Alterar só o código reaproveita a camada de dependências (build mais rápido).
- *Python:* o estágio `builder` instala os pacotes em `/install`; a imagem final copia só esse prefixo, sem pip e sem arquivos de build.
- Todas rodam como **usuário não-root** e têm `HEALTHCHECK` apontando para `/ready`.
- O gateway tem estágio único porque só copia arquivos de configuração: não há etapa de build para separar.

Pacientes, Agendamento, Notificações e os BFFs compartilham `libs/comum` (banco, Outbox, broker, consumidor e base HTTP). Por isso o contexto de build deles é a raiz, e o `.dockerignore` da raiz é uma **lista do que entra** (`libs`, `services` e `bff`). É código compartilhado em tempo de build: cada imagem leva a sua cópia, sem dependência em execução.

## 2. Docker Compose

`docker-compose.yml` sobe 18 containers com um comando: gateway, 2 telas, 2 BFFs, 4 serviços de domínio, 7 bancos, o contador do gateway e RabbitMQ. Outros dois rodam e terminam: `triagem-ingestao` carrega a base do RAG (1 a 2 min na primeira vez; depois não faz nada) e `chaves` gera o par RSA do JWT. A chave privada fica num volume montado só em Pacientes; nada é versionado.

**Database per Service, instâncias separadas:**

| Serviço | Banco | Volume |
|---------|-------|--------|
| pacientes | PostgreSQL (`db-pacientes`) | `pacientes-data` |
| agendamento (escrita) | PostgreSQL (`db-agendamento`) | `agendamento-data` |
| agendamento (leitura, CQRS) | MongoDB (`db-agendamento-leitura`) | `agendamento-leitura-data` |
| agendamento (cache de vagas) | Redis (`cache-agendamento`) | nenhum: é cache |
| triagem | MongoDB (`db-triagem`) | `triagem-data` |
| triagem (base vetorial, RAG) | ChromaDB (`db-triagem-vetores`) | `triagem-vetores-data` |
| notificacoes | Redis (`db-notificacoes`) | `notificacoes-data` |
| gateway (contador do limite) | Redis (`cache-gateway`) | nenhum: é cache |
| (mensageria) | RabbitMQ | `rabbitmq-data` |

**Redes (isolamento entre camadas):**

| Rede | Quem participa | Observação |
|------|----------------|------------|
| `frontend` | gateway, telas, BFFs | Única com porta publicada (8080, via gateway) |
| `backend` | gateway, BFFs, serviços | Tráfego interno entre serviços |
| `mensageria` | serviços que publicam ou consomem eventos, RabbitMQ | `internal: true` |
| `data-<serviço>` (4) e `data-gateway` | um serviço (ou o gateway) e os seus bancos | `internal: true`: sem saída externa; nenhum outro serviço, BFF ou gateway alcança aquele banco |

Todos os bancos exigem senha, e cada um tem a sua, menos o ChromaDB, que não tem autenticação e guarda só conteúdo público: a proteção dele é a rede. Para comprovar o isolamento com a stack no ar (o script também confere que cada serviço alcança o próprio banco):

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
| `03-bancos.yaml` | 6 StatefulSets + Services headless + PVC de 1Gi cada; o cache de vagas (Redis) é Deployment sem volume |
| `04-aplicacoes.yaml` | 9 Deployments (2 réplicas) e o contador do gateway + Services, com probes e limites de recursos, e o Job da ingestão do RAG |
| `05-rabbitmq.yaml` | StatefulSet + PVC + Service |
| `06-ingress.yaml` | Ingress único: tudo vai para o gateway (Kong) |
| `07-networkpolicy.yaml` | Cada banco só aceita conexão do seu serviço; serviços só da borda e de outros serviços; BFFs só do gateway |
| `scripts/k8s-chaves.sh` | Cria o Secret `jwt-privada` e o ConfigMap `jwt-publica` no cluster |
| `cluster/kind-config.yaml` | Cluster local; Ingress exposto em `localhost:8081` |

- **Deployments** para serviços stateless (escalam livremente); **StatefulSets** para bancos e RabbitMQ (identidade e volume estáveis).
- **ConfigMap** guarda o que não é sensível; **Secret** guarda credenciais e é injetado via `secretKeyRef`, fora das imagens.
- **Readiness** em `/ready` (verifica o banco): sem banco, o pod sai do balanceamento. **Liveness** em `/live` (só o processo): uma falha do banco não reinicia o serviço.
- **Ingress** só leva o tráfego ao gateway, que é a única fonte de rotas, no Compose e no cluster: [`gateway-routing.md`](gateway-routing.md). Quem tinha os três Ingress antigos precisa apagá-los: `kubectl -n saudeconecta delete ingress saudeconecta-bffs saudeconecta-api saudeconecta-preferencias`.

> ⚠️ Os valores em `02-secrets.yaml` são **de desenvolvimento**. Em produção devem vir de um cofre (External Secrets, Sealed Secrets) e nunca ser versionados.

A chave do LLM é opcional e criada à mão, sem passar pelo repositório:

```bash
kubectl -n saudeconecta create secret generic triagem-llm --from-literal=GEMINI_API_KEY=SUA_CHAVE
kubectl -n saudeconecta rollout restart deploy/triagem
```

### Escalabilidade

```bash
kubectl -n saudeconecta scale deploy/bff-web --replicas=4
kubectl -n saudeconecta get pods -l app=bff-web
T=$(curl -s localhost:8081/api/v1/auth/login -H 'content-type: application/json' -d '{"cpf":"10000000108","senha":"demo12345"}' | sed 's/.*accessToken":"\([^"]*\).*/\1/')
for i in $(seq 1 12); do curl -s -D- -o /dev/null -H "Authorization: Bearer $T" localhost:8081/web/v1/home | grep -i x-instance; done | sort | uniq -c
```

A resposta traz o cabeçalho `X-Instance` (nome do pod), então a distribuição das requisições entre as réplicas fica visível.

## 4. Testes

| Comando | O que prova |
|---------|-------------|
| `scripts/e2e.sh` | Todas as provas abaixo, uma por vez, com resumo (~17 min) |
| `scripts/testar.sh` | Testes dos 2 BFFs e de integração dos 4 serviços contra PostgreSQL, MongoDB, Redis e RabbitMQ descartáveis: SAGA com falha em cada passo, concorrência, compensação, eventos repetidos ou fora de ordem, permissões, DLQ e Outbox |
| `scripts/verificar_saga.sh` | SAGA na stack real: caminho feliz, compensação em cascata, participante morto, disputa de horário e `kill -9` no orquestrador (~70 s) |
| `scripts/verificar_cqrs.sh` | CQRS na stack real: escrita aparece na leitura, defasagem medida, MongoDB, Redis ou RabbitMQ fora, Read Model perdido e reconstruído (~90 s) |
| `scripts/verificar_rag.sh` | RAG na stack real: ingestão sem internet e sem duplicar, busca com página, ChromaDB parado, travado ou perdido (~3 min) |
| `scripts/verificar_llm.sh` | LLM na stack real, com servidor falso no lugar do provedor: cache, privacidade, tool com a agenda real, provedor travado, circuit breaker e fallback (~3 min) |
| `scripts/verificar_gateway.sh` | Gateway e BFFs na stack real, só pela porta publicada: JWT, perfis, cabeçalho forjado, fluxo do paciente, painel e limite de requisições (~3 min) |
| `scripts/verificar_telas.sh` | As duas telas com navegador real, na stack completa: fluxos, compensação visível, acessibilidade (~4 min) |
| `scripts/verificar_offline.sh` | A stack sobe sem construir nem baixar nada e funciona sem internet |
| `scripts/verificar_outbox.sh` | Nenhum evento se perde com RabbitMQ parado, `kill -9` ou reinício do broker |
| `scripts/verificar_isolamento.sh` | Isolamento de rede e senha dos bancos (com a stack no ar) |

`scripts/preparar.sh` baixa e constrói tudo com antecedência, repetindo se o Docker Hub falhar; depois, `docker compose up -d --no-build` não depende dele. As imagens têm o mesmo nome no Compose e no Kubernetes (`saudeconecta/<serviço>:1.0`).

## 5. Limitações
- Os 4 serviços já usam o próprio banco e RabbitMQ, a SAGA está completa e as consultas do Agendamento vêm do Read Model (CQRS). A **Triagem** usa RAG e LLM; sem a chave do provedor, trabalha por regras.
- TLS não está habilitado no ambiente local.
- Limitações das telas: [`clientes.md`](clientes.md).
