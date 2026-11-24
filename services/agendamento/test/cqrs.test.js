// CQRS: projetor e consultas contra PostgreSQL, MongoDB e Redis reais e descartaveis.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');
const { criarPool, migrar, transacao } = require('../../../libs/comum/db');
const { transitorio } = require('../../../libs/comum/consumidor');
const { criarLeitura } = require('../src/leitura');
const { criarProjetor, dia } = require('../src/projetor');
const { criarConsultas } = require('../src/consultas');
const { criarOrquestrador } = require('../src/saga');
const agenda = require('../src/agenda');
const { semear, UBS, PROFISSIONAIS } = require('../src/seed');
const { criarAmbiente, eventosDe } = require('./apoio');

const pool = criarPool();
const ctx = { correlationId: 'teste' };
const CENTRO = UBS[0][0], [CLINICA, PEDIATRIA] = PROFISSIONAIS.map((p) => p[0]);
const tx = (fn) => transacao(pool, fn);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let a, outros = [];

before(async () => {
  for (let i = 0; ; i++) { try { await pool.query('SELECT 1'); break; } catch (e) { if (i > 30) throw e; await dormir(500); } }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrar(pool, path.join(__dirname, '..', 'migrations'));
  await semear(pool);
  a = await criarAmbiente({ esperaMs: 600 });
});
beforeEach(async () => {
  for (const x of outros.splice(0)) await x.fechar();
  await pool.query("TRUNCATE agendamentos, outbox_events, saga_log, saga_instances; UPDATE slots SET status='LIVRE', version=0");
  await a.limpar();
});
after(async () => { for (const x of outros) await x.fechar(); await a.fechar(); await pool.end(); });

