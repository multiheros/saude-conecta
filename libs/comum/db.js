const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function criarPool(env = process.env) {
  const pool = new Pool({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    max: 10,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
  });
  // Sem este ouvinte, a queda do banco com conexao ociosa derruba o processo.
  pool.on('error', (e) => console.error(JSON.stringify({ nivel: 'erro', msg: 'conexao com o banco', erro: e.message })));
  return pool;
}

// Executa fn numa transacao: commit se resolver, rollback se lancar.
async function transacao(pool, fn) {
  const c = await pool.connect();
  let erroConexao;
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (e2) { erroConexao = e2; }
    throw e;
  } finally {
    c.release(erroConexao); // com erro, a conexao e descartada em vez de voltar ao pool
  }
}

// Aplica as migracoes pendentes. A trava consultiva evita corrida entre replicas.
async function migrar(pool, dir) {
  await transacao(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(1)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (nome TEXT PRIMARY KEY, aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await c.query('SELECT nome FROM schema_migrations');
    const aplicadas = new Set(rows.map((r) => r.nome));
    for (const nome of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (aplicadas.has(nome)) continue;
      await c.query(fs.readFileSync(path.join(dir, nome), 'utf8'));
      await c.query('INSERT INTO schema_migrations (nome) VALUES ($1)', [nome]);
    }
  });
}

// Executa fn no maximo uma vez por evento, na mesma transacao que registra o eventId.
// Exige a tabela processed_events (consumer, event_id).
async function umaVez(pool, consumidor, eventId, fn) {
  return transacao(pool, async (c) => {
    const { rowCount } = await c.query('INSERT INTO processed_events (consumer, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [consumidor, eventId]);
    if (rowCount === 0) return false;
    await fn(c);
    return true;
  });
}

module.exports = { criarPool, transacao, migrar, umaVez };
