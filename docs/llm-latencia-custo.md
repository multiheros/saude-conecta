# Latência e custo do LLM

Medido em 24/11/2026 com `gemini-3.5-flash-lite` na **camada gratuita**, com a configuração de produção (3,5 s por tentativa, 2 tentativas, circuit breaker). Para refazer: `scripts/avaliar_rag.sh latencia`. Dados em [`latencia.json`](../services/triagem/avaliacao/latencia.json).

## Latência

**Classificação** (`POST /triagens`), 30 queixas diferentes, uma por vez:

| Etapa | p50 | p95 |
|-------|-----|-----|
| Embedding da queixa (local, CPU) | 8 ms | 11 ms |
| Busca no ChromaDB | 5 ms | 5 ms |
| Modelo, com as novas tentativas | 2.268 ms | 7.129 ms |
| **Total** | **2.283 ms** | **7.148 ms** |
| Uma chamada ao modelo que deu certo | 1.173 ms | 3.466 ms |

| Caminho | p50 | p95 |
|---------|-----|-----|
| Cache (MongoDB) | 0,4 ms | 0,5 ms |
| Fallback com o circuito aberto | 15 ms | 18 ms |
| **Recomendação completa** (classificação, tool e escolha: 3 chamadas), 8 medidas | 3.567 ms | 6.665 ms |

- **O tempo é quase todo do modelo:** embedding e busca somam 13 ms, 0,6% da mediana.
- **O máximo (7,2 s) ficou abaixo do teto de 8 s**, que existe porque a SAGA espera 10 s pela triagem.
- A recomendação usa uma agenda fixa na medida, para isolar o modelo.

## Confiabilidade do provedor

| Medida, nas 30 classificações | Valor |
|-------------------------------|-------|
| Chamadas ao provedor | 45 |
| Falhas | 19 (12 por tempo esgotado, 7 por HTTP 503) |
| **Classificações respondidas pelo modelo** | **26 de 30** |
| Respondidas por regras (fallback) | 4 |
| Classificações sem resposta | **0** |

Das chamadas, 42% falharam (19 de 45). A segunda tentativa salvou a maior parte, e o fallback cobriu o resto. Fora do sistema, sem prazo, vimos respostas de até 16 s.

## Custo

Tokens medidos por chamada e preço da camada paga do [Gemini](https://ai.google.dev/gemini-api/docs/pricing), lido em 24/11/2026: US$ 0,30 por milhão de tokens de entrada e US$ 2,50 de saída. A camada gratuita custa zero.

| Operação | Chamadas | Entrada | Saída | Custo |
|----------|----------|---------|-------|-------|
| Classificação | 1 | 1.418 | 87 | **US$ 0,00064** |
| Recomendação completa | 3 | 2.477 | 272 | **US$ 0,0014** |
| Resposta do cache ou das regras | 0 | 0 | 0 | 0 |

A recomendação usa a média medida por chamada (826 de entrada e 91 de saída) vezes 3.

**Em escala**, supondo que cada agendamento faça uma recomendação e depois a SAGA:

| Agendamentos por mês | Com cache (a SAGA reaproveita a classificação) | Sem cache |
|----------------------|------------------------------------------------|-----------|
| 1 mil | US$ 1,42 | US$ 2,06 |
| 10 mil | US$ 14,2 | US$ 20,6 |
| 100 mil | US$ 142 | US$ 206 |

- O **RAG** aumenta a entrada de 397 para 1.255 tokens, em média: cerca de US$ 0,00026 por classificação.
- Trechos de 250 tokens, em vez de 800, mantêm essa conta baixa.
- Embeddings locais: custo zero por chamada.

## Limites da camada gratuita
- **15 chamadas por minuto** por projeto, informado pelo próprio provedor no erro 429. Uma recomendação nova usa 3: cabem 5 por minuto.
- O conteúdo enviado pode ser usado para melhorar os produtos do provedor: **só dados fictícios**.
- Em produção seria preciso a camada paga, pelo limite, pela instabilidade e pela LGPD.

## Limitações da medida
- Uma máquina, uma tarde, 30 + 8 operações: serve para ordem de grandeza.
- Tokens de chamadas que estouraram o prazo não são contados, e o provedor pode cobrá-los.
- A latência da camada paga não foi medida.
