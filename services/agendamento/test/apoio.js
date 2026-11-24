// Read Model real (MongoDB e Redis descartaveis) e um broker simulado: entrega os eventos do
// Outbox ao projetor. O broker de verdade e exercitado por scripts/verificar_cqrs.sh.
const { criarLeitura } = require('../src/leitura');
const { criarProjetor } = require('../src/projetor');
const { criarConsultas } = require('../src/consultas');

const envelope = (e) => ({
  eventId: e.id, eventType: e.event_type, occurredAt: e.created_at.toISOString(), correlationId: e.headers.correlationId,
  aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, aggregateVersion: e.aggregate_version, payload: e.payload,
});
async function eventosDe(pool, depoisDe = 0) {
  const { rows } = await pool.query('SELECT * FROM outbox_events WHERE seq > $1 ORDER BY seq', [depoisDe]);
  return rows.map((e) => Object.assign(envelope(e), { seq: Number(e.seq) }));
}

// PACIENTES_URL aponta para uma porta fechada: por padrao, o servico de Pacientes esta fora.
async function criarAmbiente({ ttlMs, esperaMs, env = { PACIENTES_URL: 'http://127.0.0.1:1', ...process.env } } = {}) {
  const leitura = criarLeitura({ ttlMs, env });
  if (leitura.cache.redis.status !== 'ready') await new Promise((ok) => { leitura.cache.redis.once('ready', ok); });
  await leitura.conectar();
  await leitura.prepararIndices();
  const projetor = criarProjetor({ leitura, env });
  let ultimo = 0;
  return {
    leitura, projetor, consultas: criarConsultas({ leitura, esperaMs }),
    async limpar() {
      for (const c of [leitura.agendamentos, leitura.ocupacao, leitura.pacientes, leitura.controle]) await c.deleteMany({});
      await leitura.cache.redis.flushdb();
      ultimo = 0;
    },
    async projetar(pool) { for (const e of await eventosDe(pool, ultimo)) { await projetor.tratar(e); ultimo = e.seq; } },
    fechar: () => leitura.fechar(),
  };
}

module.exports = { criarAmbiente, eventosDe };
