const os = require('os');
const { criarPool, migrar } = require('./src/db');
const { criarPublicador } = require('./src/broker');
const { iniciarPoller } = require('./src/outbox');
const { criarApp } = require('./src/rotas');
const { semear } = require('./src/seed');

const PORT = process.env.PORT || 8002;

async function main() {
  const pool = criarPool();
  await migrar(pool);
  if (process.env.SEED === 'true' && await semear(pool)) console.log(JSON.stringify({ nivel: 'info', msg: 'dados de demonstracao criados' }));

  const publicador = criarPublicador();
  publicador.iniciar();
  const pararPoller = iniciarPoller(pool, publicador);

  const server = criarApp({ pool, publicador, instancia: os.hostname() })
    .listen(PORT, () => console.log(JSON.stringify({ nivel: 'info', msg: `agendamento ouvindo na porta ${PORT}` })));

  let encerrando = false;
  for (const sinal of ['SIGTERM', 'SIGINT']) {
    process.on(sinal, async () => {
      if (encerrando) return;
      encerrando = true;
      setTimeout(() => process.exit(1), 8000).unref();
      server.close();
      await pararPoller();
      await publicador.fechar();
      await pool.end();
      process.exit(0);
    });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
