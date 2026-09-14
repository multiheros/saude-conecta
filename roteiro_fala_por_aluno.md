# Roteiro de Apresentação — Grupo de 3 Alunos — SaúdeConecta 🏥

> **Disciplina:** GCC129 — Sistemas Distribuídos — 2026/2  
> **Etapa:** Parte 1 — Concepção e Pitch  
> **Tempo total:** **5 minutos cravados (300 segundos)**  
> **Configuração:** **3 integrantes** (~1 min e 40 seg por integrante)  
> **Regra de Ouro:** Todos os 3 integrantes **devem falar** com conteúdo substantivo.  
> **Após os 5 min:** Arguição individual com perguntas do professor dirigidas a cada um.

---

## ⏱️ Linha do Tempo e Divisão do Pitch (3 Integrantes)

```
0:00                          1:40                          3:20                     5:00
┌─────────────────────────────┬─────────────────────────────┬────────────────────────┐
│           ALUNO 1           │           ALUNO 2           │        ALUNO 3         │
│   Abertura, Dor & Números   │  Evidências & Impacto Social │  Arquitetura & Fecho   │
│       (Slides 1, 2 e 3)     │      (Slides 4, 5 e 6)      │     (Slides 7 e 8)     │
│       ~1 min e 40 seg       │       ~1 min e 40 seg       │     ~1 min e 40 seg    │
└─────────────────────────────┴─────────────────────────────┴────────────────────────┘
```

---

## 👤 ALUNO 1: Abertura, O Problema Real & Gargalos em Números
* **Tempo de fala:** `0:00 a 1:40` (100 segundos)
* **Slides correspondentes:** Slide 1 (Capa), Slide 2 (O Problema Real) e Slide 3 (Gargalos em Números)
* **Postura:** Firme, enérgica, contextualizando o problema e apresentando os números alarmantes de entrada.

---

### 🎙️ Fala Completa do Aluno 1:

#### [Slide 1: Capa — SaúdeConecta] *(0:00 - 0:25)*
*(Olhar para a banca e a turma, iniciar com voz clara e confiante)*

> "Boa tarde professor, boa tarde a todos!  
> Nós somos a **SaúdeConecta** — uma proposta de startup de sistema distribuído que nasceu para responder a um dos maiores dilemas da saúde pública brasileira:  
> **Por que, em pleno 2026, milhões de cidadãos ainda precisam acordar de madrugada e enfrentar filas na chuva apenas para tentar marcar uma consulta médica básica?**  
> Eu sou o Jonathan, e junto com meus colegas Maria Lina e Matheus Gomes, viemos apresentar nossa concepção e proposta de solução."

*(Gatilho: Passar para o Slide 2)*

#### [Slide 2: A Barreira na Porta de Entrada] *(0:25 - 1:05)*
> "O Sistema Único de Saúde é uma conquista pública extraordinária: atende mais de 150 milhões de brasileiros que dependem exclusivamente dele.  
> No entanto, a porta de entrada desse sistema — as Unidades Básicas de Saúde — ainda opera sob um modelo analógico, caótico e excludente.  
> Segundo o **Censo Nacional das UBS de 2024**, publicado pela Rede de Pesquisa em Atenção Primária em parceria com o Ministério da Saúde, pasmem: **93,8% das unidades de saúde do Brasil ainda realizam o agendamento de consultas de forma estritamente presencial**.  
> Isso significa que o cidadão precisa perder uma manhã de trabalho e gastar com condução só para ouvir no balcão se há ou não vaga disponível."

*(Gatilho: Passar para o Slide 3)*

#### [Slide 3: Os Gargalos em Números] *(1:05 - 1:35)*
> "E esse modelo analógico gera dois gargalos operacionais devastadores:  
> Primeiro, o **tempo de espera**: dados da Associação Paulista de Medicina e do CFM mostram que a espera média por consultas especializadas é de **57 dias**, chegando a superar **150 dias** em áreas periféricas.  
> Segundo, o paradoxo do **absenteísmo**: estudos na revista *Ciência & Saúde Coletiva* comprovam que entre **20% e 30% dos pacientes faltam** às consultas agendadas.  
> Por quê? Porque esperam tanto que o quadro piora e eles vão para a UPA, ou melhoram, ou simplesmente não recebem nenhum lembrete. Cada falta é uma vaga desperdiçada que custou a chance de atendimento de outro cidadão."

#### [Transição de Bastão] *(1:35 - 1:40)*
> "Para mostrar as evidências científicas que sustentam esse diagnóstico e quem são as pessoas beneficiadas, passo a palavra à Maria Lina."

---

