// Armazenamento em Redis. Cada operacao que muda estado e um script Lua: atomica.
//
// Chaves:
//   n:<id>            hash da notificacao
//   saga:<sagaId>     conjunto de ids        encerrada:<sagaId>  SAGA compensada (TTL)
//   ag:<agendamento>  conjunto de ids        agv:<agendamento>   hash { versao, pacienteId, dataConsulta }
//   pac:<paciente>    zset de ids por data   pref:<paciente>     JSON
//   agenda            zset de ids por horario de envio (so notificacoes liberadas)
//   vaga:<slot>       hash { versao }        cap:<ubs>|<esp>|<dia> e ocu:<...>: conjuntos de slots
const Redis = require('ioredis');
const { randomUUID } = require('crypto');

const HORA = 3600e3;
const CANAIS = ['SMS', 'EMAIL', 'WHATSAPP', 'PUSH'];
const LIMITE_GARGALO = 85;

// Um pedido atrasado, entregue depois da compensacao, e recusado.
// Repetir o pedido da mesma SAGA devolve as notificacoes ja criadas.
const CRIAR = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {'ENCERRADA'} end
local ja = redis.call('SMEMBERS', KEYS[2])
if #ja > 0 then table.insert(ja, 1, 'OK'); return ja end
local r = {'OK'}
for _, j in ipairs(cjson.decode(ARGV[1])) do
  redis.call('HSET', 'n:' .. j.id, 'id', j.id, 'pacienteId', j.pacienteId, 'agendamentoId', j.agendamentoId, 'sagaId', j.sagaId,
    'tipo', j.tipo, 'canal', j.canal, 'status', 'AGENDADA', 'enviarEm', j.enviarEm, 'liberada', '0')
  redis.call('SADD', KEYS[2], j.id)
  redis.call('SADD', 'ag:' .. j.agendamentoId, j.id)
  redis.call('ZADD', 'pac:' .. j.pacienteId, j.enviarEm, j.id)
  table.insert(r, j.id)
end
return r`;

const CANCELAR_FN = `
local function cancelar(ids)
  local n = 0
  for _, id in ipairs(ids) do
    if redis.call('HGET', 'n:' .. id, 'status') == 'AGENDADA' then
      redis.call('HSET', 'n:' .. id, 'status', 'CANCELADA')
      redis.call('ZREM', 'agenda', id)
      n = n + 1
    end
  end
  return n
end
`;
const CANCELAR_SAGA = `${CANCELAR_FN}
redis.call('SET', KEYS[1], '1', 'EX', 604800)
return cancelar(redis.call('SMEMBERS', KEYS[2]))`;

// Aplica o evento so se a versao do agendamento for mais nova que a ja vista.
const EVENTO = `${CANCELAR_FN}
local ids = redis.call('SMEMBERS', KEYS[1])
local atual = tonumber(redis.call('HGET', KEYS[2], 'versao') or '0')
if tonumber(ARGV[2]) <= atual then return -1 end
redis.call('HSET', KEYS[2], 'versao', ARGV[2])
if ARGV[1] == 'CANCELAR' then return cancelar(ids) end
if ARGV[1] == 'LIBERAR' then
  for _, id in ipairs(ids) do
    if redis.call('HGET', 'n:' .. id, 'status') == 'AGENDADA' then
      redis.call('HSET', 'n:' .. id, 'liberada', '1')
      redis.call('ZADD', 'agenda', redis.call('HGET', 'n:' .. id, 'enviarEm'), id)
    end
  end
  return #ids
end
-- REAGENDAR: cancela as pendentes e cria as novas ja liberadas
cancelar(ids)
local novas = cjson.decode(ARGV[3])
for _, j in ipairs(novas) do
  redis.call('HSET', 'n:' .. j.id, 'id', j.id, 'pacienteId', j.pacienteId, 'agendamentoId', j.agendamentoId, 'sagaId', j.sagaId,
    'tipo', j.tipo, 'canal', j.canal, 'status', 'AGENDADA', 'enviarEm', j.enviarEm, 'liberada', '1')
  redis.call('SADD', KEYS[1], j.id)
  redis.call('ZADD', 'pac:' .. j.pacienteId, j.enviarEm, j.id)
  redis.call('ZADD', 'agenda', j.enviarEm, j.id)
