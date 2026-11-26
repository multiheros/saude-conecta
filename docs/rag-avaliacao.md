# Avaliação do RAG

Duas rodadas com o mesmo método, perguntas e gabarito: `deepseek-flash` (provedor atual, 25/11/2026) e `gemini-3.5-flash-lite` (primeira rodada, 24/11/2026). Perguntas, respostas e scripts em [`services/triagem/avaliacao`](../services/triagem/avaliacao); os arquivos do DeepSeek terminam em `-deepseek`. Para refazer: `scripts/avaliar_rag.sh` (gasta cota do provedor configurado).

## Método

- **12 perguntas** em linguagem de paciente, diferentes das 32 usadas para escolher o modelo de embeddings e o corte. Os assuntos se repetem (são as queixas do Caderno); o texto, não.
- **Gabarito escrito antes de rodar**, com o nível esperado e a página do Caderno que o sustenta. Não foi alterado depois.
- **3 condições**, com o mesmo prompt e a mesma escala de níveis:

| Condição | O que o modelo recebe |
|----------|-----------------------|
| Sem recuperação | Nenhum trecho |
| Só Caderno | Top-5 do Caderno de Atenção Básica nº 28 |
| Completo | Top-5 do Caderno e do protocolo interno (como em produção) |

- **3 execuções** de cada: 108 respostas. Mede a saída crua do modelo: sem cache, sem as regras de segurança e com prazo folgado.

> **Limitação do gabarito:** foi escrito pelo grupo, com base no Caderno e no protocolo interno, **sem validação de profissional de saúde**. O protocolo também é do grupo; por isso a condição "só Caderno" existe, para separar o ganho da recuperação do ganho de o gabarito e o protocolo terem os mesmos autores.

## Resultado com o DeepSeek (provedor atual)

Mesmas 12 perguntas, 3 condições e 3 execuções (108 respostas), já com as mudanças que a primeira rodada motivou (corte 0,54).

| Medida (36 respostas por condição) | Sem recuperação | Só Caderno | Completo |
|---|---|---|---|
| Nível esperado | 33 | 33 | **36** |
| **Menos urgente que o esperado** (erro perigoso) | 0 | 0 | **0** |
| Mais urgente que o esperado | 3 | 3 | 0 |
| Perguntas com o mesmo nível nas 3 execuções | 12 de 12 | 12 de 12 | 12 de 12 |
| Respostas que citam trecho de apoio | 0 | 36 | **36** |
| Confiança média declarada | 0,52 | 0,75 | 0,87 |
| Tempo do modelo, mediana | 1.629 ms | 1.725 ms | 1.770 ms |

- **A recuperação ainda decide o nível nas perguntas difíceis.** Sem trechos, o modelo exagera em 3 (a 1 vira VERMELHO; a 2 e a 11, LARANJA); só com o Caderno, o mesmo. Com o protocolo interno, as 3 acertam: é ele que traz a escala de cores.
- **Nenhum erro perigoso** em 108 respostas, e a pergunta 5 (agressão por cão), que o Gemini errou sem trecho, saiu certa nas três condições.
- **Toda resposta com trechos cita algum**, e o mesmo nível se repete nas 3 execuções de todas as perguntas.
- **Confirmação** com as 12 perguntas inéditas, no resultado final de produção: **11 de 12**, nenhuma menos urgente. A 12 (preventivo atrasado, sem sintoma) deveria ser AZUL e saiu AMARELO, mais cautelosa. As regras sozinhas fazem 7 de 12, com 1 menos urgente.

O ganho sobre o Gemini (36 contra 30 no completo, 0 contra 6 erros perigosos) mistura duas coisas: o modelo e as mudanças feitas depois da primeira rodada. As duas rodadas usam o mesmo gabarito, então os números são comparáveis, mas não separam essas causas.

## Resultado com o Gemini (primeira rodada, 24/11)

| Medida (36 respostas por condição) | Sem recuperação | Só Caderno | Completo |
|---|---|---|---|
| Nível esperado | 30 | 24 | 30 |
| **Menos urgente que o esperado** (erro perigoso) | 5 | 9 | 6 |
| Mais urgente que o esperado | 1 | 3 | 0 |
| Perguntas com o mesmo nível nas 3 execuções | 8 de 12 | 10 de 12 | **11 de 12** |
| Respostas que citam trecho de apoio | 0 | 30 | **33** |
| Citam o capítulo certo | 0 | 24 | **29** |
| Confiança média declarada | 0,75 | 0,88 | 0,96 |
| Tokens de entrada (média) | 397 | 1.448 | 1.255 |

