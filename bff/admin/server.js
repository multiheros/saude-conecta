const express = require('express');
const os = require('os');

const PORT = process.env.PORT || 3002;
const PACIENTES = process.env.PACIENTES_URL || 'http://pacientes:8001';
const AGENDAMENTO = process.env.AGENDAMENTO_URL || 'http://agendamento:8002';
const NOTIFICACOES = process.env.NOTIFICACOES_URL || 'http://notificacoes:8004';

const app = express();

app.get('/health', (_req, res) => res.json({ service: 'bff-admin', status: 'ok', instance: os.hostname() }));

// BFF do gestor: dados agregados e analiticos.
// O gateway remove o prefixo /admin/v1 (strip_path), entao a rota aqui e /painel.
app.get('/painel', async (_req, res) => {
  try {
    const [est, ocup, alertas] = await Promise.all([
      fetch(`${PACIENTES}/api/v1/pacientes/estatisticas`).then((r) => r.json()),
      fetch(`${AGENDAMENTO}/api/v1/relatorios/ocupacao`).then((r) => r.json()),
      fetch(`${NOTIFICACOES}/api/v1/notificacoes/alertas`).then((r) => r.json()),
    ]);
    res.json({ cliente: 'admin', pacientes: est, ocupacao: ocup, alertas: alertas.data, atendidoPor: os.hostname() });
  } catch (e) {
    res.status(502).json({ title: 'Servico indisponivel', status: 502 });
  }
});

app.listen(PORT, () => console.log(`bff-admin ouvindo na porta ${PORT}`));
