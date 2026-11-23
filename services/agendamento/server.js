const express = require('express');
const net = require('net');
const os = require('os');

const NAME = 'agendamento';
const PORT = process.env.PORT || 8002;
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

const slots = [
  { id: 10, ubs: 'UBS Centro', inicio: '2026-12-01T09:00:00Z', status: 'LIVRE' },
  { id: 11, ubs: 'UBS Centro', inicio: '2026-12-01T09:30:00Z', status: 'RESERVADO' },
];
const agendamentos = [{ id: 100, pacienteId: 1, slotId: 11, status: 'AGENDADO' }];

app.get('/api/v1/slots', (_req, res) => res.json({ data: slots, instance: os.hostname() }));
app.get('/api/v1/agendamentos', (_req, res) => res.json({ data: agendamentos }));
app.get('/api/v1/relatorios/ocupacao', (_req, res) =>
  res.json({ capacidade: slots.length, ocupados: 1, taxa: 0.5 }));

app.listen(PORT, () => console.log(`${NAME} ouvindo na porta ${PORT}`));
