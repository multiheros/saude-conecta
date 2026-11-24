# 📱📊 BFF — Por que dois? Comparativo de Payloads

> O README define: `bff-web` devolve dados simples, pessoais e acionáveis; `bff-admin` devolve dados agregados e analíticos. Aqui está a **justificativa técnica** e o **payload diff** para a mesma entidade.

## 1. Justificativa técnica

Um BFF (*Backend for Frontend*) adapta as APIs de domínio às necessidades de **um** tipo de cliente. Os dois clientes do SaúdeConecta divergem em quase tudo:

| Dimensão | `bff-web` (Paciente) | `bff-admin` (Gestor) |
|----------|----------------------|----------------------|
| Usuário | Cidadão, frequentemente em celular com rede fraca | Servidor municipal, desktop, rede estável |
| Escopo de dados | **Somente os seus** (filtrado por `X-User-Id`) | **Todas as UBS** da jurisdição |
| Formato | Enxuto, orientado a ação, textos prontos | Agregado, estatístico, séries temporais |
| Serviços consumidos | Pacientes · Agendamento · Triagem | Pacientes · Agendamento · Notificações · Triagem (saúde da IA) |
| Frequência | Muitas requisições pequenas | Poucas requisições pesadas |
| Cache | Nenhum | 30 s por unidade e período (configurável) |
| Dados sensíveis (LGPD) | Dados do próprio titular | **Anonimizados/agregados**; sem dados clínicos individuais |
| Perfil JWT | `paciente` | `gestor` |
| Disponibilidade | Crítica (agendar) | Tolerante a degradação |
| Ritmo de mudança | Acompanha a UX do app | Acompanha relatórios/indicadores |

### Por que não um BFF único (ou chamar os serviços direto)?

| Problema de um BFF único | Consequência |
|--------------------------|--------------|
| Payload "tamanho único" | Paciente baixa estatísticas que não usa; gestor recebe dados pobres |
| Risco de **vazamento** | Um `if (role)` esquecido expõe dados agregados/de terceiros ao paciente |
| Acoplamento de deploy | Mudar um relatório exige redeploy do fluxo crítico de agendamento |
| Escala diferente | Agendamento escala por picos de manhã; relatórios por consultas pesadas |
| Equipes/ritmos distintos | Conflitos de merge e de prioridade |
| Chamar serviços direto | N chamadas do cliente, lógica de agregação duplicada no front, domínio exposto |

**Decisão:** 2 BFFs, cada um com **contrato, cache, autorização e escala próprios**, atrás do mesmo Gateway (rotas `/web/v1` e `/admin/v1`, ver [`gateway-routing.md`](gateway-routing.md)). Lógica de **domínio permanece nos serviços**; os BFFs só **orquestram leitura e adaptam** (nunca decidem regra de negócio).

**Custos aceitos:** dois componentes a operar e possível duplicação de código de infraestrutura (mitigada por `libs/comum`: cliente HTTP, erros, correlação e saúde).

## 2. Payload Diff — mesma entidade: **Agendamento**

### 2.1 `GET /web/v1/agendamentos/{id}` — bff-web (enxuto, acionável)

Agrega: Agendamento + Triagem (orientações) + nome da UBS/profissional. ~**0,6 KB**.

```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "status": "AGENDADO",
  "titulo": "Consulta de Clínica Geral",
  "quando": "quarta, 05/11 às 09:30",
  "onde": "UBS Centro — Rua das Flores, 120",
  "profissional": "Dra. Ana Souza",
  "urgencia": { "nivel": "AMARELO", "texto": "Atendimento prioritário" },
  "orientacoes": ["Leve cartão SUS e documento com foto", "Chegue 15 minutos antes"],
  "triagem": { "justificativa": "...", "origem": "LLM", "fontes": ["Caderno de Atenção Básica nº 28, vol. II, 2.2 Cefaleia, p. 32"] },
  "_links": {
    "self": { "href": "/web/v1/agendamentos/3fa85f64-...", "method": "GET" },
    "confirmar": { "href": "/web/v1/agendamentos/3fa85f64-.../confirmacao", "method": "POST" },
    "reagendar": { "href": "/web/v1/agendamentos/3fa85f64-.../reagendamento", "method": "POST" },
    "cancelar": { "href": "/web/v1/agendamentos/3fa85f64-.../cancelamento", "method": "POST" }
  }
}
```

### 2.2 `GET /admin/v1/agendamentos/resumo?ubsId=...&periodo=2026-11` — bff-admin (agregado, estatístico)

