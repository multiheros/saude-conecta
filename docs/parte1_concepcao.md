# SaúdeConecta — Documento de Concepção

## 1. Identificação

| Item | Detalhe |
|------|---------|
| **Startup** | SaúdeConecta |
| **Tagline** | *Conectando comunidades à saúde que precisam* |
| **Disciplina** | GCC129 — Sistemas Distribuídos — 2026/2 |
| **Instituição** | Universidade Federal de Lavras (UFLA) |

### Integrantes

| Nome | Matrícula | GitHub |
|------|-----------|--------|
| Jonathan Nascimento Carvalho | [Matrícula] | [@multiheros](https://github.com/multiheros) |
| Maria Lina da Silva | [Matrícula] | [@Marialinaa](https://github.com/Marialinaa) |
| Matheus Gomes | [Matrícula] | [@MatheusssGM](https://github.com/MatheusssGM) |

---

## 2. Problema e Motivação

### 2.1 Contextualização

O Sistema Único de Saúde (SUS), instituído pela Constituição Federal de 1988 e regulamentado pela Lei nº 8.080/1990, constitui o maior sistema público de saúde do mundo, oferecendo cobertura universal a mais de 210 milhões de brasileiros. Paim et al. (2011), em artigo seminal publicado na revista *The Lancet*, documentam os avanços significativos do SUS ao longo de suas duas primeiras décadas: ampliação do acesso, descentralização da gestão, e consolidação da Estratégia Saúde da Família como modelo de Atenção Primária à Saúde (APS). Entretanto, os mesmos autores destacam que **desigualdades regionais e sociais persistentes** continuam a comprometer a efetividade do sistema, particularmente no acesso à atenção primária para populações vulneráveis.

A APS, operacionalizada pelas Unidades Básicas de Saúde (UBS), é a porta de entrada preferencial do SUS e deveria funcionar como ordenadora do cuidado. Na prática, entretanto, o acesso a essa porta de entrada é atravessado por barreiras organizacionais que impõem custos desproporcionais às populações que mais necessitam do sistema público.

### 2.2 Dimensões do Problema

#### Agendamento predominantemente presencial

O **Censo das Unidades Básicas de Saúde de 2024**, conduzido pela Rede de Pesquisa em Atenção Primária à Saúde (RESBR) em parceria com o Ministério da Saúde, revela que **93,8% das UBS brasileiras ainda realizam agendamento de consultas de forma presencial**. Isso significa que o paciente precisa se deslocar fisicamente até a unidade — frequentemente enfrentando filas de madrugada — apenas para tentar obter um horário de atendimento, sem garantia de sucesso.

Embora 95% das UBS possuam acesso à internet e 97,6% utilizem prontuário eletrônico (Censo UBS 2024; TIC Saúde/CGI.br 2024), a digitalização do agendamento permanece incipiente. A barreira não é apenas tecnológica, mas organizacional e de integração entre sistemas.

#### Tempo de espera excessivo

Dados da Associação Paulista de Medicina (APM, 2024) indicam que o tempo médio de espera para consultas especializadas no SUS é de aproximadamente **57 dias**, com variações regionais que ultrapassam **150 dias** em algumas localidades. Auditorias do Tribunal de Contas da União (TCU) confirmam que, apesar de iniciativas como o programa "Agora Tem Especialistas", a redução consistente das filas permanece um desafio estrutural.

#### Absenteísmo nas consultas

Estudos publicados em periódicos como *Ciência & Saúde Coletiva* e *Revista Brasileira de Medicina de Família e Comunidade* documentam taxas de absenteísmo (não comparecimento) entre **20% e 30%** em consultas agendadas na APS. Cada falta representa um horário desperdiçado que poderia ter atendido outro paciente, agravando as filas. Pesquisas indicam correlação significativa entre o longo tempo de espera e o aumento do absenteísmo, configurando um ciclo vicioso de ineficiência.

#### Desigualdade no acesso

A **Pesquisa Nacional de Saúde (PNS) 2019**, realizada pelo IBGE em parceria com o Ministério da Saúde, fornece evidências robustas de que o acesso e a utilização dos serviços de saúde variam significativamente conforme **renda, escolaridade, sexo e região** do país. Populações de menor renda e de regiões Norte e Nordeste enfrentam as maiores barreiras, incluindo distância geográfica, falta de transporte, e menor disponibilidade de profissionais especializados.

Giovanella et al. (2009), em artigo publicado na *Ciência & Saúde Coletiva*, discutem os limites e possibilidades da Estratégia Saúde da Família como abordagem integral de atenção primária no Brasil, concluindo que, embora o modelo tenha expandido a cobertura, **a qualidade e a resolutividade do acesso permanecem desiguais**.

### 2.3 Síntese do Problema

O problema central é a **ineficiência no acesso à Atenção Primária à Saúde**, manifestada em:

1. Agendamento presencial que impõe barreira adicional de acesso;
2. Filas de espera que comprometem a oportunidade do cuidado;
3. Absenteísmo que desperdiça recursos escassos;
4. Ausência de triagem objetiva na porta de entrada;
5. Falta de dados para gestão e tomada de decisão.

Esses problemas impactam desproporcionalmente as populações mais vulneráveis — justamente as que mais dependem do SUS.

---

## 3. Impacto Social Esperado

### 3.1 Populações Beneficiadas

| Grupo | Forma de benefício |
|-------|-------------------|
| **Pacientes de comunidades de baixa renda** | Eliminação da necessidade de deslocamento para agendamento; priorização baseada em critérios clínicos objetivos; redução do tempo total entre a necessidade de saúde e o atendimento |
| **Mães com filhos pequenos e idosos** | Agendamento digital reduz a dependência de acompanhante para ida ao posto apenas para marcar consulta |
| **Trabalhadores informais** | Eliminação da perda de dia de trabalho para conseguir vaga; lembretes reduzem esquecimento |
| **Profissionais de saúde** | Agenda mais organizada; menor ociosidade por absenteísmo; triagem prévia permite preparação |
| **Gestores municipais de saúde** | Dados em tempo real para dimensionamento de equipe, identificação de gargalos e alocação de recursos |

### 3.2 Métricas de Impacto

| Métrica | Linha de base | Meta | Como medir |
|---------|--------------|------|-----------|
| Tempo médio para agendar consulta | Meia jornada de espera presencial | < 5 minutos (digital) | Log do sistema |
| Taxa de absenteísmo | 20-30% | Redução de 30-50% relativa | Comparação antes/depois |
| Cobertura de agendamento digital | ~6% (Censo UBS 2024) | 100% dos agendamentos pela plataforma | Registros do sistema |
| Adequação da triagem | Subjetiva / não realizada | > 85% de concordância com avaliação médica | Comparação classificação IA vs. médico |
| Tempo de espera para consulta | 57 dias (especializada) | Redução mensurável | Dados do sistema |

### 3.3 Teoria da Mudança

```
Agendamento digital + Triagem com IA + Lembretes automáticos + Dashboard para gestores
        ↓                    ↓                     ↓                      ↓
Eliminação de filas   Priorização        Redução do            Dados para
 para marcar          objetiva por       absenteísmo           decisão
                      urgência
        ↓                    ↓                     ↓                      ↓
                    MELHOR ACESSO À SAÚDE PRIMÁRIA
                              ↓
              REDUÇÃO DAS DESIGUALDADES NO ACESSO AO SUS
```

---

## 4. Esboço da Solução

### 4.1 Visão Geral

O SaúdeConecta é uma **plataforma digital de agendamento inteligente e triagem assistida por Inteligência Artificial** voltada para Unidades Básicas de Saúde do SUS. O sistema é composto por microsserviços independentes que, juntos, oferecem:

- **Agendamento digital** com visualização de disponibilidade em tempo real
- **Triagem automatizada** baseada em protocolos médicos oficiais (Protocolo de Manchester, diretrizes do Ministério da Saúde)
- **Notificações e lembretes** para redução do absenteísmo
- **Painel gerencial** com métricas para tomada de decisão

### 4.2 Dois Tipos de Usuário

#### Paciente (App Web)
- Cadastro simplificado
- Visualização de horários disponíveis por especialidade
- Descrição de sintomas → triagem automatizada por IA
- Agendamento, cancelamento e remarcação
- Recebimento de lembretes e orientações pré-consulta
- Consulta ao histórico de atendimentos

#### Gestor de Saúde (Painel Administrativo)
- Dashboard de ocupação e capacidade em tempo real
- Métricas de demanda por região, especialidade e período
- Gestão de escalas de profissionais
- Relatórios de absenteísmo com análise de padrões
- Alertas de gargalo (demanda > capacidade)

### 4.3 Componentes do Sistema

O sistema será construído como uma **arquitetura de microsserviços**, com quatro serviços de domínio independentes:

1. **Serviço de Pacientes** — cadastro, autenticação, perfil, histórico
2. **Serviço de Agendamento** — slots, reservas, disponibilidade, escalas
3. **Serviço de Triagem IA** — classificação de urgência via LLM com RAG sobre protocolos médicos
4. **Serviço de Notificações** — lembretes, confirmações, alertas por email/SMS

Cada serviço terá seu próprio banco de dados, comunicação assíncrona via mensageria, e será containerizado para implantação em ambiente orquestrado.

> **Nota:** O detalhamento técnico da arquitetura (contratos de API, padrões de comunicação, estratégias de consistência, SAGA, CQRS) será apresentado na Parte 2.

---

## 5. Referências

### Referências Acadêmicas e Institucionais (base)

1. **PAIM, J.; TRAVASSOS, C.; ALMEIDA, C.; BAHIA, L.; MACINKO, J.** (2011). The Brazilian health system: history, advances, and challenges. *The Lancet*, 377(9779), 1778-1797. DOI: [10.1016/S0140-6736(11)60054-8](https://doi.org/10.1016/S0140-6736(11)60054-8)

2. **IBGE — Instituto Brasileiro de Geografia e Estatística** (2020). *Pesquisa Nacional de Saúde 2019: Informações sobre domicílios, acesso e utilização dos serviços de saúde — Volume 1.* Rio de Janeiro: IBGE. Disponível em: [ibge.gov.br](https://www.ibge.gov.br/estatisticas/sociais/saude/9160-pesquisa-nacional-de-saude.html)

3. **RESBR — Rede de Pesquisa em Atenção Primária à Saúde / Ministério da Saúde** (2024). *Censo das Unidades Básicas de Saúde 2024.* Disponível em: [resbr.net.br](https://resbr.net.br)

4. **GIOVANELLA, L.; MENDONÇA, M. H. M.; ALMEIDA, P. F.; ESCOREL, S.; SENNA, M. C. M.; FAUSTO, M. C. R.; DELGADO, M. M.; ANDRADE, C. L. T.; CUNHA, M. S.; MARTINS, M. I. C.; TEIXEIRA, C. P.** (2009). Saúde da família: limites e possibilidades para uma abordagem integral de atenção primária à saúde no Brasil. *Ciência & Saúde Coletiva*, 14(3), 783-794. DOI: [10.1590/S1413-81232009000300014](https://doi.org/10.1590/S1413-81232009000300014)

### Referências Complementares

5. **APM — Associação Paulista de Medicina / CFM** (2024). Dados sobre tempo de espera para consultas especializadas no SUS. *Conselho Federal de Medicina.*

6. **CGI.br — Comitê Gestor da Internet no Brasil** (2024). *TIC Saúde 2024: Pesquisa sobre o uso das tecnologias de informação e comunicação nos estabelecimentos de saúde brasileiros.* São Paulo: CGI.br.

7. **OMS/OPAS — Organização Mundial da Saúde / Organização Pan-Americana da Saúde** (2023). *Relatório sobre cobertura universal de saúde nas Américas.*

---

## 6. Repositório

- **URL:** [https://github.com/multiheros/saude-conecta](https://github.com/multiheros/saude-conecta)
- **Visibilidade:** Público
- **Contribuidores:** 4 integrantes configurados
- **Estrutura:** README.md + `/docs` (a ser expandido na Parte 2)
