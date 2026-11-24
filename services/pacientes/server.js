const fs = require('fs');
const path = require('path');
const { criarPool, migrar, umaVez } = require('../../libs/comum/db');
const { criarPublicador } = require('../../libs/comum/broker');
const { criarConsumidor } = require('../../libs/comum/consumidor');
const outbox = require('../../libs/comum/outbox');
const { criarApp, aoEncerrar } = require('../../libs/comum/http');
const { criarRotas } = require('./src/rotas');
const { tratarEvento } = require('./src/pacientes');
const { semear } = require('./src/seed');

const PORT = process.env.PORT || 8001;

async function main() {
  const chavePrivada = fs.readFileSync(process.env.JWT_CHAVE_PRIVADA, 'utf8');
  const pool = criarPool();
  await migrar(pool, path.join(__dirname, 'migrations'));
  if (process.env.SEED === 'true' && await semear(pool, process.env.SEED_SENHA || 'demo12345')) console.log(JSON.stringify({ nivel: 'info', msg: 'dados de demonstracao criados' }));

  const publicador = criarPublicador();
  publicador.iniciar();
  const pararPoller = outbox.iniciarPoller(pool, publicador);
  const consumidor = criarConsumidor({ fila: 'pacientes.agendamento', tratar: (e) => umaVez(pool, 'pacientes', e.eventId, (c) => tratarEvento(c, e)) });
  consumidor.iniciar();

  const app = criarApp({
    nome: 'pacientes',
    rotas: criarRotas({ pool, chavePrivada }),
    pronto: async () => ({ db: await pool.query('SELECT 1').then(() => 'up', () => 'down'), rabbitmq: publicador.conectado() ? 'up' : 'down' }),
    metricas: async () => ({ outbox: await outbox.metricas(pool) }),
  });
  const server = app.listen(PORT, () => console.log(JSON.stringify({ nivel: 'info', msg: `pacientes ouvindo na porta ${PORT}` })));
  aoEncerrar(server, consumidor.fechar, pararPoller, publicador.fechar, () => pool.end());
}

main().catch((e) => { console.error(e); process.exit(1); });
