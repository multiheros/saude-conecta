# Demonstração

Cada cena tem um script que **mostra e confere**: se algo não sair como deveria, ele para em vermelho. Entre os passos ele espera Enter (`DIRETO=1` roda sem parar).

## Antes

```bash
scripts/preparar.sh                # com internet, uma vez: baixa e constrói tudo, repetindo se o Docker Hub falhar
docker compose up -d --no-build    # não depende mais do Docker Hub
scripts/demo/aquecer.sh            # ~2 min: queixas do roteiro no cache do LLM e agenda com dados
```

## Cenas

| Cena | Script | Prova |
|------|--------|-------|
| 1. Bancos separados | `scripts/demo/1-bancos.sh` | Uma consulta em cada banco; Pacientes não alcança nenhum banco alheio |
| 2. RAG e tool | `scripts/demo/2-triagem.sh` | Fonte com página; reservado o horário, a recomendação muda |
| 3. SAGA, caminho feliz | `scripts/demo/3-saga.sh` | 4 passos, histórico e a mesma correlação em 5 serviços |
| 4. CQRS | `scripts/demo/4-cqrs.sh` | Linha no PostgreSQL, documento no MongoDB, defasagem medida |
| 5. Falha e compensação | `scripts/demo/5-falha.sh` | Notificações desligado: compensa 3 → 2 → 1 e os bancos voltam ao que eram |
| 6. Dois BFFs | `scripts/demo/6-painel.sh` | Respostas diferentes; painel sem dado pessoal; 403 e 401 |
| 7. Provedor do LLM fora | `scripts/demo/7-llm.sh` | Circuito abre, regras respondem, SAGA conclui, circuito fecha |

As cenas 2, 3 e 5 também podem ser vistas nas telas: `http://localhost:8080` e `http://localhost:8080/painel`.

## Se algo der errado

| Problema | Saída |
|----------|-------|
| Sem internet | Tudo sobe e funciona com as imagens prontas; a triagem responde por regras, com fontes (`scripts/verificar_offline.sh` prova) |
| Provedor do LLM lento ou fora | As queixas aquecidas vêm do cache; as demais, por regras |
| Limite do provedor gratuito (15 chamadas por minuto) | Uma triagem nova usa 3; espere um minuto ou use uma queixa aquecida |
| Limite do gateway (100 por minuto) | `LIMITE_POR_MINUTO=1000 docker compose up -d --no-build gateway` |
| Recomeçar do zero | `docker compose down -v`, subir e aquecer de novo |

## Provas automáticas

```bash
scripts/e2e.sh                 # todas, uma por vez, com resumo (~17 min); não gasta cota do LLM
SEM_BUILD=1 scripts/e2e.sh     # com as imagens já prontas
scripts/e2e.sh saga telas      # só algumas
```
