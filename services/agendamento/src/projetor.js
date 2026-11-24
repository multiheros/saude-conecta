// Projetor (CQRS): aplica os eventos no Read Model.
//
// Com duas replicas consumindo a mesma fila, eventos podem chegar repetidos ou fora de ordem.
// Cada documento guarda a versao do agregado e so aceita versao maior; por isso aplicar de
// novo nao muda nada, e a reconstrucao pode rodar com o sistema no ar.
const { chamar } = require('../../../libs/comum/cliente');
const agenda = require('./agenda');
const { agendaDaSaga } = require('./saga');

const DUPLICADO = 11000;
const formatoDia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const dia = (data) => formatoDia.format(new Date(data));

// Upsert condicionado a versao. A chave duplicada tem dois sentidos: o documento ja esta nesta
// versao ou numa mais nova (nada a fazer), ou outra replica acabou de cria-lo com uma versao
// menor (a segunda volta o encontra e atualiza).
async function aplicarVersao(colecao, _id, versao, campos) {
  for (let volta = 1; ; volta++) {
    try {
      await colecao.updateOne({ _id, versao: { $lt: versao } }, { $set: { ...campos, versao } }, { upsert: true });
      return;
    } catch (e) {
      if (e.code !== DUPLICADO) throw e;
      if (volta === 2) return;
    }
  }
}

