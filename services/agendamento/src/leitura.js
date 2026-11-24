// Conexoes do Read Model: MongoDB (projecao duravel) e Redis (cache de horarios livres).
// O Agendamento funciona sem eles: comandos e SAGA usam so o PostgreSQL.
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');

const TTL_MS = 60000;

// Grava campos no hash `slots:<ubs>`. Cada campo vale `<rev>|<json>` e so e trocado por uma
// revisao mais nova: assim uma carga atrasada nao apaga uma atualizacao recente.
// `_ok` indica que o hash ja foi carregado por inteiro.
const GRAVAR = `
for i = 3, #ARGV, 3 do
  local atual = redis.call('HGET', KEYS[1], ARGV[i])
  if not atual or tonumber(string.match(atual, '^%d+')) < tonumber(ARGV[i + 1]) then
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1] .. '|' .. ARGV[i + 2])
  end
end
if ARGV[2] == '1' then redis.call('HSET', KEYS[1], '_ok', '1') end
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end`;

function criarCache(env, ttlMs) {
  const redis = new Redis({
    host: env.LEITURA_REDIS_HOST, port: Number(env.LEITURA_REDIS_PORT || 6379), password: env.LEITURA_REDIS_PASSWORD || undefined,
    enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 500, retryStrategy: (n) => Math.min(n * 200, 2000),
  });
  redis.on('error', () => {}); // a consulta cai para o MongoDB
  redis.defineCommand('gravarVagas', { numberOfKeys: 1, lua: GRAVAR });

  // UBS cuja atualizacao nao chegou ao Redis: a chave e apagada assim que ele voltar.
  const sujas = new Set();
  async function limparSujas() {
    for (const u of [...sujas]) { await redis.del(`slots:${u}`); sujas.delete(u); }
  }
  redis.on('ready', () => limparSujas().catch(() => {}));

  const livres = (d) => Object.entries(d.slots).filter(([, s]) => s.st === 'LIVRE').map(([id, s]) => ({
    id, ubsId: d.ubsId, profissionalId: s.prof, especialidade: d.especialidade, inicio: s.ini, fim: s.fim, status: 'LIVRE',
  }));
  const gravar = (ubsId, docs, completo) => redis.gravarVagas(`slots:${ubsId}`, ttlMs, completo ? '1' : '0',
    ...docs.flatMap((d) => [`${d.especialidade}|${d.dia}`, d.rev, JSON.stringify(livres(d))]));

  return {
    redis, livres,
    // Do projetor: falha do cache nao segura a projecao.
    async atualizar(doc) {
      try { await gravar(doc.ubsId, [doc], false); if (sujas.size) await limparSujas(); } catch { sujas.add(doc.ubsId); }
    },
    // Da consulta: null se nao ha carga completa ou o Redis esta fora.
    async ler(ubsId) {
      try {
        const h = await redis.hgetall(`slots:${ubsId}`);
        if (!h._ok) return null;
        return Object.entries(h).filter(([k]) => k !== '_ok').map(([k, v]) => ({ dia: k.slice(k.lastIndexOf('|') + 1), livres: JSON.parse(v.slice(v.indexOf('|') + 1)) }));
      } catch { return null; }
    },
    async carregar(ubsId, docs) { if (docs.length) await gravar(ubsId, docs, true).catch(() => {}); },
    async limpar() {
      for await (const chaves of redis.scanStream({ match: 'slots:*' })) if (chaves.length) await redis.del(...chaves);
    },
    estado: () => (redis.status === 'ready' ? 'up' : 'down'),
    fechar: () => redis.disconnect(),
  };
}

function criarLeitura({ env = process.env, ttlMs = TTL_MS } = {}) {
  const credencial = env.LEITURA_MONGO_USER ? `${encodeURIComponent(env.LEITURA_MONGO_USER)}:${encodeURIComponent(env.LEITURA_MONGO_PASSWORD)}@` : '';
  const cliente = new MongoClient(`mongodb://${credencial}${env.LEITURA_MONGO_HOST}:${env.LEITURA_MONGO_PORT || 27017}/?authSource=admin`,
    { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500, socketTimeoutMS: 2000, waitQueueTimeoutMS: 2000 });
  const db = cliente.db('agendamento_leitura');
  const cache = criarCache(env, ttlMs);
  let conectado = false;
  return {
    db, cache,
    agendamentos: db.collection('agendamentos_view'),
    ocupacao: db.collection('ocupacao_ubs'),
    pacientes: db.collection('pacientes_view'),
    controle: db.collection('controle'),
    // Conexao explicita: a automatica (na primeira operacao), se falha, deixa o cliente fechado para
    // sempre. Depois de conectar uma vez, o driver se recupera sozinho das quedas.
    async conectar() {
      if (conectado) return;
      await cliente.connect();
      conectado = true;
    },
    conectado: () => conectado,
    async prepararIndices() {
      await db.collection('agendamentos_view').createIndexes([
        { key: { 'paciente.id': 1, criadoEm: -1 } }, { key: { criadoEm: -1 } }, { key: { 'ubs.id': 1, dia: 1 } },
      ]);
      await db.collection('ocupacao_ubs').createIndex({ ubsId: 1, dia: 1 });
    },
    estado: async () => (!conectado ? 'down' : Promise.race([
      db.command({ ping: 1 }).then(() => 'up', () => 'down'),
      new Promise((ok) => setTimeout(() => ok('down'), 500).unref()),
    ])),
    async fechar() { cache.fechar(); await cliente.close(); },
  };
}

module.exports = { criarLeitura };
