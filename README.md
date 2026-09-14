# SaúdeConecta 🏥

> *Conectando comunidades à saúde que precisam*

## 🎯 O Problema

O Sistema Único de Saúde (SUS) é o maior sistema de saúde pública do mundo, atendendo **mais de 150 milhões de brasileiros** que dependem exclusivamente da rede pública. Apesar dos avanços reconhecidos internacionalmente, a **Atenção Primária à Saúde (APS)** — porta de entrada do SUS — enfrenta problemas crônicos que comprometem o acesso efetivo da população:

- **Filas e tempo de espera excessivos:** O tempo médio de espera para consulta especializada no SUS é de aproximadamente **57 dias**, com disparidades regionais que ultrapassam **150 dias** em algumas áreas (APM, 2024).
- **Absenteísmo elevado:** Entre **20% e 30%** dos pacientes faltam às consultas agendadas em Unidades Básicas de Saúde, desperdiçando recursos escassos e aumentando filas para outros pacientes.
- **Agendamento predominantemente presencial:** O Censo das UBS 2024 revelou que **93,8% das unidades** ainda realizam agendamentos de forma presencial, exigindo que o paciente se desloque até a unidade apenas para marcar uma consulta.
- **Triagem ineficiente:** A classificação de risco é frequentemente feita de forma subjetiva ou não é realizada, levando pacientes urgentes a esperarem junto com casos eletivos.
- **Desigualdade regional:** A cobertura da Estratégia Saúde da Família apresenta enormes disparidades regionais, com comunidades periféricas e rurais enfrentando as maiores barreiras de acesso.

## 💡 A Solução

O **SaúdeConecta** é uma plataforma de **agendamento inteligente e triagem assistida por IA** para Unidades Básicas de Saúde (UBS). O sistema permite que pacientes agendem consultas digitalmente, recebam uma pré-triagem automatizada com base em protocolos médicos oficiais, e sejam notificados sobre suas consultas — reduzindo filas, absenteísmo e melhorando a alocação de recursos de saúde.

**Para pacientes:** agendamento digital com visualização de disponibilidade, triagem inteligente por IA, lembretes automáticos e orientação pré-consulta.

**Para gestores de saúde:** dashboard de ocupação em tempo real, métricas de demanda por região e especialidade, gestão de escalas e relatórios de desempenho.

## 🌍 Impacto Social

### Quem é beneficiado
- **Pacientes de comunidades vulneráveis** — acesso a agendamento sem filas presenciais; triagem que prioriza quem mais precisa
- **Profissionais de saúde** — melhor organização da agenda; menos "furos" por absenteísmo
- **Gestores municipais de saúde** — dados para tomada de decisão e alocação eficiente de recursos
- **O SUS como sistema** — redução do desperdício; melhor cobertura efetiva

### Como medir o impacto
| Métrica | Forma de medição |
|---------|-----------------|
| Redução do tempo de espera | Comparação do tempo médio antes/depois da implantação |
| Redução do absenteísmo | Taxa de faltas antes/depois do sistema de lembretes |
| Eficiência da triagem | % de classificações corretas vs. avaliação médica posterior |
| Cobertura de agendamento digital | % de consultas agendadas pelo sistema vs. presencial |
| Satisfação do usuário | NPS (Net Promoter Score) dos pacientes |

## 👥 Integrantes

| Nome | GitHub |
|------|--------|
| Jonathan Nascimento Carvalho | [@multiheros](https://github.com/multiheros) |
| Maria Lina da Silva | [@Marialinaa](https://github.com/Marialinaa) |
| Matheus Gomes | [@MatheusssGM](https://github.com/MatheusssGM) |

## 📚 Referências

1. **PAIM, J. et al.** (2011). "The Brazilian health system: history, advances, and challenges." *The Lancet*, 377(9779), 1778-1797. DOI: [10.1016/S0140-6736(11)60054-8](https://doi.org/10.1016/S0140-6736(11)60054-8)

2. **IBGE** (2020). *Pesquisa Nacional de Saúde 2019: Informações sobre domicílios, acesso e utilização dos serviços de saúde.* Rio de Janeiro: IBGE. Disponível em: [ibge.gov.br/estatisticas/sociais/saude/9160-pesquisa-nacional-de-saude.html](https://www.ibge.gov.br/estatisticas/sociais/saude/9160-pesquisa-nacional-de-saude.html)

3. **Ministério da Saúde / RESBR** (2024). *Censo das Unidades Básicas de Saúde 2024.* Rede de Pesquisa em APS. Disponível em: [resbr.net.br](https://resbr.net.br)

4. **Giovanella, L. et al.** (2009). "Saúde da família: limites e possibilidades para uma abordagem integral de atenção primária à saúde no Brasil." *Ciência & Saúde Coletiva*, 14(3), 783-794. DOI: [10.1590/S1413-81232009000300014](https://doi.org/10.1590/S1413-81232009000300014)

5. **CFM / APM** (2024). Dados sobre tempo de espera para consultas especializadas no SUS. *Conselho Federal de Medicina / Associação Paulista de Medicina.* *(complementar)*

6. **OMS/OPAS** (2023). Relatórios sobre cobertura de saúde nas Américas. *(complementar)*

## 🏗️ Arquitetura (visão geral)

O sistema é composto por **4 microsserviços independentes**, cada um com seu próprio banco de dados:

| Serviço | Função | Banco de Dados |
|---------|--------|----------------|
| **Pacientes** | Cadastro, autenticação, histórico | PostgreSQL |
| **Agendamento** | Slots, reservas, disponibilidade | PostgreSQL |
| **Triagem IA** | Classificação de urgência via LLM + RAG | MongoDB + ChromaDB |
| **Notificações** | Lembretes, confirmações, alertas | Redis |

**Clientes:** App Web (pacientes) + Painel Administrativo (gestores de saúde)

> Detalhes completos da arquitetura serão apresentados na Parte 2.

## 🏗️ Status do Projeto

| Etapa | Status | Data |
|-------|--------|------|
| **Parte 1** — Concepção e Pitch | 🟢 Concluído | 17/09/2026 |
| Parte 2 — Arquitetura | ⬜ Pendente | 22-27/10/2026 |
| Parte 3 — Containerização | ⬜ Pendente | 17/11/2026 |
| Parte 4 — Sistema Funcional | ⬜ Pendente | 10-15/12/2026 |

## 🚀 Como Executar

> Em desenvolvimento — instruções completas serão adicionadas na Parte 3.

---

*GCC129 — Sistemas Distribuídos — UFLA — 2026/2*