const slots = async (prof = CLINICA, n = 1) => (await pool.query('SELECT id FROM slots WHERE profissional_id=$1 ORDER BY inicio LIMIT $2', [prof, n])).rows.map((r) => r.id);
async function agendado(slotId, extra) {
  const d = { agendamentoId: randomUUID(), pacienteId: randomUUID(), sagaId: randomUUID(), slotId, urgencia: 'VERDE', ...extra };
  await tx(async (c) => {
    await agenda.reservar(c, ctx, d);
    await agenda.eventoAgendamento(c, ctx, await agenda.mudarStatus(c, d.agendamentoId, 'AGENDADO'), 'AgendamentoCriado', 'criado');
  });
  return d;
}
// Uma especialidade so: abaixo do limite de 200 da consulta.
const livres = async (extra = { especialidade: 'Clínica Geral' }) => (await a.consultas.slots({ ubsId: CENTRO, ...extra })).map((s) => s.id);
async function diaInteiro() {
  const { rows } = await pool.query(
    `WITH s AS (SELECT id, inicio, (inicio AT TIME ZONE 'America/Sao_Paulo')::date AS d FROM slots WHERE profissional_id=$1)
     SELECT id FROM s WHERE d = (SELECT min(d) FROM s WHERE d > (now() AT TIME ZONE 'America/Sao_Paulo')::date) ORDER BY inicio`, [CLINICA]);
  return rows.map((l) => l.id);
}
// Tudo o que o Read Model diz, sem os carimbos de tempo da projecao.
async function retrato(l = a.leitura) {
  const limpo = (d) => { const { projetadoEm, atualizadoEm, ultimoEventoId, ...r } = d; return r; };
  return JSON.stringify([(await l.agendamentos.find().sort({ _id: 1 }).toArray()).map(limpo),
    (await l.ocupacao.find().sort({ _id: 1 }).toArray()).map((d) => ({ ...d, slots: Object.entries(d.slots).sort() }))], (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
}
const embaralhar = (l) => { const r = [...l]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
// Uma historia com todos os tipos de evento.
async function historia() {
  const [s1, s2, s3, s4, s5] = await slots(CLINICA, 5);
  await tx((c) => agenda.criarEscala(c, ctx, { profissionalId: CLINICA, ubsId: CENTRO, diaSemana: 6, horaInicio: '08:00', horaFim: '10:00', duracaoSlotMin: 30, semanas: 2 }));
  const x = await agendado(s1), y = await agendado(s2), z = await agendado(s3);
  await tx((c) => agenda.confirmar(c, ctx, x.agendamentoId));
  await tx((c) => agenda.reagendar(c, ctx, x.agendamentoId, s4));
  await tx((c) => agenda.reagendar(c, ctx, x.agendamentoId, s1));
  await tx((c) => agenda.cancelar(c, ctx, y.agendamentoId, 'viagem'));
  await agendado(s2, { urgencia: 'AMARELO' });
  await tx((c) => agenda.registrarComparecimento(c, ctx, z.agendamentoId, false));
  await agendado(s5);
  return { x, y, z };
}
const apagarSabado = () => pool.query("DELETE FROM slots WHERE extract(isodow FROM inicio AT TIME ZONE 'America/Sao_Paulo')=6");

test('a escrita aparece na leitura com dados prontos para a tela', async () => {
  const [s] = await slots();
  const d = await agendado(s);
  assert.equal(await a.consultas.obter(d.agendamentoId), null, 'a consulta nao le o PostgreSQL');
  await a.projetar(pool);
  const v = await a.consultas.obter(d.agendamentoId);
  assert.deepEqual([v.status, v.versao, v.pacienteId, v.slot.id, v.ubs.nome, v.profissional.nome, v.urgencia], ['AGENDADO', 2, d.pacienteId, s, 'UBS Centro', 'Dra. Ana Souza', 'VERDE']);
  assert.equal(v.slot.inicio.toISOString(), (await pool.query('SELECT inicio FROM slots WHERE id=$1', [s])).rows[0].inicio.toISOString());
  assert.ok(v.projetadoEm >= v.atualizadoEm);
});

test('eventos fora de ordem e repetidos chegam ao mesmo resultado', async () => {
  await a.projetor.reconstruir(pool); // estado inicial das vagas do seed
  const inicial = await a.leitura.ocupacao.find().toArray();
  await historia();
  const ev = await eventosDe(pool);
  for (const e of ev) await a.projetor.tratar(e);
  const esperado = await retrato();
  for (let n = 0; n < 8; n++) {
    await a.leitura.agendamentos.deleteMany({});
    await a.leitura.ocupacao.deleteMany({});
    await a.leitura.ocupacao.insertMany(inicial);
    for (const e of embaralhar([...ev, ...ev])) await a.projetor.tratar(e);
    assert.equal(await retrato(), esperado, `rodada ${n}`);
  }
  await apagarSabado();
});

test('dois projetores disputando os mesmos eventos nao perdem nem duplicam', async () => {
  const b = await criarAmbiente(); outros.push(b);
  await historia();
  const ev = await eventosDe(pool);
  for (const e of ev) await a.projetor.tratar(e);
  const esperado = await retrato();
  for (let n = 0; n < 10; n++) {
    await a.limpar();
    await Promise.all([...embaralhar(ev).map((e) => a.projetor.tratar(e)), ...embaralhar(ev).map((e) => b.projetor.tratar(e))]);
    assert.equal(await retrato(), esperado, `rodada ${n}`);
  }
  await apagarSabado();
});

test('contadores de ocupacao batem com o PostgreSQL', async () => {
  await a.projetor.reconstruir(pool);
  await historia();
  await a.projetar(pool);
  const { rows } = await pool.query(
    `SELECT ubs_id AS u, especialidade AS e, to_char(inicio AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS d, count(*)::int AS t, count(*) FILTER (WHERE status='RESERVADO')::int AS r
       FROM slots GROUP BY 1,2,3 ORDER BY 1,2,3`);
  const docs = await a.leitura.ocupacao.find().toArray();
  const chave = (x) => `${x.u}|${x.e}|${x.d}:${x.t}:${x.r}`;
  assert.deepEqual(docs.map((d) => chave({ u: d.ubsId, e: d.especialidade, d: d.dia, t: d.total, r: d.reservados })).sort(), rows.map(chave).sort());
  await apagarSabado();
});

test('relatorio do gestor: status, urgencia, absenteismo e serie diaria', async () => {
  await a.projetor.reconstruir(pool);
  // Mesmo dia, para a serie diaria nao depender da hora em que o teste roda.
  const [s1, s2, s3, s4] = await diaInteiro();
  const x = await agendado(s1), y = await agendado(s2, { urgencia: 'AMARELO' }), z = await agendado(s3, { urgencia: 'LARANJA' });
  await agendado(s4);
  await tx((c) => agenda.registrarComparecimento(c, ctx, x.agendamentoId, false));
  await tx((c) => agenda.registrarComparecimento(c, ctx, y.agendamentoId, true));
  await tx((c) => agenda.cancelar(c, ctx, z.agendamentoId, 'viagem'));
  await a.projetar(pool);
  const { rows: [{ d }] } = await pool.query("SELECT to_char(inicio AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') d FROM slots WHERE id=$1", [s1]);
  const r = await a.consultas.ocupacao({ ubsId: CENTRO, periodo: d.slice(0, 7) });
  assert.deepEqual(r.porStatus, { FALTOU: 1, REALIZADO: 1, CANCELADO: 1, AGENDADO: 1 });
  assert.deepEqual(r.porUrgencia, { VERDE: 2, AMARELO: 1 }, 'cancelado nao conta urgencia');
  assert.equal(r.taxaAbsenteismo, 50);
  assert.equal(r.reservados, 3);
  assert.deepEqual(r.serieDiaria.find((x2) => x2.data === d), { data: d, agendados: 3, faltas: 1 });
  assert.equal(r.serieDiaria.reduce((t, x2) => t + x2.agendados, 0), r.reservados);
  assert.ok(r.defasagemSegundos >= 0 && r.defasagemSegundos < 5);
  const ped = await a.consultas.ocupacao({ ubsId: CENTRO, periodo: d.slice(0, 7), especialidade: 'Pediatria' });
  assert.deepEqual([ped.reservados, ped.porStatus], [0, {}]);
  assert.ok(ped.slotsTotais > 0 && ped.slotsTotais < r.slotsTotais);
});

test('vagas: reservar tira da lista e cancelar devolve, pelo cache e pelo MongoDB', async () => {
  await a.projetor.reconstruir(pool);
  for (const comCache of [true, false]) {
    if (!comCache) await a.leitura.cache.redis.flushdb();
    const ver = async () => { if (!comCache) await a.leitura.cache.redis.flushdb(); return livres(); };
    const todas = await ver(), [s] = todas;
    const d = await agendado(s);
    assert.deepEqual(await ver(), todas, 'antes da projecao a leitura ainda mostra a vaga');
    await a.projetar(pool);
    assert.deepEqual(await ver(), todas.filter((x) => x !== s));
    await tx((c) => agenda.cancelar(c, ctx, d.agendamentoId));
    await a.projetar(pool);
    assert.deepEqual(await ver(), todas);
  }
});

test('filtros de vagas e fuso de Sao Paulo', async () => {
  await a.projetor.reconstruir(pool);
  const { rows } = await pool.query("SELECT id, especialidade e, to_char(inicio AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') d FROM slots WHERE ubs_id=$1 AND inicio > now() ORDER BY inicio, id", [CENTRO]);
  const [d1, d2] = [...new Set(rows.map((r) => r.d))].slice(1, 3);
  const pg = (f) => rows.filter(f).map((r) => r.id).slice(0, 200);
  assert.deepEqual(await livres({}), pg(() => true));
  assert.deepEqual(await livres({ especialidade: 'Pediatria' }), pg((r) => r.e === 'Pediatria'));
  assert.deepEqual(await livres({ dataInicio: d1, dataFim: d2 }), pg((r) => r.d >= d1 && r.d <= d2));
  assert.deepEqual(await livres({ dataInicio: d2, dataFim: d2, especialidade: 'Ginecologia' }), pg((r) => r.d === d2 && r.e === 'Ginecologia'));
  assert.deepEqual(await a.consultas.slots({ ubsId: randomUUID() }), []);
  assert.deepEqual([dia('2026-12-01T01:30:00Z'), dia('2026-12-01T03:00:00Z')], ['2026-11-30', '2026-12-01']);
});

test('horario que ja passou nao e oferecido, mesmo no cache', async () => {
  const ini = new Date(Date.now() - 60e3), fim = new Date(Date.now() + 1740e3), id = randomUUID();
  const evento = { aggregateType: 'Escala', eventType: 'EscalaCriada', occurredAt: new Date().toISOString(), aggregateVersion: 1,
    payload: { ubs: { id: CENTRO }, profissional: { id: CLINICA, especialidade: 'Clínica Geral' }, slots: [{ id, inicio: ini.toISOString(), fim: fim.toISOString(), version: 0 }] } };
  await a.projetor.tratar(evento);
  assert.deepEqual([await livres(), await livres()], [[], []]);
  assert.equal((await a.leitura.ocupacao.findOne()).total, 1);
});

test('cache: carga atrasada nao apaga atualizacao mais nova', async () => {
  await a.projetor.reconstruir(pool);
  const velhos = await a.leitura.ocupacao.find({ ubsId: CENTRO }).toArray(); // a consulta leu o MongoDB...
  const [s] = await livres();
  await agendado(s);
  await a.projetar(pool);                                                    // ...a reserva foi projetada...
  await a.leitura.cache.carregar(CENTRO, velhos);                            // ...e so agora a consulta grava o cache
  assert.ok(!(await livres()).includes(s));
});

test('com o cache carregado, a consulta de vagas nao toca no MongoDB', async () => {
  await a.projetor.reconstruir(pool);
  const todas = await livres();
  await a.leitura.ocupacao.updateMany({}, { $set: { slots: {} } });
  assert.deepEqual(await livres(), todas);
});

test('cache parcial nao e tratado como completo', async () => {
  await a.projetor.reconstruir(pool);
  const todas = await livres();
  await a.leitura.cache.redis.flushdb();
  const d = await agendado(todas[0]);
  await a.projetar(pool); // o projetor grava so o dia alterado
  assert.deepEqual(await livres(), todas.slice(1));
  assert.ok(await a.leitura.cache.redis.pttl(`slots:${CENTRO}`) > 0, 'toda chave expira');
  assert.ok(d);
});

test('reentrega depois de parar entre o MongoDB e o Redis corrige o cache', async () => {
  await a.projetor.reconstruir(pool);
  const [s] = await livres();
  await agendado(s);
  const ev = await eventosDe(pool);
  const meio = criarProjetor({ leitura: { ...a.leitura, cache: { atualizar: async () => { throw new Error('queda'); } } } });
  await assert.rejects(meio.tratar(ev[0]), /queda/);
  assert.ok((await livres()).includes(s), 'cache ficou para tras');
  await a.projetor.tratar(ev[0]); // reentrega da mesma mensagem
  assert.ok(!(await livres()).includes(s));
});

test('Redis fora: consultas e projecao seguem pelo MongoDB; na volta o cache sujo e descartado', async () => {
  const redis = a.leitura.cache.redis;
  await a.projetor.reconstruir(pool);
  const [s] = await livres();
  await agendado(s);
  redis.disconnect();
  await a.projetar(pool);
  assert.ok(!(await livres()).includes(s), 'sem cache, le o MongoDB');
  await redis.connect();
  for (let i = 0; i < 40 && (await redis.exists(`slots:${CENTRO}`)); i++) await dormir(25);
  assert.ok(!(await livres()).includes(s), 'o cache antigo nao pode ressuscitar a vaga');
});

// Porta de entrada para o MongoDB real, que pode ser aberta, travada e fechada durante o teste.
function portao() {
  const socks = new Set();
  let travado = false;
  const srv = net.createServer((c) => {
    const m = net.connect(27017, process.env.LEITURA_MONGO_HOST);
    for (const x of [c, m]) { socks.add(x); x.on('error', () => {}); }
    c.on('data', (d) => { if (!travado) m.write(d); });
    m.on('data', (d) => { if (!travado) c.write(d); });
    c.on('close', () => m.destroy()); m.on('close', () => c.destroy());
  });
  return {
    abrir: (porta = 0) => new Promise((ok) => { srv.listen(porta, '127.0.0.1', () => ok(srv.address().port)); }),
    fechar: () => new Promise((ok) => { srv.close(ok); for (const x of socks) x.destroy(); }),
    travar: (v) => { travado = v; },
  };
}
const leituraVia = (porta) => { const l = criarLeitura({ env: { ...process.env, LEITURA_MONGO_HOST: '127.0.0.1', LEITURA_MONGO_PORT: String(porta) } }); outros.push(l); return l; };

test('MongoDB fora na partida: consultas dao 503, o evento e falha transitoria, e o servico se recupera sozinho', async (t) => {
  const p = portao(), porta = await p.abrir();
  await p.fechar();
  const l = leituraVia(porta), c = criarConsultas({ leitura: l });
  await assert.rejects(c.obter(randomUUID()), { status: 503 });
  await assert.rejects(c.listar({ page: 1, size: 5 }), { status: 503 });
  await assert.rejects(c.ocupacao({ ubsId: CENTRO, periodo: '2026-12' }), { status: 503 });
  const d = await agendado((await slots())[0]);
  const e = await criarProjetor({ leitura: l }).tratar((await eventosDe(pool))[0]).catch((x) => x);
  assert.ok(transitorio(e), `${e.name} nao pode ir para a DLQ`);
  assert.equal(await l.estado(), 'down');

  let pronto = 0;
  const proj = criarProjetor({ leitura: l, env: { PACIENTES_URL: 'http://127.0.0.1:1' } });
  proj.manter(pool, () => { pronto++; }, 100);
  await dormir(1800); // ao menos uma tentativa falha
  assert.equal(pronto, 0);
  const volta = portao();
  t.after(() => volta.fechar());
  await volta.abrir(porta);
  for (let n = 0; n < 60 && !pronto; n++) await dormir(100);
  await proj.parar();
  assert.equal(pronto, 1);
  assert.equal((await c.obter(d.agendamentoId)).status, 'AGENDADO');
  assert.equal(await l.estado(), 'up');
});

test('MongoDB cai ou trava com o servico no ar: 503 em poucos segundos, e depois volta', async (t) => {
  const p = portao(), l = leituraVia(await p.abrir()), c = criarConsultas({ leitura: l });
  t.after(() => p.fechar());
  await l.conectar();
  assert.equal(await c.obter(randomUUID()), null);
  p.travar(true);
  const t0 = Date.now();
  await assert.rejects(c.obter(randomUUID()), { status: 503 });
  assert.ok(Date.now() - t0 < 6000, 'nao pode ficar pendurado');
  const e = await criarProjetor({ leitura: l }).tratarPaciente(atualizado(randomUUID(), 'x', 1)).catch((x) => x);
  assert.ok(transitorio(e), `${e && e.name} nao pode ir para a DLQ`);
  p.travar(false);
  for (let n = 0; n < 40; n++) { try { assert.equal(await c.obter(randomUUID()), null); return; } catch { await dormir(250); } }
  assert.fail('nao voltou');
});

test('read-your-writes: versaoMinima espera a projecao, mas so ate o limite', async () => {
  const d = await agendado((await slots())[0]);
  setTimeout(() => a.projetar(pool), 200);
  const v = await a.consultas.obter(d.agendamentoId, 2);
  assert.equal(v.versao, 2);
  let t0 = Date.now();
  assert.equal((await a.consultas.obter(d.agendamentoId, 3)).versao, 2, 'passado o limite, devolve o que ha');
  assert.ok(Date.now() - t0 >= 550);
  t0 = Date.now();
  assert.equal((await a.consultas.obter(d.agendamentoId)).versao, 2);
  assert.ok(Date.now() - t0 < 300, 'sem versaoMinima nao espera');
});

test('SAGA: solicitado aparece PENDENTE e falha antes da reserva aparece CANCELADO', async () => {
  const o = criarOrquestrador({ pool, env: {} }), [s] = await slots();
  const p = await o.iniciar('c', { pacienteId: randomUUID(), slotId: s, sintomas: 'tosse ha dois dias' });
  await a.projetar(pool);
  let v = await a.consultas.obter(p.id);
  assert.deepEqual([v.status, v.versao, v.slot.id], ['PENDENTE', 0, s]);
  await tx(async (c) => {
    await c.query("UPDATE saga_instances SET estado='FALHOU', motivo='sem vaga'");
    const { agendaDaSaga } = require('../src/saga');
    const { rows: [linha] } = await c.query('SELECT * FROM saga_instances');
    await agenda.eventoAgendamento(c, ctx, await agendaDaSaga(c, linha), 'AgendamentoCancelado', 'cancelado');
  });
  for (const e of (await eventosDe(pool)).reverse()) await a.projetor.tratar(e);
  v = await a.consultas.obter(p.id);
  assert.deepEqual([v.status, v.motivo], ['CANCELADO', 'sem vaga']);
  const antes = await retrato();
  await a.limpar();
  await a.projetor.reconstruir(pool);
  assert.deepEqual((await a.consultas.obter(p.id)).status, 'CANCELADO', 'a reconstrucao inclui SAGAs sem reserva');
  assert.ok(antes);
});

// ---------------------------------------------------------------- Nome do paciente
const atualizado = (id, nome, v) => ({ eventType: 'PacienteAtualizado', aggregateType: 'Paciente', aggregateVersion: v, eventId: randomUUID(), occurredAt: new Date().toISOString(), payload: { pacienteId: id, nome } });
const nome = async (d) => (await a.consultas.obter(d.agendamentoId)).pacienteNome;

test('nome do paciente: em qualquer ordem, vale a versao mais nova', async () => {
  const [s1, s2] = await slots(CLINICA, 2);
  const d = await agendado(s1);
  await a.projetor.tratarPaciente(atualizado(d.pacienteId, 'Maria', 1));
  await a.projetar(pool);
  assert.equal(await nome(d), 'Maria', 'nome antes do agendamento');
  await a.projetor.tratarPaciente(atualizado(d.pacienteId, 'Maria Silva', 3));
  await a.projetor.tratarPaciente(atualizado(d.pacienteId, 'Maria S.', 2));
  assert.equal(await nome(d), 'Maria Silva');
  const e = await agendado(s2, { pacienteId: d.pacienteId });
  await a.projetar(pool);
  assert.equal(await nome(e), 'Maria Silva');
});

test('nome e agendamento simultaneos em replicas diferentes: o nome nao se perde', async () => {
  const b = await criarAmbiente(); outros.push(b);
  const ds = [];
  for (const s of await slots(CLINICA, 12)) ds.push(await agendado(s));
  const ev = await eventosDe(pool);
  await Promise.all(ds.flatMap((d, i) => [
    ...ev.filter((e) => e.payload.agendamentoId === d.agendamentoId && e.aggregateType === 'Agendamento').map((e) => a.projetor.tratar(e)),
    dormir(i % 4).then(() => b.projetor.tratarPaciente(atualizado(d.pacienteId, `P${i}`, 1))),
  ]));
  for (const [i, d] of ds.entries()) assert.equal(await nome(d), `P${i}`);
});

// Deixa algo acontecer exatamente antes da 1a gravacao em agendamentos_view.
function interrompido(antes) {
  let feito = false;
  const agendamentos = new Proxy(a.leitura.agendamentos, { get: (alvo, k) => {
    if (k !== 'updateOne') return typeof alvo[k] === 'function' ? alvo[k].bind(alvo) : alvo[k];
    return async (...args) => { if (!feito) { feito = true; await antes(); } return alvo.updateOne(...args); };
  } });
  return criarProjetor({ leitura: { ...a.leitura, agendamentos } });
}

test('nome que chega no meio da projecao do agendamento nao se perde', async () => {
  const d = await agendado((await slots())[0]);
  const e = (await eventosDe(pool)).find((x) => x.aggregateType === 'Agendamento');
  await interrompido(() => a.projetor.tratarPaciente(atualizado(d.pacienteId, 'Maria', 1))).tratar(e);
  assert.equal(await nome(d), 'Maria');
});

test('outra replica cria o documento com versao menor no meio: a maior nao se perde', async () => {
  const d = await agendado((await slots())[0]);
  const e = (await eventosDe(pool)).find((x) => x.aggregateType === 'Agendamento');
  const concorrente = async () => {
    await a.projetor.tratar({ ...e, aggregateVersion: 0, payload: { ...e.payload, status: 'PENDENTE' } });
    throw Object.assign(new Error('E11000'), { code: 11000 });
  };
  await interrompido(concorrente).tratar(e);
  assert.equal((await a.consultas.obter(d.agendamentoId)).status, 'AGENDADO');
});

// ---------------------------------------------------------------- Reconstrucao
test('reconstruir do zero da o mesmo resultado que projetar os eventos', async () => {
  await a.projetor.reconstruir(pool);
  await historia();
  await a.projetar(pool);
  const projetado = await retrato();
  await a.limpar();
  await a.projetor.reconstruir(pool);
  assert.equal(await retrato(), projetado);
  await apagarSabado();
});

test('reconstruir com limpeza conserta Read Model e cache corrompidos', async () => {
  await a.projetor.reconstruir(pool);
  const d = await agendado((await slots())[0]);
  await a.projetar(pool);
  const certo = await retrato(), vagas = await livres();
  await a.leitura.agendamentos.updateOne({ _id: d.agendamentoId }, { $set: { status: 'REALIZADO' } });
  await a.leitura.ocupacao.updateMany({}, [{ $set: { slots: { $arrayToObject: { $map: { input: { $objectToArray: '$slots' }, in: { k: '$$this.k', v: { $mergeObjects: ['$$this.v', { st: 'RESERVADO' }] } } } } } } }]);
  await a.leitura.cache.redis.hset(`slots:${CENTRO}`, `Clínica Geral|${dia(Date.now() + 864e5)}`, '999999|[]');
  await a.projetor.reconstruir(pool, { limpar: true });
  assert.equal(await retrato(), certo);
  assert.deepEqual(await livres(), vagas);
});

test('reconstruir com eventos novos chegando ao mesmo tempo termina consistente', async () => {
  await a.projetor.reconstruir(pool);
  const ss = await slots(CLINICA, 10);
  const ds = [];
  for (const s of ss) ds.push(await agendado(s));
  await a.projetar(pool);
  const comandos = (async () => { for (const d of ds) { await tx((c) => agenda.cancelar(c, ctx, d.agendamentoId)); await a.projetar(pool); } })();
  await Promise.all([a.projetor.reconstruir(pool, { limpar: true }), comandos]);
  const aoVivo = await retrato();
  await a.limpar();
  await a.projetor.reconstruir(pool);
  assert.equal(aoVivo, await retrato());
});

test('reconstruir pede os nomes que faltam a Pacientes; sem ele, segue sem nome', async () => {
  const d = await agendado((await slots())[0]);
  const srv = http.createServer((req, res) => {
    assert.equal(req.headers['x-user-role'], 'servico');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: d.pacienteId, nome: 'Vindo de Pacientes' }));
  }).listen(0);
  const com = criarProjetor({ leitura: a.leitura, env: { PACIENTES_URL: `http://127.0.0.1:${srv.address().port}` } });
  const sem = criarProjetor({ leitura: a.leitura, env: { PACIENTES_URL: 'http://127.0.0.1:1' } });
  await sem.reconstruir(pool);
  assert.equal(await nome(d), undefined);
  await com.reconstruir(pool);
  srv.close(); srv.closeAllConnections();
  assert.equal(await nome(d), 'Vindo de Pacientes');
  await a.projetor.tratarPaciente(atualizado(d.pacienteId, 'Nome Novo', 1));
  assert.equal(await nome(d), 'Nome Novo', 'qualquer evento vence o nome recuperado');
});