Agrega: Agendamento (Read Model) + Pacientes (faixa etária/bairro, anonimizados) + Notificações (alertas). O envio é simulado, então não há taxa de entrega. ~**2,5 KB** (cresce com a série).

```json
{
  "ubs": { "id": "a1b2...", "nome": "UBS Centro", "regiao": "Zona Central" },
  "periodo": "2026-11",
  "capacidade": { "slotsTotais": 1240, "reservados": 1085, "ocupacaoPercentual": 87.5 },
  "porStatus": { "AGENDADO": 312, "CONFIRMADO": 540, "REALIZADO": 190, "CANCELADO": 28, "FALTOU": 15 },
  "absenteismo": { "taxa": 7.4, "metaReducao": 30, "tendencia": "QUEDA" },
  "demandaPorEspecialidade": [
    { "especialidade": "Clínica Geral", "agendamentos": 620, "ocupacao": 91.0 },
    { "especialidade": "Pediatria", "agendamentos": 210, "ocupacao": 78.2 }
  ],
  "porUrgencia": { "VERMELHO": 4, "LARANJA": 31, "AMARELO": 240, "VERDE": 640, "AZUL": 170 },
  "serieDiaria": [
    { "data": "2026-11-03", "agendados": 52, "faltas": 4 },
    { "data": "2026-11-04", "agendados": 58, "faltas": 3 }
  ],
  "pacientes": { "total": 1200, "porFaixaEtaria": { "18-59": 800 }, "porBairro": { "Centro": 400 } },
  "alertas": [
    { "tipo": "GARGALO", "especialidade": "Clínica Geral", "dia": "2026-11-05", "ocupacaoPercentual": 91.0, "mensagem": "Clínica Geral com 91% dos horários ocupados em 05/11/2026" }
  ],
  "geradoEm": "2026-11-05T10:00:03-03:00",
  "defasagemSegundos": 2,
  "parcial": false
}
```

### 2.3 Diff lado a lado

| Aspecto | bff-web | bff-admin |
|---------|---------|-----------|
| Granularidade | **1 agendamento** | **Agregado** de milhares |
| Identificação | Nome do profissional, endereço | Só IDs de UBS/região; **sem PII** |
| Texto | Pronto para exibir (`quando`, `onde`) | Números brutos; formatação no front |
| Navegação | `_links` (HATEOAS) → ações | Sem ações por registro; filtros por query |
| Estatística | Nenhuma | Ocupação, absenteísmo, tendência, série |
| Triagem | Orientações ao paciente | Distribuição por urgência |
| Alertas | — | Gargalos |
| Origens | Agendamento + Triagem + Pacientes | Agendamento + Pacientes + Notificações |
| Tamanho | ~0,6 KB | ~2,5 KB |
| Cache | Nenhum | 30 s |
| Campos exclusivos | `titulo`, `quando`, `onde`, `orientacoes`, `_links` | `capacidade`, `porStatus`, `absenteismo`, `serieDiaria`, `alertas` |

### 2.4 Fluxo de composição

```mermaid
sequenceDiagram
    participant W as bff-web
    participant A as bff-admin
    participant AG as Agendamento (Read Model)
    participant TR as Triagem
    participant PA as Pacientes
    participant NO as Notificações
    Note over W: GET /web/v1/agendamentos/{id}
    W->>AG: GET /agendamentos/{id}
    opt opcional
      W->>TR: GET /triagens?sagaId
    end
    Note over A: GET /admin/v1/agendamentos/resumo
    par em paralelo
      A->>AG: GET /relatorios/ocupacao?ubsId&periodo
      A->>PA: GET /pacientes/estatisticas?ubsId
      A->>NO: GET /notificacoes/alertas
    end
```

**Resiliência:** ambos usam timeout curto e *degradação graciosa*. Se Triagem cair, `bff-web` omite `triagem`; se Notificações ou Pacientes caírem, `bff-admin` devolve a parte nula e sinaliza `"parcial": true`.

## 3. Rotas

| `bff-web` (`/web/v1`) | `bff-admin` (`/admin/v1`) |
|-----------------------|---------------------------|
| `GET /home` | `GET /unidades` |
| `POST /triagem` | `GET /agendamentos/resumo?ubsId&periodo` |
| `GET /horarios` | `POST /escalas` |
| `GET, POST /agendamentos` | `GET /saude-ia` |
| `GET /agendamentos/{id}` e `/andamento` | |
| `POST /agendamentos/{id}/confirmacao, reagendamento, cancelamento` | |

No `bff-web`, paciente, idade e unidade vêm do cadastro, nunca do corpo da requisição.