### 🛡️ Perguntas de Arguição prováveis para o Aluno 1:
* **P: Por que o domínio de agendamento de saúde pública sustenta um projeto de sistemas distribuídos?**  
  * *Resposta recomendada:* "Professor, porque agendamento em saúde não é um CRUD simples. Ele envolve reserva concorrente de vagas com controle transacional estrito, validação cadastral de pacientes, triagem clínica prévia e mensageria de confirmação. Na Parte 2, isso compõe naturalmente uma SAGA com compensações e separação de escrita e leitura via CQRS."
* **P: Essa taxa de 93,8% presencial é recente mesmo? Não existe o Meu SUS Digital?**  
  * *Resposta recomendada:* "Sim, o dado é do Censo das UBS de 2024 conduzido pelo Ministério da Saúde e RESBR. O Meu SUS Digital existe a nível federal, mas na prática municipal quase nenhuma UBS tem o módulo de agendamento ativado e integrado aos fluxos locais; na ponta, a dependência da fila de balcão ainda é quase total."

---

## 👤 ALUNO 2: Fundamentação Acadêmica, Impacto Social & Métricas
* **Tempo de fala:** `1:40 a 3:20` (100 segundos)
* **Slides correspondentes:** Slide 4 (Rigor Científico), Slide 5 (Impacto Social) e Slide 6 (Métricas de Sucesso)
* **Postura:** Analítica e propositiva, ligando a teoria científica às vidas transformadas e às métricas auditáveis.

---

### 🎙️ Fala Completa do Aluno 2:

#### [Slide 4: Fundamentação Acadêmica e Evidências] *(1:40 - 2:15)*
> "Obrigado, Jonathan.  
> Nossa proposta não é baseada em achismos; ela está alicerçada em quatro referências acadêmicas de peso:  
> 1. O estudo seminal de **Paim e colaboradores (2011)** na prestigiada revista *The Lancet*, que já alertava para a persistência de severas disparidades regionais e desigualdades de acesso na atenção primária do SUS;  
> 2. A **Pesquisa Nacional de Saúde do IBGE (PNS 2019)**, demonstrando que o acesso a serviços varia diretamente por renda, escolaridade e região;  
> 3. O já mencionado **Censo UBS 2024**, atestando o vácuo de digitalização no agendamento;  
> 4. E o artigo de **Giovanella et al. (2009)** na *Ciência & Saúde Coletiva*, mapeando os desafios da Saúde da Família.  
> Todas essas fontes convergem: o gargalo não é só a quantidade de médicos, mas a ineficiência na triagem e na gestão das filas."

*(Gatilho: Passar para o Slide 5)*

#### [Slide 5: Quem é Beneficiado e de Que Forma?] *(2:15 - 2:50)*
> "E quem ganha quando atacamos esse problema? Quatro atores principais:  
> As **famílias de baixa renda e trabalhadores informais**, que deixam de perder diárias de trabalho apenas para tentar pegar ficha no posto;  
> **Idosos e mães com crianças de colo**, que não precisarão mais madrugar no sereno para agendar uma consulta básica;  
> Os **profissionais de saúde**, que passam a ter agendas previsíveis, com prontuários preliminares estruturados e muito menos 'furos' por faltas;  
> E os **gestores públicos de saúde**, que deixam de gerenciar a demanda no escuro e passam a ter visibilidade em tempo real de gargalos territoriais."

*(Gatilho: Passar para o Slide 6)*

#### [Slide 6: Métricas de Sucesso Mensuráveis] *(2:50 - 3:15)*
> "Para comprovar esse impacto de maneira auditável, estabelecemos quatro metas claras:  
> • Redução do **tempo de agendamento** de horas presenciais para **menos de 3 minutos** no app;  
> • Redução de **30% a 50% no absenteísmo**, através de lembretes automáticos com opção de liberar a vaga caso haja imprevisto;  
> • Acurácia de pré-triagem superior a **85% de concordância** com a avaliação médica presencial;  
> • E adoção digital progressiva, com meta de absorver mais de **70% das marcações** da unidade em 6 meses."

#### [Transição de Bastão] *(3:15 - 3:20)*
> "Agora, o Matheus Gomes vai apresentar como transformamos esses requisitos na arquitetura distribuída do SaúdeConecta e nossa governança de código."

---

### 🛡️ Perguntas de Arguição prováveis para o Aluno 2:
* **P: Como vocês pretendem avaliar a acurácia da triagem sem colocar vidas em risco?**  
  * *Resposta recomendada:* "A triagem não é prescritiva nem diagnóstica; ela é uma pré-classificação de urgência baseada no Protocolo de Manchester (cores de gravidade) e diretrizes do Ministério da Saúde. Ela apenas direciona para a fila correta (consulta de urgência no dia vs consulta eletiva de rotina). A acurácia é medida comparando a classificação preliminar com a validação do profissional de saúde na triagem presencial."