test('Read Model vazio e reconstruido sozinho, uma vez', async () => {
  const d = await agendado((await slots())[0]);
  assert.equal(await a.projetor.conferir(pool), true);
  assert.equal((await a.consultas.obter(d.agendamentoId)).status, 'AGENDADO');
  assert.equal(await a.projetor.conferir(pool), false);
  await a.leitura.db.dropDatabase(); // MongoDB voltou com volume vazio
  assert.equal(await a.projetor.conferir(pool), true);
  assert.equal((await a.consultas.obter(d.agendamentoId)).status, 'AGENDADO');
  assert.equal((await a.leitura.agendamentos.indexes()).length, 4, 'indices recriados');
});

test('metricas medem a defasagem e evento invalido nao passa em silencio', async () => {
  const p = criarProjetor({ leitura: a.leitura });
  await agendado((await slots())[0]);
  const [e] = await eventosDe(pool);
  await p.tratar({ ...e, occurredAt: new Date(Date.now() - 4000).toISOString() });
  const m = p.metricas();
  assert.equal(m.projetados, 1);
  assert.ok(m.atrasoMs.p95 >= 4000 && m.atrasoMs.p95 < 5000);
  await assert.rejects(p.tratar({ ...e, payload: {} }));
  await assert.rejects(p.tratar({ ...e, aggregateType: 'Agendamento', payload: { agendamentoId: 'x' } }));
  assert.ok(PEDIATRIA);
});
