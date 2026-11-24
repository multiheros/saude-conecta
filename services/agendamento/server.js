const path = require('path');
const { criarPool, migrar } = require('../../libs/comum/db');
const { criarPublicador } = require('../../libs/comum/broker');
const outbox = require('../../libs/comum/outbox');
const { criarApp, aoEncerrar } = require('../../libs/comum/http');
const { criarRotas } = require('./src/rotas');
const { criarOrquestrador } = require('./src/saga');
const { semear } = require('./src/seed');

const PORT = process.env.PORT || 8002;

async function main() {
  const pool = criarPool();
  await migrar(pool, path.join(__dirname, 'migrations'));
  if (process.env.SEED === 'true' && await semear(pool)) console.log(JSON.stringify({ nivel: 'info', msg: 'dados de demonstracao criados' }));

  const publicador = criarPublicador();
  publicador.iniciar();
  const pararPoller = outbox.iniciarPoller(pool, publicador);

  const saga = criarOrquestrador({ pool });
  saga.ligar();

  // RabbitMQ fora nao tira o servico do ar: o Outbox guarda os eventos.
  const app = criarApp({
    nome: 'agendamento',
    rotas: criarRotas({ pool, saga }),
    pronto: async () => ({ db: await pool.query('SELECT 1').then(() => 'up', () => 'down'), rabbitmq: publicador.conectado() ? 'up' : 'down' }),
    metricas: async () => ({ outbox: await outbox.metricas(pool), sagas: await saga.metricas() }),
  });
  const server = app.listen(PORT, () => console.log(JSON.stringify({ nivel: 'info', msg: `agendamento ouvindo na porta ${PORT}` })));
  aoEncerrar(server, saga.parar, pararPoller, publicador.fechar, () => pool.end());
}

main().catch((e) => { console.error(e); process.exit(1); });
