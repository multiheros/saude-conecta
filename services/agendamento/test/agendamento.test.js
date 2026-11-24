// Testes de integracao contra um PostgreSQL real e descartavel.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const path = require('path');
const { criarPool, migrar: migrarDir, transacao } = require('../../../libs/comum/db');
const agenda = require('../src/agenda');
const outbox = require('../../../libs/comum/outbox');
const { criarApp } = require('../../../libs/comum/http');
const { criarRotas } = require('../src/rotas');
const { semear, UBS, PROFISSIONAIS } = require('../src/seed');

const pool = criarPool();
const migrar = (p) => migrarDir(p, path.join(__dirname, '..', 'migrations'));
const ctx = { correlationId: 'teste' };
const CLINICA = PROFISSIONAIS[0][0], PEDIATRIA = PROFISSIONAIS[1][0], CENTRO = UBS[0][0];
let server, base;

before(async () => {
  for (let i = 0; ; i++) { try { await pool.query('SELECT 1'); break; } catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 500)); } }
  await migrar(pool);
  await semear(pool);
  server = criarApp({ nome: 'teste', rotas: criarRotas({ pool }), pronto: async () => ({ db: 'up' }) }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
beforeEach(async () => {
  await pool.query('TRUNCATE agendamentos, outbox_events');
  await pool.query("UPDATE slots SET status='LIVRE'");
});
after(async () => { server.close(); await pool.end(); });

const tx = (fn) => transacao(pool, fn);
const slots = async (prof, n) => (await pool.query('SELECT id FROM slots WHERE profissional_id=$1 ORDER BY inicio LIMIT $2', [prof, n])).rows.map((r) => r.id);
const statusSlot = async (id) => (await pool.query('SELECT status FROM slots WHERE id=$1', [id])).rows[0].status;
const eventos = async () => (await pool.query('SELECT event_type FROM outbox_events ORDER BY seq')).rows.map((r) => r.event_type);
const novo = (slotId, extra) => ({ agendamentoId: randomUUID(), pacienteId: randomUUID(), sagaId: randomUUID(), slotId, urgencia: 'VERDE', ...extra });
const agendado = async (slotId, extra) => { const d = novo(slotId, extra); await tx((c) => agenda.reservar(c, ctx, d)); await tx((c) => agenda.mudarStatus(c, d.agendamentoId, 'AGENDADO')); return d; };
const chamar = async (metodo, caminho, { corpo, papel = 'gestor', usuario } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (papel) headers['X-User-Role'] = papel;
  if (usuario) headers['X-User-Id'] = usuario;
  const r = await fetch(base + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  return { status: r.status, tipo: r.headers.get('content-type'), corpo: await r.json() };
};

test('reservas simultaneas do mesmo horario: exatamente uma vence', async () => {
  const [s] = await slots(CLINICA, 1);
  const r = await Promise.allSettled(Array.from({ length: 8 }, () => tx((c) => agenda.reservar(c, ctx, novo(s)))));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  for (const x of r.filter((y) => y.status === 'rejected')) assert.equal(x.reason.status, 409);
  assert.deepEqual(await eventos(), ['SlotReservado']);
});

test('o banco impede overbooking mesmo se a aplicacao errar', async () => {
  const [s] = await slots(CLINICA, 1);
  await agendado(s);
  await assert.rejects(pool.query("INSERT INTO agendamentos (id, paciente_id, slot_id, status) VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'AGENDADO')", [s]), { code: '23505' });
});

test('falha depois da reserva desfaz dado e evento juntos', async () => {
  const [s] = await slots(CLINICA, 1);
  await assert.rejects(tx(async (c) => { await agenda.reservar(c, ctx, novo(s)); throw new Error('queda'); }), /queda/);
  assert.equal(await statusSlot(s), 'LIVRE');
  assert.deepEqual(await eventos(), []);
});

test('reserva e idempotente por sagaId', async () => {
  const [s] = await slots(CLINICA, 1);
  const d = novo(s);
  const a = await tx((c) => agenda.reservar(c, ctx, d));
  const b = await tx((c) => agenda.reservar(c, ctx, d));
  assert.equal(a.id, b.id);
  assert.deepEqual(await eventos(), ['SlotReservado']);
});

test('compensacao so libera a reserva da propria SAGA e pode repetir', async () => {
  const [s1, s2] = await slots(CLINICA, 2);
  const a = novo(s1), b = novo(s2);
  await tx((c) => agenda.reservar(c, ctx, a));
  await tx((c) => agenda.reservar(c, ctx, b));
  await tx((c) => agenda.liberarReserva(c, ctx, { sagaId: randomUUID() }));
  assert.equal(await statusSlot(s1), 'RESERVADO');
  await tx((c) => agenda.liberarReserva(c, ctx, { sagaId: a.sagaId, motivo: 'x' }));
  await tx((c) => agenda.liberarReserva(c, ctx, { sagaId: a.sagaId, motivo: 'x' }));
  assert.equal(await statusSlot(s1), 'LIVRE');
  assert.equal(await statusSlot(s2), 'RESERVADO');
  assert.deepEqual(await eventos(), ['SlotReservado', 'SlotReservado', 'SlotLiberado']);
});

test('compensacao atrasada nao solta horario ja de outro paciente', async () => {
  const [s] = await slots(CLINICA, 1);
  const a = novo(s), b = novo(s);
  await tx((c) => agenda.reservar(c, ctx, a));
  await tx((c) => agenda.liberarReserva(c, ctx, { sagaId: a.sagaId }));
  await tx((c) => agenda.reservar(c, ctx, b));
  await tx((c) => agenda.liberarReserva(c, ctx, { sagaId: a.sagaId }));
  assert.equal(await statusSlot(s), 'RESERVADO');
});

test('horario passado nao pode ser reservado', async () => {
  const { rows: [{ id }] } = await pool.query(
    "INSERT INTO slots (ubs_id, profissional_id, especialidade, inicio, fim) VALUES ($1,$2,'Clínica Geral', now()-interval '2 hours', now()-interval '90 minutes') RETURNING id", [CENTRO, CLINICA]);
  await assert.rejects(tx((c) => agenda.reservar(c, ctx, novo(id))), { status: 409 });
  await pool.query('DELETE FROM slots WHERE id=$1', [id]);
});

test('HATEOAS: links seguem o estado e acao invalida da 409', async () => {
  const [s] = await slots(CLINICA, 1);
  const d = await agendado(s);
  const url = `/agendamentos/${d.agendamentoId}`;
  let r = await chamar('GET', url);
  assert.match(r.tipo, /hal\+json/);
  assert.deepEqual(Object.keys(r.corpo._links), ['self', 'confirmar', 'reagendar', 'cancelar']);
  r = await chamar('POST', `${url}/confirmacao`);
  assert.deepEqual(Object.keys(r.corpo._links), ['self', 'reagendar', 'cancelar']);
  r = await chamar('POST', `${url}/confirmacao`);
  assert.equal(r.status, 409);
  assert.match(r.tipo, /problem\+json/);
  r = await chamar('POST', `${url}/cancelamento`, { corpo: { motivo: 'viagem' } });
  assert.deepEqual([r.status, r.corpo.status, r.corpo.motivo, Object.keys(r.corpo._links)], [200, 'CANCELADO', 'viagem', ['self']]);
  assert.equal(await statusSlot(s), 'LIVRE');
});

test('reagendar troca os horarios numa transacao', async () => {
  const [s1, s2, s3] = await slots(CLINICA, 3), [ped] = await slots(PEDIATRIA, 1);
  const d = await agendado(s1);
  await agendado(s3);
  const url = `/agendamentos/${d.agendamentoId}/reagendamento`;
  assert.equal((await chamar('POST', url, { corpo: { novoSlotId: s3 } })).status, 409);
  assert.equal((await chamar('POST', url, { corpo: { novoSlotId: ped } })).status, 409);
  assert.equal(await statusSlot(ped), 'LIVRE', 'especialidade errada nao pode deixar horario preso');
  assert.equal((await chamar('POST', url, { corpo: { novoSlotId: s1 } })).status, 409);
  assert.equal((await chamar('POST', url, { corpo: {} })).status, 422);
  const r = await chamar('POST', url, { corpo: { novoSlotId: s2 } });
  assert.deepEqual([r.status, r.corpo.slotId], [200, s2]);
  assert.deepEqual([await statusSlot(s1), await statusSlot(s2)], ['LIVRE', 'RESERVADO']);
});

test('comparecimento e restrito ao gestor e encerra o ciclo', async () => {
  const [s] = await slots(CLINICA, 1);
  const d = await agendado(s);
  const url = `/agendamentos/${d.agendamentoId}/comparecimento`;
  assert.equal((await chamar('POST', url, { corpo: { compareceu: true }, papel: 'paciente', usuario: d.pacienteId })).status, 403);
  assert.equal((await chamar('POST', url, { corpo: {} })).status, 422);
  assert.equal((await chamar('POST', url, { corpo: { compareceu: false } })).corpo.status, 'FALTOU');
  assert.equal((await chamar('POST', url, { corpo: { compareceu: true } })).status, 409);
});

test('paciente so acessa o que e seu', async () => {
  const [s] = await slots(CLINICA, 1);
  const d = await agendado(s);
  const url = `/agendamentos/${d.agendamentoId}`;
  assert.equal((await chamar('GET', url, { papel: 'paciente', usuario: d.pacienteId })).status, 200);
  assert.equal((await chamar('GET', url, { papel: 'paciente', usuario: randomUUID() })).status, 403);
  assert.equal((await chamar('GET', url, { papel: null })).status, 403);
  assert.equal((await chamar('POST', `${url}/cancelamento`, { papel: 'paciente', usuario: randomUUID() })).status, 403);
  assert.equal((await chamar('GET', '/agendamentos', { papel: 'paciente', usuario: d.pacienteId })).status, 403);
  const lista = await chamar('GET', `/agendamentos?pacienteId=${d.pacienteId}`, { papel: 'paciente', usuario: d.pacienteId });
  assert.deepEqual([lista.corpo.total, lista.corpo.items[0].id], [1, d.agendamentoId]);
});

test('escala gera horarios dentro do expediente, sem duplicar nem sobrepor', async () => {
  const corpo = { profissionalId: CLINICA, ubsId: CENTRO, diaSemana: 6, horaInicio: '08:00', horaFim: '09:45', duracaoSlotMin: 30, semanas: 2 };
  assert.equal((await chamar('POST', '/escalas', { corpo, papel: 'paciente' })).status, 403);
  assert.equal((await chamar('POST', '/escalas', { corpo: { ...corpo, horaFim: '07:00' } })).status, 422);
  assert.equal((await chamar('POST', '/escalas', { corpo: { ...corpo, ubsId: randomUUID() } })).status, 422);
  const r = await chamar('POST', '/escalas', { corpo });
  assert.equal(r.status, 201);
  const { rows } = await pool.query("SELECT to_char(inicio AT TIME ZONE 'America/Sao_Paulo','HH24:MI') h, extract(isodow FROM inicio AT TIME ZONE 'America/Sao_Paulo')::int d FROM slots WHERE profissional_id=$1 AND extract(isodow FROM inicio AT TIME ZONE 'America/Sao_Paulo')=6", [CLINICA]);
  assert.equal(rows.length, r.corpo.slotsGerados);
  assert.deepEqual([...new Set(rows.map((x) => x.h))].sort(), ['08:00', '08:30', '09:00']);
  assert.equal((await chamar('POST', '/escalas', { corpo })).corpo.slotsGerados, 0);
  assert.equal((await chamar('POST', '/escalas', { corpo: { ...corpo, horaInicio: '08:15', horaFim: '08:45' } })).corpo.slotsGerados, 0);
  assert.deepEqual(await eventos(), ['EscalaCriada']);
  await pool.query("DELETE FROM slots WHERE extract(isodow FROM inicio AT TIME ZONE 'America/Sao_Paulo')=6");
});

test('consulta de horarios valida parametros e so traz livres', async () => {
  assert.equal((await chamar('GET', '/slots')).status, 400);
  assert.equal((await chamar('GET', `/slots?ubsId=${CENTRO}&dataInicio=abc`)).status, 400);
  const q = `/slots?ubsId=${CENTRO}&especialidade=${encodeURIComponent('Clínica Geral')}`;
  const antes = (await chamar('GET', q)).corpo;
  assert.ok(antes.length > 0 && antes.every((s) => s.status === 'LIVRE'));
  await agendado(antes[0].id);
  assert.ok(!(await chamar('GET', q)).corpo.some((s) => s.id === antes[0].id));
});

// ---------------------------------------------------------------- Outbox
const gravar = (agregadoId, versao) => tx((c) => outbox.gravarEvento(c, { tipo: 'T', rota: 'agendamento.t', agregado: 'A', agregadoId, versao, payload: { versao } }));
const situacao = async () => Object.fromEntries((await pool.query('SELECT status, count(*)::int n FROM outbox_events GROUP BY 1')).rows.map((r) => [r.status, r.n]));

test('dois pollers: cada evento sai uma vez e na ordem do agregado', async () => {
  const ids = Array.from({ length: 10 }, () => randomUUID());
  for (let v = 1; v <= 8; v++) for (const id of ids) await gravar(id, v);
  const vistos = [];
  const pub = { conectado: () => true, publicar: async (_r, e) => { await new Promise((r) => setTimeout(r, Math.random() * 8)); vistos.push(e); } };
  const parar = [outbox.iniciarPoller(pool, pub, 20), outbox.iniciarPoller(pool, pub, 20)];
  for (let i = 0; i < 200 && (await situacao()).PENDING; i++) await new Promise((r) => setTimeout(r, 50));
  await Promise.all(parar.map((f) => f()));
  assert.deepEqual(await situacao(), { PUBLISHED: 80 });
  assert.equal(new Set(vistos.map((e) => e.eventId)).size, 80);
  assert.equal(vistos.length, 80);
  for (const id of ids) assert.deepEqual(vistos.filter((e) => e.aggregateId === id).map((e) => e.aggregateVersion), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('broker fora nao gasta tentativas nem vira FAILED', async () => {
  await gravar(randomUUID(), 1);
  const fora = { publicar: async () => { throw Object.assign(new Error('fora'), { indisponivel: true }); } };
  for (let i = 0; i < 15; i++) { await pool.query('UPDATE outbox_events SET next_attempt_at=now()'); await outbox.publicarLote(pool, fora); }
  const { rows: [e] } = await pool.query('SELECT status, attempts FROM outbox_events');
  assert.deepEqual(e, { status: 'PENDING', attempts: 0 });
});

test('recusa repetida vira FAILED apos o limite e espera cada vez mais', async () => {
  await gravar(randomUUID(), 1);
  const recusa = { publicar: async () => { throw new Error('nack'); } };
  await outbox.publicarLote(pool, recusa);
  assert.equal(await outbox.publicarLote(pool, recusa), 0, 'respeita o backoff');
  for (let i = 1; i < outbox.MAX_TENTATIVAS; i++) { await pool.query('UPDATE outbox_events SET next_attempt_at=now()'); await outbox.publicarLote(pool, recusa); }
  assert.deepEqual(await situacao(), { FAILED: 1 });
});

test('evento com falha segura os seguintes do mesmo agregado, nao os demais', async () => {
  const a = randomUUID(), b = randomUUID();
  await gravar(a, 1); await gravar(a, 2); await gravar(b, 1);
  const vistos = [];
  const pub = { publicar: async (_r, e) => { if (e.aggregateId === a && e.aggregateVersion === 1) throw new Error('nack'); vistos.push(e.aggregateId + e.aggregateVersion); } };
  await outbox.publicarLote(pool, pub);
  await outbox.publicarLote(pool, pub);
  assert.deepEqual(vistos, [`${b}1`]);
});

test('queda depois de publicar e antes de marcar: reenvia (at-least-once), nunca perde', async () => {
  await gravar(randomUUID(), 1);
  const vistos = [];
  const pub = { publicar: async (_r, e) => { vistos.push(e.eventId); } };
  const quebrado = { connect: async () => { const c = await pool.connect(); return { query: (q, ...r) => (/^UPDATE/.test(q) ? Promise.reject(new Error('queda')) : c.query(q, ...r)), release: (e) => c.release(e) }; } };
  await assert.rejects(outbox.publicarLote(quebrado, pub), /queda/);
  await outbox.publicarLote(pool, pub);
  assert.equal(vistos.length, 2);
  assert.equal(new Set(vistos).size, 1);
  assert.deepEqual(await situacao(), { PUBLISHED: 1 });
});

test('migracoes e seed podem rodar em paralelo e repetir', async () => {
  await Promise.all([migrar(pool), migrar(pool), migrar(pool)]);
  assert.deepEqual(await Promise.all([semear(pool), semear(pool)]), [false, false]);
});
