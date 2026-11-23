const express = require('express');
const net = require('net');
const os = require('os');

const NAME = 'notificacoes';
const PORT = process.env.PORT || 8004;
const app = express();
app.use(express.json());

function checkDb() {
  return new Promise((resolve) => {
    const host = process.env.DB_HOST;
    const port = Number(process.env.DB_PORT);
    if (!host) return resolve('n/a');
    const s = net.connect({ host, port, timeout: 1500 });
    s.on('connect', () => { s.destroy(); resolve('up'); });
    s.on('error', () => resolve('down'));
    s.on('timeout', () => { s.destroy(); resolve('down'); });
  });
}

// Vivo: o processo responde. Nao depende do banco, para nao ser reiniciado por falha alheia.
app.get('/live', (_req, res) => res.json({ service: NAME, status: 'ok', instance: os.hostname() }));

// Pronto: pode receber trafego (banco acessivel).
app.get('/ready', async (_req, res) => {
  const db = await checkDb();
  res.status(db === 'down' ? 503 : 200).json({
    service: NAME, status: db === 'down' ? 'degraded' : 'ok', db, instance: os.hostname(),
  });
});

app.get('/api/v1/notificacoes', (_req, res) =>
  res.json({ data: [{ id: 1, tipo: 'LEMBRETE', canal: 'SMS', status: 'AGENDADA' }] }));
app.get('/api/v1/notificacoes/alertas', (_req, res) =>
  res.json({ data: [{ ubs: 'UBS Centro', tipo: 'GARGALO', mensagem: 'Demanda acima da capacidade' }] }));

app.listen(PORT, () => console.log(`${NAME} ouvindo na porta ${PORT}`));