function criarProjetor({ leitura, env = process.env }) {
  const { agendamentos, ocupacao, pacientes, controle, cache } = leitura;
  const atrasos = []; // ms entre a gravacao do evento e a projecao (ultimos 1000)
  let projetados = 0;

  // --- Agendamento: um documento pronto para a tela
  async function projetarAgendamento(p, versao, { ocorridoEm, eventId }) {
    await aplicarVersao(agendamentos, p.agendamentoId, versao, {
      status: p.status, urgencia: p.urgencia ?? null, motivo: p.motivo ?? null, sagaId: p.sagaId, 'paciente.id': p.pacienteId,
      slot: { id: p.slot.id, inicio: new Date(p.slot.inicio), fim: new Date(p.slot.fim) }, dia: dia(p.slot.inicio),
      ubs: p.ubs, profissional: p.profissional, criadoEm: new Date(p.criadoEm),
      atualizadoEm: new Date(ocorridoEm), projetadoEm: new Date(), ultimoEventoId: eventId ?? null,
    });
    // Le o nome depois de gravar: se ele chegar ao mesmo tempo por outra replica, uma das duas o preenche.
    const n = await pacientes.findOne({ _id: p.pacienteId });
    if (n) await preencherNome(p.pacienteId, n.nome, n.versao);
  }
  const preencherNome = (id, nome, versao) => agendamentos.updateMany(
    { 'paciente.id': id, $or: [{ 'paciente.versao': { $exists: false } }, { 'paciente.versao': { $lt: versao } }] },
    { $set: { 'paciente.nome': nome, 'paciente.versao': versao } });

  // --- Vagas: um documento por UBS, especialidade e dia. As vagas ficam dentro dele e os contadores
  // sao recalculados na mesma atualizacao, que e atomica. Com $inc, um evento repetido contaria duas vezes.
  async function projetarVagas(vagas) {
    const grupos = new Map();
    for (const v of vagas) {
      const d = dia(v.inicio), id = `${v.ubsId}|${v.especialidade}|${d}`;
      if (!grupos.has(id)) grupos.set(id, { id, dia: d, ubsId: v.ubsId, especialidade: v.especialidade, vagas: [] });
      grupos.get(id).vagas.push(v);
    }
    for (const g of grupos.values()) {
      const set = { ubsId: { $literal: g.ubsId }, especialidade: { $literal: g.especialidade }, dia: { $literal: g.dia } };
      for (const v of g.vagas) {
        const campo = `slots.${v.id}`;
        const novo = { v: v.version, st: v.status, prof: v.profissionalId, ini: new Date(v.inicio).toISOString(), fim: new Date(v.fim).toISOString() };
        set[campo] = { $cond: [{ $lt: [{ $ifNull: [`$${campo}.v`, -1] }, v.version] }, { $literal: novo }, `$${campo}`] };
      }
      const lista = { $objectToArray: '$slots' };
      const pipeline = [{ $set: set }, { $set: {
        total: { $size: lista },
        reservados: { $size: { $filter: { input: lista, cond: { $eq: ['$$this.v.st', 'RESERVADO'] } } } },
        // Cresce a cada mudanca e depende so do conteudo: ordena as gravacoes no Redis mesmo apos uma reconstrucao.
        rev: { $sum: { $map: { input: lista, in: { $add: ['$$this.v.v', 1] } } } },
      } }];
      // Busca por igualdade no _id: se duas replicas criam o documento juntas, o proprio MongoDB repete a atualizacao.
      const doc = await ocupacao.findOneAndUpdate({ _id: g.id }, pipeline, { upsert: true, returnDocument: 'after' });
      await cache.atualizar(doc); // sempre, mesmo em repeticao: a 1a entrega pode ter parado entre os dois bancos
    }
  }

  // --- Eventos
  async function tratar(e) {
    const p = e.payload;
    if (e.aggregateType === 'Agendamento') {
      await projetarAgendamento(p, e.aggregateVersion, { ocorridoEm: e.occurredAt, eventId: e.eventId });
    } else if (e.aggregateType === 'Slot') {
      const status = { SlotReservado: 'RESERVADO', SlotLiberado: 'LIVRE' }[e.eventType];
      if (!status) return;
      await projetarVagas([{ ...p, id: p.slotId, status, version: e.aggregateVersion }]);
    } else if (e.eventType === 'EscalaCriada') {
      await projetarVagas(p.slots.map((s) => ({ ...s, ubsId: p.ubs.id, profissionalId: p.profissional.id, especialidade: p.profissional.especialidade, status: 'LIVRE' })));
    } else return;
    const atraso = Math.max(0, Date.now() - Date.parse(e.occurredAt));
    projetados++;
    atrasos.push(atraso);
    if (atrasos.length > 1000) atrasos.shift();
    await controle.updateOne({ _id: 'projecao' }, { $max: { ocorridoEm: new Date(e.occurredAt) }, $set: { atrasoMs: atraso } }, { upsert: true });
  }

  async function tratarPaciente(e) {
    if (e.eventType !== 'PacienteAtualizado') return;
    await aplicarVersao(pacientes, e.payload.pacienteId, e.aggregateVersion, { nome: e.payload.nome });
    await preencherNome(e.payload.pacienteId, e.payload.nome, e.aggregateVersion);
  }

  // --- Reconstrucao a partir do Write Model
  async function reconstruir(pool, { limpar = false } = {}) {
    if (limpar) {
      await agendamentos.deleteMany({});
      await ocupacao.deleteMany({});
      await cache.limpar().catch((e) => console.error(JSON.stringify({ nivel: 'alerta', msg: 'cache nao limpo, expira sozinho', erro: e.message })));
    }
    const paginas = async function* (sql) {
      for (let ultimo = '00000000-0000-0000-0000-000000000000'; ;) {
        const { rows } = await pool.query(sql, [ultimo]);
        if (!rows.length) return;
        yield rows;
        ultimo = rows[rows.length - 1].id;
      }
    };
    const total = { vagas: 0, agendamentos: 0 };
    for await (const rows of paginas('SELECT id, ubs_id AS "ubsId", profissional_id AS "profissionalId", especialidade, inicio, fim, status, version FROM slots WHERE id > $1 ORDER BY id LIMIT 500')) {
      await projetarVagas(rows);
      total.vagas += rows.length;
    }
    const projetarLinha = async (a) => {
      await projetarAgendamento(JSON.parse(JSON.stringify(agenda.detalhe(a))), a.version, { ocorridoEm: a.atualizado_em });
      total.agendamentos++;
    };
    for await (const rows of paginas(`${agenda.SELECT} WHERE a.id > $1 ORDER BY a.id LIMIT 500`)) for (const a of rows) await projetarLinha(a);
    // SAGAs que nao chegaram a reservar (em andamento ou falhas) nao tem linha em agendamentos.
    for await (const rows of paginas(`SELECT s.* FROM saga_instances s LEFT JOIN agendamentos a ON a.id=s.agendamento_id
                                       WHERE a.id IS NULL AND s.id > $1 ORDER BY s.id LIMIT 500`)) for (const s of rows) await projetarLinha(await agendaDaSaga(pool, s));
    await recuperarNomes();
    return total;
  }

  // Os nomes pertencem ao servico de Pacientes: o que faltar e pedido a ele.
  async function recuperarNomes() {
    for (const id of await agendamentos.distinct('paciente.id', { 'paciente.nome': { $exists: false } })) {
      try {
        const r = await chamar('GET', `${env.PACIENTES_URL}/api/v1/pacientes/${id}`, { timeoutMs: 2000, headers: { 'X-User-Role': 'servico' } });
        if (r.status !== 200) continue;
        await pacientes.updateOne({ _id: id }, { $setOnInsert: { nome: r.corpo.nome, versao: 0 } }, { upsert: true });
        const n = await pacientes.findOne({ _id: id });
        await preencherNome(id, n.nome, n.versao);
      } catch (e) {
        if (!e.remota) throw e;
        return console.error(JSON.stringify({ nivel: 'alerta', msg: 'nomes nao recuperados', erro: e.message }));
      }
    }
  }

  // Mantem o Read Model de pe: na partida, e se o MongoDB voltar vazio, reconstroi.
  let parado = false, acordar = () => {}, laco = null;
  async function conferir(pool) {
    if (await controle.findOne({ _id: 'reconstrucao' })) return false;
    await leitura.prepararIndices();
    const total = await reconstruir(pool);
    await controle.updateOne({ _id: 'reconstrucao' }, { $set: { em: new Date(), ...total } }, { upsert: true });
    console.log(JSON.stringify({ nivel: 'info', msg: 'read model reconstruido', ...total }));
    return true;
  }
  function manter(pool, aoFicarPronto = () => {}, intervaloMs = 5000) {
    let pronto = false;
    laco = (async () => {
      while (!parado) {
        try {
          await leitura.conectar();
          await conferir(pool);
          if (!pronto) { pronto = true; aoFicarPronto(); }
        } catch (e) { console.error(JSON.stringify({ nivel: 'erro', msg: 'read model indisponivel', erro: e.message })); }
        if (!parado) await new Promise((ok) => { acordar = ok; setTimeout(ok, intervaloMs); });
      }
    })();
  }

  return {
    tratar, tratarPaciente, reconstruir, conferir, manter,
    async parar() { parado = true; acordar(); await laco; },
    metricas() {
      const o = [...atrasos].sort((a, b) => a - b), q = (f) => (o.length ? o[Math.min(o.length - 1, Math.floor(f * o.length))] : null);
      return { projetados, atrasoMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: o.length ? o[o.length - 1] : null } };
    },
  };
}

module.exports = { criarProjetor, dia };