end
return #novas`;

// Retira da agenda e marca como enviada numa so operacao: no maximo um envio,
// mesmo com varias replicas. Uma queda logo depois pode perder o envio, nunca repeti-lo.
const RETIRAR = `
local ids = redis.call('ZRANGEBYSCORE', 'agenda', '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, id in ipairs(ids) do
  redis.call('ZREM', 'agenda', id)
  redis.call('HSET', 'n:' .. id, 'status', 'ENVIADA', 'enviadaEm', ARGV[1])
end
return ids`;

// Vaga: aplica so versao mais nova, para tolerar evento repetido ou fora de ordem.
const VAGA = `
local atual = tonumber(redis.call('HGET', KEYS[1], 'versao') or '-1')
if tonumber(ARGV[1]) <= atual then return 0 end
redis.call('HSET', KEYS[1], 'versao', ARGV[1])
redis.call('SADD', KEYS[2], ARGV[3])
if ARGV[2] == '1' then redis.call('SADD', KEYS[3], ARGV[3]) else redis.call('SREM', KEYS[3], ARGV[3]) end
redis.call('SADD', 'grupos', ARGV[4])
for i = 1, 3 do redis.call('PEXPIREAT', KEYS[i], ARGV[5]) end
return 1`;

function criarLoja(env = process.env) {
  const redis = new Redis({ host: env.DB_HOST, port: Number(env.DB_PORT || 6379), password: env.DB_PASSWORD || undefined, maxRetriesPerRequest: 2, connectTimeout: 3000, retryStrategy: (n) => Math.min(n * 200, 2000) });
  redis.on('error', (e) => console.error(JSON.stringify({ nivel: 'erro', msg: 'redis', erro: e.message })));
  for (const [nome, lua, n] of [['criarNotificacoes', CRIAR, 2], ['cancelarSaga', CANCELAR_SAGA, 2], ['aplicarEvento', EVENTO, 2], ['retirarVencidas', RETIRAR, 0], ['aplicarVaga', VAGA, 3]]) redis.defineCommand(nome, { lua, numberOfKeys: n });

  const ler = (h) => ({ id: h.id, pacienteId: h.pacienteId, agendamentoId: h.agendamentoId, tipo: h.tipo, canal: h.canal, status: h.status, enviarEm: new Date(Number(h.enviarEm)).toISOString() });
  const varias = async (ids) => {
    if (!ids.length) return [];
    const r = await ids.reduce((m, id) => m.hgetall(`n:${id}`), redis.multi()).exec();
    return r.map(([e, h]) => { if (e) throw e; return h; }).filter((h) => h.id).map(ler).sort((a, b) => a.enviarEm.localeCompare(b.enviarEm));
  };
  async function preferencias(pacienteId) {
    const p = await redis.get(`pref:${pacienteId}`);
    return p ? JSON.parse(p) : { canais: ['SMS'], antecedenciaLembreteHoras: 24 };
  }
  // Monta confirmacao e lembretes; lembrete cujo horario ja passou nao e criado.
  async function montar({ pacienteId, agendamentoId, sagaId, dataConsulta, canais }, agora) {
    const pref = await preferencias(pacienteId);
    const canal = (canais && canais[0]) || pref.canais[0];
    const consulta = new Date(dataConsulta).getTime();
    return [['CONFIRMACAO', agora], ['LEMBRETE_24H', consulta - pref.antecedenciaLembreteHoras * HORA], ['LEMBRETE_2H', consulta - 2 * HORA]]
      .filter(([tipo, em]) => tipo === 'CONFIRMACAO' || em > agora)
      .map(([tipo, enviarEm]) => ({ id: randomUUID(), pacienteId, agendamentoId, sagaId: sagaId || '', tipo, canal, enviarEm }));
  }
  const grupo = (ubsId, esp, inicio) => `${ubsId}|${esp}|${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(inicio))}`;
  function vaga(slotId, versao, ocupada, g, fim) {
    return redis.aplicarVaga(`vaga:${slotId}`, `cap:${g}`, `ocu:${g}`, versao, ocupada ? 1 : 0, slotId, g, new Date(fim).getTime() + 24 * HORA);
  }

  return {
    redis, preferencias,
    ping: () => redis.ping(),
    fechar: () => redis.quit().catch(() => {}),
    salvarPreferencias: (pacienteId, p) => redis.set(`pref:${pacienteId}`, JSON.stringify(p)),
    // Passo 4 da SAGA. Devolve null se a SAGA ja foi compensada.
    // Nada e enviado ainda: as notificacoes so sao liberadas por AgendamentoCriado.
    async criar(d, agora = Date.now()) {
      const [s, ...ids] = await redis.criarNotificacoes(`encerrada:${d.sagaId}`, `saga:${d.sagaId}`, JSON.stringify(await montar(d, agora)));
      return s === 'ENCERRADA' ? null : varias(ids);
    },
    cancelarSaga: (sagaId) => redis.cancelarSaga(`encerrada:${sagaId}`, `saga:${sagaId}`),
    async buscar(id) { const h = await redis.hgetall(`n:${id}`); return h.id ? ler(h) : null; },
    async doPaciente(pacienteId, status) { return (await varias(await redis.zrange(`pac:${pacienteId}`, 0, -1))).filter((n) => !status || n.status === status); },
    async enviarVencidas(enviar, agora = Date.now()) {
      const l = await varias(await redis.retirarVencidas(agora, 50));
      for (const n of l) await enviar(n);
      return l.length;
    },
    async tratarEvento(e, agora = Date.now()) {
      const p = e.payload;
      const chaves = [`ag:${p.agendamentoId}`, `agv:${p.agendamentoId}`];
      switch (e.eventType) {
        case 'AgendamentoCriado': return redis.aplicarEvento(...chaves, 'LIBERAR', e.aggregateVersion, '');
        case 'AgendamentoCancelado': return redis.aplicarEvento(...chaves, 'CANCELAR', e.aggregateVersion, '');
        case 'AgendamentoReagendado':
          return redis.aplicarEvento(...chaves, 'REAGENDAR', e.aggregateVersion, JSON.stringify(await montar({ ...p, dataConsulta: p.slot.inicio }, agora)));
        case 'EscalaCriada':
          for (const s of p.slots) await vaga(s.id, s.version, false, grupo(p.ubs.id, p.profissional.especialidade, s.inicio), s.fim);
          return p.slots.length;
        case 'SlotReservado':
        case 'SlotLiberado':
          return vaga(p.slotId, e.aggregateVersion, e.eventType === 'SlotReservado', grupo(p.ubsId, p.especialidade, p.inicio), p.fim);
        default: return 0;
      }
    },
    async alertas() {
      const grupos = await redis.smembers('grupos');
      const r = [];
      for (const g of grupos) {
        const [cap, ocu] = await Promise.all([redis.scard(`cap:${g}`), redis.scard(`ocu:${g}`)]);
        if (cap === 0) { await redis.srem('grupos', g); continue; } // dia passou: conjuntos expiraram
        const pct = Math.round((1000 * ocu) / cap) / 10;
        if (pct < LIMITE_GARGALO) continue;
        const [ubsId, especialidade, dia] = g.split('|');
        r.push({ id: g, tipo: 'GARGALO', ubsId, especialidade, dia, ocupacaoPercentual: pct, mensagem: `${especialidade} com ${String(pct).replace('.', ',')}% dos horários ocupados em ${dia.split('-').reverse().join('/')}` });
      }
      return r.sort((a, b) => a.dia.localeCompare(b.dia) || b.ocupacaoPercentual - a.ocupacaoPercentual);
    },
  };
}

module.exports = { criarLoja, CANAIS };
