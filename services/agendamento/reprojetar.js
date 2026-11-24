// Apaga o Read Model e o reconstroi a partir do PostgreSQL, com o servico no ar.
// Uso: docker compose exec agendamento node reprojetar.js
const { criarPool } = require('../../libs/comum/db');
const { criarLeitura } = require('./src/leitura');
const { criarProjetor } = require('./src/projetor');

(async () => {
  const pool = criarPool(), leitura = criarLeitura();
  await new Promise((ok) => { leitura.cache.redis.once('ready', ok); setTimeout(ok, 2000); });
  const t0 = Date.now();
  await leitura.conectar();
  await leitura.prepararIndices();
  const total = await criarProjetor({ leitura }).reconstruir(pool, { limpar: true });
  console.log(JSON.stringify({ msg: 'read model reconstruido', ...total, ms: Date.now() - t0 }));
  await leitura.fechar();
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
