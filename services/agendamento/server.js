const path = require('path');
const { criarPool, migrar } = require('../../libs/comum/db');
const { criarPublicador } = require('../../libs/comum/broker');
const outbox = require('../../libs/comum/outbox');
const { criarConsumidor } = require('../../libs/comum/consumidor');
const { criarApp, aoEncerrar } = require('../../libs/comum/http');
const { criarRotas } = require('./src/rotas');
const { criarOrquestrador } = require('./src/saga');
const { criarLeitura } = require('./src/leitura');
const { criarProjetor } = require('./src/projetor');
const { criarConsultas } = require('./src/consultas');
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

  // Read Model (CQRS). Os consumidores so ligam depois que ele esta de pe.
  const leitura = criarLeitura();
  const projetor = criarProjetor({ leitura });
  const consumidores = [
    criarConsumidor({ fila: 'agendamento.projetor', tratar: projetor.tratar }),
    criarConsumidor({ fila: 'agendamento.pacientes', tratar: projetor.tratarPaciente }),
  ];
  projetor.manter(pool, () => consumidores.forEach((c) => c.iniciar()));

  // RabbitMQ e Read Model fora nao tiram o servico do ar: o Outbox guarda os eventos e os comandos seguem.
  const app = criarApp({
    nome: 'agendamento',
    rotas: criarRotas({ pool, saga, consultas: criarConsultas({ leitura }) }),
    pronto: async () => ({ db: await pool.query('SELECT 1').then(() => 'up', () => 'down'), rabbitmq: publicador.conectado() ? 'up' : 'down', leitura: await leitura.estado(), cache: leitura.cache.estado() }),
    metricas: async () => ({ outbox: await outbox.metricas(pool), sagas: await saga.metricas(), projetor: { ...projetor.metricas(), fila: await consumidores[0].fila() } }),
  });
  const server = app.listen(PORT, () => console.log(JSON.stringify({ nivel: 'info', msg: `agendamento ouvindo na porta ${PORT}` })));
  aoEncerrar(server, saga.parar, projetor.parar, ...consumidores.map((c) => c.fechar), leitura.fechar, pararPoller, publicador.fechar, () => pool.end());
}

main().catch((e) => { console.error(e); process.exit(1); });
