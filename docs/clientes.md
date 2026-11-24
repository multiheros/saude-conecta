# Clientes

Dois aplicativos React + Vite, servidos pelo mesmo gateway (mesma origem, sem CORS):

| Cliente | Endereço | BFF | Perfil |
|---------|----------|-----|--------|
| App do paciente | `/` | `bff-web` | `paciente` |
| Painel do gestor | `/painel` | `bff-admin` | `gestor` |

O código está em [`clientes/`](../clientes): `paciente`, `gestor` e o que é comum aos dois. É um pacote só e duas imagens (`--build-arg APP=`). Cada imagem é um NGINX sem privilégios com arquivos estáticos.

## App do paciente

| Tela | O que faz |
|------|-----------|
| Início | Próximas consultas; abre mesmo com o Agendamento fora |
| Nova consulta | Queixa → urgência, justificativa, fontes e horários reais; emergência mostra o 192 e não agenda |
| Andamento | Os 4 passos da SAGA, com os desfeitos quando há compensação |
| Detalhe | Confirmar, trocar e cancelar |

## Painel do gestor

Ocupação, agendamentos, absenteísmo, alertas de lotação, série diária, urgência, situação, especialidade, faixa etária, criação de escala e saúde da IA. Atualiza a cada 15 s e avisa quando os dados são parciais. Nenhum dado pessoal chega à tela.

## Decisões

| Decisão | Motivo |
|---------|--------|
| Botões vêm dos `_links` da resposta | Quem sabe o que pode ser feito é o domínio; a tela não repete a regra |
| Token só em `sessionStorage` | Some ao fechar a aba. A assinatura é conferida no gateway |
| `Idempotency-Key` por pedido | Clique duplo ou reenvio não marca duas consultas |
| Consulta espera a versão da última escrita (`versaoMinima`) | O paciente vê a própria ação, mesmo com a leitura eventual do CQRS |
| Rotas no fragmento (`#/nova`) | O gateway só libera caminhos exatos; não há curinga que esconda uma rota inexistente |
| Arquivos estáticos fora do limite de requisições | São públicos, e uma visita pede vários |
| CSP `default-src 'self'` | Nenhum script, fonte ou imagem de fora |

## Prova

```bash
scripts/verificar_telas.sh imagens   # ~4 min: navegador real na stack completa; guarda as telas em ./imagens
scripts/demo/dados.sh                # com a stack no ar: dados fictícios pela API real
```

São 13 testes: fluxo completo, emergência, clique duplo, sessão inválida, painel, escala e, com Notificações desligado, a compensação vista na tela. Cada tela passa por acessibilidade (axe, WCAG 2 A e AA), largura mínima e tema claro e escuro.

## Limitações
- Não há tela de cadastro; o cadastro existe na API (`POST /api/v1/pacientes`).
- O registro de comparecimento é feito pela API, sem tela.
- O token vale 1 hora e não é renovado; ao vencer, a pessoa entra de novo.
