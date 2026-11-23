const express = require('express');
const net = require('net');
const os = require('os');

const NAME = 'pacientes';
const PORT = process.env.PORT || 8001;
const app = express();
app.use(express.json());

// Verifica se o banco proprio do servico esta acessivel (TCP).
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

const pacientes = [
  { id: 1, nome: 'Ana Souza', ubs: 'UBS Centro' },
  { id: 2, nome: 'Carlos Lima', ubs: 'UBS Norte' },
];

app.get('/api/v1/pacientes', (_req, res) => res.json({ data: pacientes, instance: os.hostname() }));

app.get('/api/v1/pacientes/estatisticas', (_req, res) =>
  res.json({ total: pacientes.length, porUbs: { 'UBS Centro': 1, 'UBS Norte': 1 } }));

// Recurso com HATEOAS
app.get('/api/v1/pacientes/:id', (req, res) => {
  const p = pacientes.find((x) => x.id === Number(req.params.id));
  if (!p) return res.status(404).json({ title: 'Paciente nao encontrado', status: 404 });
  const base = `/api/v1/pacientes/${p.id}`;
  res.json({
    ...p,
    _links: {
      self: { href: base },
      historico: { href: `${base}/historico` },
      agendamentos: { href: `/api/v1/agendamentos?pacienteId=${p.id}` },
    },
  });
});

app.listen(PORT, () => console.log(`${NAME} ouvindo na porta ${PORT}`));
