# Latência e custo do LLM

Medido em 25/11/2026 com `deepseek-flash` (provedor atual, sem raciocínio), com a configuração de produção (3,5 s por tentativa, 2 tentativas, circuit breaker). Para refazer: `scripts/avaliar_rag.sh latencia`. Dados em [`latencia-deepseek.json`](../services/triagem/avaliacao/latencia-deepseek.json); a medida anterior, com `gemini-3.5-flash-lite` na camada gratuita (24/11), está em [`latencia.json`](../services/triagem/avaliacao/latencia.json) e na comparação abaixo.

## Latência

**Classificação** (`POST /triagens`), 30 queixas diferentes, uma por vez:

| Etapa | p50 | p95 |
|-------|-----|-----|
| Embedding da queixa (local, CPU) | 8 ms | 11 ms |
| Busca no ChromaDB | 4 ms | 4 ms |
| Modelo | 1.618 ms | 1.789 ms |
| **Total** | **1.633 ms** | **1.805 ms** |

| Caminho | p50 | p95 |
|---------|-----|-----|
| Cache (MongoDB) | 0,4 ms | 0,5 ms |
| Fallback com o circuito aberto | 15 ms | 17 ms |
| **Recomendação completa** (classificação, tool e escolha: 3 chamadas), 8 medidas | 4.561 ms | 4.788 ms |

- **O tempo é quase todo do modelo:** embedding e busca somam 12 ms, menos de 1% da mediana.
- **O máximo (1,8 s) ficou bem abaixo do teto de 8 s**, que existe porque a SAGA espera 10 s pela triagem. A recomendação, fora da SAGA, tem teto de 12 s.
- A recomendação usa uma agenda fixa na medida, para isolar o modelo.

## Confiabilidade do provedor

| Medida | DeepSeek (25/11) | Gemini gratuito (24/11) |
|--------|------------------|-------------------------|
| Chamadas ao provedor, nas 30 classificações | 30 | 45 |
| Falhas | **0** | 19 (12 por tempo esgotado, 7 por HTTP 503) |
| Classificações respondidas pelo modelo | **30 de 30** | 26 de 30 |
| Recomendações completas pelo modelo | 8 de 8 (24 chamadas, 0 falhas) | 6 de 8 (27 chamadas, 6 falhas) |
| Classificações sem resposta | 0 | 0 |

Na avaliação do RAG (108 respostas, prazo folgado), o DeepSeek também não falhou nenhuma vez; o Gemini devolveu 503 em 69 ocasiões.

## Custo

Tokens medidos por chamada e preço do [DeepSeek](https://api-docs.deepseek.com/quick_start/pricing/) lido em 25/11/2026, no **horário de pico** e sem cache: US$ 0,30 por milhão de tokens de entrada e US$ 1,20 de saída. Fora do pico é metade.

| Operação | Chamadas | Entrada | Saída | Custo |
|----------|----------|---------|-------|-------|
| Classificação | 1 | 2.007 | 175 | **US$ 0,00081** |
| Recomendação completa | 3 | 3.454 | 418 | **US$ 0,0015** |
| Resposta do cache ou das regras | 0 | 0 | 0 | 0 |

**Em escala**, supondo que cada agendamento faça uma recomendação e depois a SAGA:

| Agendamentos por mês | Com cache (a SAGA reaproveita a classificação) | Sem cache |
|----------------------|------------------------------------------------|-----------|
| 1 mil | US$ 1,54 | US$ 2,35 |
| 10 mil | US$ 15,4 | US$ 23,5 |
| 100 mil | US$ 154 | US$ 235 |

- **É um teto.** O DeepSeek cobra 50 vezes menos pela parte da entrada que repete entre pedidos (o prompt com a escala), e fora do pico tudo custa metade. Não medimos quanto do prompt entra nesse desconto.
- A entrada é maior que no Gemini (2.007 contra 1.418 tokens) porque a saída estruturada vai como definição de função.
- O **RAG** é a maior parte da entrada: os 5 trechos, de até 250 tokens cada.
- Embeddings locais: custo zero por chamada.

## Comparação com o Gemini

| | DeepSeek Flash (25/11) | Gemini Flash-Lite gratuito (24/11) |
|---|---|---|
| Classificação, p50 / p95 | **1,6 s / 1,8 s** | 2,3 s / 7,1 s |
| Recomendação completa, p50 / p95 | 4,6 s / 4,8 s | 3,6 s / 6,7 s |
| Falhas do provedor nas 30 classificações | **0** | 19 |
| Custo por recomendação (preço pago) | US$ 0,0015 | US$ 0,0014 |
| Limite | Concorrência (2.500 pedidos simultâneos) | 15 chamadas por minuto |

A recomendação do DeepSeek é mais lenta na mediana e mais estável no p95. Antes de escolher, medimos também os níveis de raciocínio do DeepSeek (low, high e max) com 24 perguntas com gabarito: foram 2 a 3 vezes mais lentos (p50 de 2,9 a 3,2 s) e acertaram uma a menos que o modo sem raciocínio (23 contra 24).

## Limitações da medida
- Uma máquina, uma noite, 30 + 8 operações: serve para ordem de grandeza. As medidas dos dois provedores foram feitas em dias diferentes.
- O DeepSeek não foi medido no horário de pico dele (22h à 1h e 3h às 7h, no horário de Brasília, em dias úteis).
- Os servidores do DeepSeek ficam na China; com dado real de paciente seria preciso tratar a transferência internacional (LGPD). Aqui, só dados fictícios.