* **P: Por que o absenteísmo cai com lembretes se o problema for falta de transporte?**  
  * *Resposta recomendada:* "A literatura mostra que esquecimento e melhora espontânea do sintoma respondem por quase metade das faltas. Ao enviar notificação 48h e 24h antes com confirmação em um toque, quem não puder ir cancela, e a vaga volta imediatamente para a fila pública para quem precisa."

---

## 👤 ALUNO 3: Matheus Gomes — A Solução Técnica Distribuída, Governança Git & Fechamento
* **Tempo de fala:** `3:20 a 5:00` (100 segundos)
* **Slides correspondentes:** Slide 7 (Arquitetura Distribuída & Microsserviços) e Slide 8 (Repositório & Pitch Final)
* **Postura:** Técnica, confiante, demonstrando domínio dos conceitos de sistemas distribuídos e finalizando o pitch com chave de ouro.

---

### 🎙️ Fala Completa do Aluno 3:

#### [Slide 7: Arquitetura Distribuída & Microsserviços] *(3:20 - 4:15)*
> "Obrigado, Maria Lina.  
> Para sustentar essa solução com resiliência e desacoplamento, projetamos o SaúdeConecta como uma **arquitetura de microsserviços distribuída completa**.  
> O sistema atende **dois clientes distintos através de BFFs independentes**:  
> O **Paciente**, com uma interface Web leve e intuitiva focada em triagem e slots de atendimento;  
> E o **Gestor de Saúde**, com um painel analítico de escalas, ocupação e demanda territorial.  
> O núcleo de negócio é dividido em **quatro microsserviços com bancos independentes (Database per Service)**:  
> 1. **Serviço de Pacientes** (FastAPI / PostgreSQL) — autenticação e prontuário básico;  
> 2. **Serviço de Agendamento** (NestJS / PostgreSQL) — controle transacional de vagas e separação de escrita e leitura com CQRS;  
> 3. **Serviço de Triagem com IA** (FastAPI / MongoDB + ChromaDB) — pipeline RAG sobre protocolos oficiais do SUS para classificação inteligente;  
> 4. E **Serviço de Notificações** (Node.js / Redis) — filas em memória e mensageria assíncrona.  
> Essa topologia atende perfeitamente ao fluxo de **SAGA orquestrada com compensações** que implementaremos na Parte 2."

*(Gatilho: Passar para o Slide 8)*

#### [Slide 8: Repositório Oficial & Pronto para a Parte 2] *(4:15 - 5:00)*
> "Finalizando com as exigências de governança da disciplina:  
> Nosso repositório já está público no GitHub em `github.com/multiheros/saude-conecta`.  
> Todos os integrantes já estão cadastrados com seus commits e perfis devidamente configurados;  
> A branch `main` já possui proteção ativada exigindo Pull Requests com aprovação de Code Review;  
> E toda a documentação formal de concepção e referências bibliográficas já se encontra versionada.  
> Em conclusão: o **SaúdeConecta** une rigor de sistemas distribuídos a uma transformação social urgente: garantir que o acesso à saúde comece antes da porta do posto.  
> Muito obrigado, encerramos nosso pitch e estamos abertos à arguição!"

---

### 🛡️ Perguntas de Arguição prováveis para o Aluno 3:
* **P: Por que vocês escolheram arquitetura poliglota de bancos (PostgreSQL, MongoDB e Redis)?**  
  * *Resposta recomendada:* "Professor, cada serviço tem necessidades de dados distintas: Agendamento exige garantia relacional ACID para não haver duplo agendamento no mesmo slot (Postgres); a Triagem lida com histórico clínico semiestruturado em JSON e embeddings vetoriais de busca semântica (MongoDB e ChromaDB); e Notificações requer armazenamento em memória de alta performance com expiração por TTL (Redis). Isso respeita o princípio de Database per Service."
* **P: Como vai funcionar a SAGA nesse fluxo?**  
  * *Resposta recomendada:* "A transação de agendar consulta atravessa três serviços: a Triagem classifica, o serviço de Pacientes valida a elegibilidade, o Agendamento efetua a reserva temporária do slot e as Notificações disparam a confirmação. Se a notificação falhar ou o slot for cancelado, o orquestrador aciona a compensação liberando o slot e revertendo o status."

---

## ⚡ Dicas Práticas para os 3 Integrantes

1. **Minutagem:** 100 segundos é cerca de 1 minuto e 40 segundos — tempo confortável para falar com calma, dicção clara e sem correria.
2. **Cronômetro:** O Aluno 1 ou alguém na primeira fila pode manter o celular na mesa com o cronômetro visível para os três.
3. **Passagem de Bastão:** Sempre finalize sua fala passando a palavra para o colega seguinte pelo nome.
4. **Arguição Individual:** Lembre-se de que o professor pergunta nominalmente para qualquer um dos três sobre qualquer assunto. Todos os três devem ter lido este roteiro completo!
