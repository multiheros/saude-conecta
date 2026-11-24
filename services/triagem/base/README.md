# Base de conhecimento da Triagem

| Arquivo | Origem |
|---------|--------|
| `cab28-v1.jsonl` | BRASIL. Ministério da Saúde. **Acolhimento à demanda espontânea.** Cadernos de Atenção Básica, n. 28, v. I. Brasília, 2013. |
| `cab28-v2.jsonl` | BRASIL. Ministério da Saúde. **Acolhimento à demanda espontânea: queixas mais comuns na Atenção Básica.** Cadernos de Atenção Básica, n. 28, v. II. Brasília, 2013. |
| `protocolo-interno.md` | Escrito pelo grupo, sem validação clínica |

Os dois volumes permitem reprodução, total ou parcial, desde que citada a fonte e sem fim comercial. O texto foi
extraído por [`extrair.py`](extrair.py) de PDFs oficiais da Biblioteca Virtual em Saúde (bvsms.saude.gov.br):
`acolhimento_demanda_espontanea_cab28v1.pdf` e `acolhimento_demanda_espontanea_queixas_comuns_cab28v2.pdf`. Um bloco
por seção e página; `pagina` é o número impresso.

Limitações da extração: quadros de várias colunas saem em linha corrida, e fluxogramas, sem as setas.