| # | Queixa (resumo) | Esperado | Sem | Só Caderno | Completo |
|---|---|---|---|---|---|
| 1 | Dormência entre as coxas e incontinência | LARANJA | VERMELHO ×1, LARANJA ×2 | VERMELHO | LARANJA |
| 2 | Ardência com febre e dor no flanco | AMARELO ou LARANJA | LARANJA | LARANJA | AMARELO |
| 3 | Criança com diarreia, prostrada, sem lágrima | LARANJA ou VERMELHO | VERMELHO ×2, LARANJA ×1 | LARANJA | LARANJA |
| 4 | Vertigem breve ao virar na cama | VERDE | VERDE | VERDE | VERDE |
| 5 | Agressão por cão desconhecido | AMARELO | VERDE ×2, AMARELO ×1 | VERDE ×2, AMARELO ×1 | **VERDE** |
| 6 | Café quente no rosto da criança | LARANJA ou VERMELHO | VERMELHO ×2, LARANJA ×1 | **AMARELO** | LARANJA |
| 7 | Peso no peito, queixo, suor gelado | VERMELHO | VERMELHO | VERMELHO | VERMELHO |
| 8 | Cabeça apertada, leve, há meses | VERDE | AZUL | AZUL | AZUL |
| 9 | Cartela de remédio, não acorda | VERMELHO | VERMELHO | VERMELHO | VERMELHO |
| 10 | Coceira noturna, família também | VERDE | VERDE | VERDE ×2, AZUL ×1 | VERDE |
| 11 | Sete meses de gestação, dor na barriga | AMARELO ou LARANJA | LARANJA | LARANJA | AMARELO ×2, LARANJA ×1 |
| 12 | Trocar receita e mostrar exame | AZUL | AZUL | AZUL | AZUL |

**Recuperação:** capítulo certo entre os 5 em 8 de 12 (só Caderno) e em 10 de 12 contando o protocolo; página exata do gabarito em 7 de 12.

## Análise das respostas

**O que a recuperação trouxe**
- **Fonte.** Sem ela, nenhuma resposta tem como apontar de onde veio. Com ela, 33 de 36 citam um trecho, e nenhuma citou número de trecho inexistente.
- **Estabilidade.** A mesma queixa recebe o mesmo nível: 8 → 11 de 12. Sem recuperação, as perguntas 1, 3, 5 e 6 mudam de nível entre execuções.
- **Menos alarme falso e menos invenção.** Na 1, sem recuperação ou só com o Caderno, o modelo falou em "risco imediato de vida" para uma suspeita de compressão de nervos. Na 6, sem recuperação, disse "queimadura extensa", o que o paciente não relatou.
- **O protocolo interno foi necessário.** O Caderno não traz a escala de cores: só com ele, o modelo entende a queixa mas erra o nível. Na 6, o Caderno manda encaminhar queimadura de face (p. 160), mas o trecho recuperado foi o de outra página, e a resposta caiu para AMARELO.

**O que ela não trouxe**
- **Mais acerto de nível.** Empate em 30 de 36. O modelo já conhece os quadros clássicos (7, 9, 12), e a escala estava no prompt nas três condições.
- **A confiança declarada não é prova.** Subiu para 0,96 no completo, inclusive nos erros.

**Erros do sistema completo**
- **Pergunta 5 (grave).** O capítulo certo estava em 1º lugar, com similaridade 0,563, mas o corte era 0,58: o modelo respondeu **sem nenhum trecho** e chutou VERDE. O corte havia sido calibrado em outras 32 queixas e não generalizou.
- **Pergunta 8.** As 9 respostas, nas três condições, deram AZUL. O gabarito diz VERDE; para uma dor leve de meses, AZUL é defensável. Mantivemos o gabarito e contamos como erro.

## O que mudou por causa da avaliação

| Mudança | Motivo |
|---------|--------|
| Corte de 0,58 para 0,54 | Nenhuma das 44 queixas fica sem trecho; de 15 frases fora do assunto, 4 passam |
| Sem trecho de apoio, o nível é no mínimo AMARELO | O modelo sem apoio só opina |
| Novas regras de sinal de alarme, tiradas do protocolo | As regras não reconheciam infarto, intoxicação ou agressão por animal descritos de outro jeito |

Aplicando a regra de dúvida às mesmas respostas, o completo iria a 33 de 36, e os 3 erros restantes são os da pergunta 8. Como essa conta usa as perguntas que motivaram a regra, **não vale como medida**; daí a confirmação.

### Confirmação com 12 perguntas inéditas (Gemini)

Escritas depois das mudanças e rodadas uma vez, com o resultado final de produção (modelo, RAG e regras). [Perguntas](../services/triagem/avaliacao/confirmacao.json) e [respostas](../services/triagem/avaliacao/confirmacao-resultado.json).

| | Nível esperado | Menos urgente que o esperado |
|---|---|---|
| Produção (LLM + RAG + regras) | **12 de 12** | **0** |
| Só as regras (fallback) | 3 de 12 | 5 |

O fallback é bem mais fraco que o modelo. Depois dessa rodada as regras foram reforçadas (febre nunca fica em VERDE sem o modelo, entre outras), mas esse reforço não tem medida independente. Enquanto o provedor estiver fora, a triagem por regras deve ser lida como cautela, não como classificação fina.

## Limitações
- 12 perguntas por rodada: diferenças pequenas não são conclusivas.
- Gabarito, protocolo e perguntas são dos mesmos autores, sem validação clínica.
- A confirmação teve uma execução só.
- Em 69 ocasiões o provedor devolveu 503 durante a coleta; o script repetiu até obter resposta.
