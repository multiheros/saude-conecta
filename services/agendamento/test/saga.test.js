// Orquestrador contra PostgreSQL real e participantes simulados, que guardam estado e
// falham sob demanda: permite conferir que, ao fim, nada ficou para tras.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');
const { criarPool, migrar, transacao } = require('../../../libs/comum/db');
const { criarApp } = require('../../../libs/comum/http');
const { criarOrquestrador, MOTIVO } = require('../src/saga');
const { criarRotas } = require('../src/rotas');
const agenda = require('../src/agenda');
const { semear, PROFISSIONAIS } = require('../src/seed');
const { criarAmbiente } = require('./apoio');

const pool = criarPool();
const CFG = { leaseMs: 1500, timeoutMs: 250, timeoutTriagemMs: 400, backoffMs: 10, pendenteMs: 50, intervaloMs: 20 };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let mundo, part, env, ativos = [], server, base;

// Participante simulado: um servidor para os tres servicos.
function novoMundo() {
  return { triagens: new Set(), flags: new Map(), notif: new Set(), log: [], classificacao: 'VERDE', falha: {}, encerradas: new Set() };
}
async function participante(req, res) {
  const u = new URL(req.url, 'http://x'), saga = req.headers['x-saga-id'], papel = req.headers['x-user-role'];
  let corpo = ''; for await (const d of req) corpo += d;
  const servico = u.pathname.includes('triagens') ? 'triagem' : u.pathname.includes('validacao') ? 'pacientes' : 'notificacoes';
  const chave = `${req.method} ${servico}`;
  mundo.log.push({ chave, saga, idem: req.headers['idempotency-key'], corr: req.headers['x-correlation-id'], papel, corpo: corpo && JSON.parse(corpo) });
  const executar = () => {
    const alvo = { triagem: mundo.triagens, notificacoes: mundo.notif }[servico];
    if (req.method === 'DELETE') {
      mundo.encerradas.add(`${servico}:${saga}`);
      if (alvo) alvo.delete(saga); else if (mundo.flags.get(u.pathname) === saga) mundo.flags.delete(u.pathname);
      return [204, null];
    }
    if (mundo.encerradas.has(`${servico}:${saga}`)) return [409, { title: 'SAGA já encerrada' }];
    if (servico === 'triagem') { alvo.add(saga); return [201, { id: 't', classificacao: mundo.classificacao }]; }
    if (servico === 'notificacoes') { alvo.add(saga); return [201, [{}, {}, {}]]; }
    if (mundo.flags.has(u.pathname) && mundo.flags.get(u.pathname) !== saga) return [409, { title: 'Agendamento em andamento' }];
    mundo.flags.set(u.pathname, saga);
    return [200, { valido: true }];
  };
  const f = mundo.falha[chave], modo = typeof f === 'function' ? f() : f;
  if (modo === 'erro') { res.writeHead(500).end(); return; }              // recusou sem executar
  if (modo === 'perde-resposta') { executar(); return; }                  // executou, mas a resposta se perdeu
  if (modo === 'trava') return;                                           // nao executou nem respondeu
  if (typeof modo === 'number') { res.writeHead(modo, { 'content-type': 'application/json' }).end('{"title":"recusado"}'); return; }
  if (modo && modo.depoisDe) await modo.depoisDe;
  const [st, c] = executar();
  res.writeHead(st, { 'content-type': 'application/json' }).end(c ? JSON.stringify(c) : undefined);
}

before(async () => {
  for (let i = 0; ; i++) { try { await pool.query('SELECT 1'); break; } catch (e) { if (i > 30) throw e; await dormir(500); } }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrar(pool, path.join(__dirname, '..', 'migrations'));
  await semear(pool);
  part = http.createServer(participante).listen(0);
  const b = `http://127.0.0.1:${part.address().port}`;
  env = { TRIAGEM_URL: b, PACIENTES_URL: b, NOTIFICACOES_URL: b };
});
beforeEach(async () => {
  for (const o of ativos.splice(0)) await o.parar();
  await pool.query("TRUNCATE agendamentos, outbox_events, saga_log, saga_instances; UPDATE slots SET status='LIVRE', version=0");
  mundo = novoMundo();
});
after(async () => { for (const o of ativos) await o.parar(); if (server) server.close(); part.closeAllConnections(); part.close(); await pool.end(); });

const orq = (cfg = {}, e = env) => { const o = criarOrquestrador({ pool, env: e, config: { ...CFG, ...cfg } }); o.ligar(); ativos.push(o); return o; };
const slots = async (n = 1) => (await pool.query('SELECT id FROM slots WHERE profissional_id=$1 ORDER BY inicio LIMIT $2', [PROFISSIONAIS[0][0], n])).rows.map((r) => r.id);
const pedir = (o, slotId, extra) => o.iniciar('corr-1', { pacienteId: randomUUID(), slotId, sintomas: 'tosse ha dois dias', idade: 30, ...extra });
const linha = async (id) => (await pool.query('SELECT * FROM saga_instances WHERE agendamento_id=$1', [id])).rows[0];
async function ate(id, ...estados) { for (let i = 0; i < 300; i++) { const s = await linha(id); if (estados.includes(s.estado)) return s; await dormir(20); } assert.fail(`parou em ${(await linha(id)).estado}`); }
const statusSlot = async (id) => (await pool.query('SELECT status FROM slots WHERE id=$1', [id])).rows[0].status;
const eventos = async () => (await pool.query('SELECT event_type t, aggregate_type a, aggregate_version v FROM outbox_events ORDER BY seq')).rows.map((r) => `${r.t}:${r.v}`);
const chamadas = (metodo) => mundo.log.filter((l) => l.chave.startsWith(metodo)).map((l) => l.chave);
const historico = async (id) => (await pool.query('SELECT passo, tipo, resultado FROM saga_log WHERE saga_id=$1 ORDER BY id', [id])).rows.map((r) => `${r.tipo[0]} ${r.passo} ${r.resultado}`);
// Nada ficou para tras em lugar nenhum.
async function limpo(slot, id) {
  assert.deepEqual([mundo.triagens.size, mundo.flags.size, mundo.notif.size], [0, 0, 0], 'participantes devem estar como antes');
  assert.equal(await statusSlot(slot), 'LIVRE');
  assert.equal((await pool.query("SELECT count(*)::int n FROM agendamentos WHERE status IN ('PENDENTE','AGENDADO')")).rows[0].n, 0);
  assert.equal((await orq().agendamento(id)).status, 'CANCELADO');
}

test('caminho feliz: 4 passos em ordem, um so evento de conclusao', async () => {
  const o = orq(), [s] = await slots();
  const a = await pedir(o, s);
  assert.equal(a.status, 'PENDENTE');
  const g = await ate(a.id, 'CONCLUIDA');
  assert.deepEqual(chamadas(''), ['POST triagem', 'POST pacientes', 'POST notificacoes']);
  assert.deepEqual(await eventos(), ['AgendamentoSolicitado:0', 'SlotReservado:1', 'AgendamentoCriado:2']);
  assert.deepEqual(await historico(g.id), ['A 1-triagem OK', 'A 2-pacientes OK', 'A 3-reserva OK', 'A 4-notificacoes OK']);
  const v = await o.agendamento(a.id);
  assert.deepEqual([v.status, v.urgencia, await statusSlot(s)], ['AGENDADO', 'VERDE', 'RESERVADO']);
  assert.ok(mundo.log.every((l) => l.papel === 'servico' && l.corr === 'corr-1' && l.saga === g.id));
  assert.equal(mundo.log[0].idem, `${g.id}:1`);
  assert.equal(mundo.log[0].corpo.idade, 30);
});

test('sintomas sao apagados do Agendamento assim que a triagem termina', async () => {
  const o = orq(), [s] = await slots();
  const a = await pedir(o, s);
  assert.equal((await ate(a.id, 'CONCLUIDA')).sintomas, null);
  mundo.falha['POST triagem'] = 'erro';
  const b = await pedir(o, (await slots(2))[1]);
  assert.equal((await ate(b.id, 'FALHOU', 'COMPENSACAO_PENDENTE')).sintomas, null);
});

for (const [passo, chave, esperadas] of [
  [1, 'POST triagem', ['DELETE triagem']],
  [2, 'POST pacientes', ['DELETE triagem', 'DELETE pacientes']],
  [4, 'POST notificacoes', ['DELETE pacientes', 'DELETE triagem', 'DELETE notificacoes']],
]) {
  for (const modo of ['erro', 'perde-resposta']) {
    test(`falha no passo ${passo} (${modo}): tudo volta ao que era`, async () => {
      mundo.falha[chave] = modo;
      const o = orq(), [s] = await slots();
      const a = await pedir(o, s);
      const g = await ate(a.id, 'FALHOU');
      assert.deepEqual(chamadas('DELETE'), esperadas, 'ordem inversa; o passo ambiguo por ultimo');
      await limpo(s, a.id);
      assert.equal(g.motivo, MOTIVO.INDISPONIVEL);
      const ev = await eventos();
      assert.equal(ev.filter((e) => e.startsWith('AgendamentoCancelado')).length, 1);
      assert.ok(!ev.some((e) => e.startsWith('AgendamentoCriado')));
    });
  }
}

test('falha no passo 3 (horario ocupado): compensa 2 e 1', async () => {
  const [s] = await slots();
  await pool.query("UPDATE slots SET status='BLOQUEADO' WHERE id=$1", [s]);
  const o = orq();
  const a = await pedir(o, s);
  const g = await ate(a.id, 'FALHOU');
  assert.deepEqual(chamadas('DELETE'), ['DELETE pacientes', 'DELETE triagem']);
  assert.equal(g.motivo, MOTIVO.SLOT);
  assert.deepEqual([mundo.triagens.size, mundo.flags.size], [0, 0]);
  assert.deepEqual(await eventos(), ['AgendamentoSolicitado:0', 'AgendamentoCancelado:1']);
  assert.deepEqual(await historico(g.id), ['A 1-triagem OK', 'A 2-pacientes OK', 'A 3-reserva FALHA', 'C 2-pacientes OK', 'C 1-triagem OK']);
});

test('participante desligado: conexao nunca aberta nao exige compensacao do proprio passo', async () => {
  const morto = http.createServer().listen(0), porta = morto.address().port;
  await new Promise((r) => morto.close(r));
  const o = orq({}, { ...env, NOTIFICACOES_URL: `http://127.0.0.1:${porta}` }), [s] = await slots();
  const a = await pedir(o, s);
  const g = await ate(a.id, 'FALHOU');
  assert.deepEqual(await historico(g.id), ['A 1-triagem OK', 'A 2-pacientes OK', 'A 3-reserva OK', 'A 4-notificacoes FALHA', 'C 3-reserva OK', 'C 2-pacientes OK', 'C 1-triagem OK']);
  assert.deepEqual(await eventos(), ['AgendamentoSolicitado:0', 'SlotReservado:1', 'SlotLiberado:2', 'AgendamentoCancelado:2']);
  await limpo(s, a.id);
});

test('urgencia VERMELHO nao agenda: descarta a triagem e orienta', async () => {
  mundo.classificacao = 'VERMELHO';
  const o = orq(), [s] = await slots();
  const a = await pedir(o, s);
  const g = await ate(a.id, 'FALHOU');
  assert.equal(g.motivo, MOTIVO.EMERGENCIA);
  assert.deepEqual(chamadas(''), ['POST triagem', 'DELETE triagem']);
  await limpo(s, a.id);
});

test('recusa de negocio (4xx) nao e repetida', async () => {
  mundo.falha['POST pacientes'] = 404;
  const o = orq(), [s] = await slots();
  const g = await ate((await pedir(o, s)).id, 'FALHOU');
  assert.equal(chamadas('POST pacientes').length, 1);
  assert.equal(g.motivo, MOTIVO.RECUSADO);
  assert.deepEqual(chamadas('DELETE'), ['DELETE triagem']);
});

test('falha passageira: repete com a mesma chave de idempotencia e conclui', async () => {
  let n = 0;
  mundo.falha['POST notificacoes'] = () => (++n <= 2 ? 'perde-resposta' : null);
  const o = orq(), [s] = await slots();
  await ate((await pedir(o, s)).id, 'CONCLUIDA');
  const chaves = mundo.log.filter((l) => l.chave === 'POST notificacoes').map((l) => l.idem);
  assert.equal(chaves.length, 3);
  assert.equal(new Set(chaves).size, 1);
  assert.deepEqual(chamadas('DELETE'), []);
});

test('triagem nao e repetida por timeout', async () => {
  mundo.falha['POST triagem'] = 'trava';
  const o = orq(), [s] = await slots();
  await ate((await pedir(o, s)).id, 'FALHOU');
  assert.equal(chamadas('POST triagem').length, 1);
});

test('compensacao que falha nao impede as outras e e repetida ate dar certo', async () => {
  mundo.falha['POST notificacoes'] = 'erro';
  let fora = true;
  mundo.falha['DELETE pacientes'] = () => (fora ? 'erro' : null);
  const o = orq(), [s] = await slots();
  const a = await pedir(o, s);
  const g = await ate(a.id, 'COMPENSACAO_PENDENTE');
  assert.deepEqual([await statusSlot(s), mundo.triagens.size, mundo.flags.size], ['LIVRE', 0, 1], 'horario e triagem liberados na hora; so a flag espera');
  assert.deepEqual(g.compensar, [2]);
  assert.equal((await o.agendamento(a.id)).status, 'CANCELADO');
  await dormir(300);
  fora = false;
  await ate(a.id, 'FALHOU');
  await limpo(s, a.id);
  const h = await historico(g.id);
  assert.equal(h.filter((x) => x === 'C 2-pacientes PENDENTE').length, 1, 'repeticoes não enchem o log');
  assert.equal(h.filter((x) => x === 'C 2-pacientes OK').length, 1);
});

test('duas SAGAs disputam o horario: uma agenda, a outra e compensada', async () => {
  const o = orq(), [s] = await slots();
  const r = await Promise.all(Array.from({ length: 5 }, () => pedir(o, s)));
  const fins = await Promise.all(r.map((a) => ate(a.id, 'CONCLUIDA', 'FALHOU')));
  assert.equal(fins.filter((x) => x.estado === 'CONCLUIDA').length, 1);
  assert.deepEqual([mundo.triagens.size, mundo.flags.size, mundo.notif.size], [1, 1, 1]);
});

test('varias replicas: cada SAGA e conduzida por uma so', async () => {
  const os = [orq(), orq(), orq()], ss = await slots(12);
  const r = await Promise.all(ss.map((s, i) => pedir(os[i % 3], s)));
  await Promise.all(r.map((a) => ate(a.id, 'CONCLUIDA')));
  for (const c of ['POST triagem', 'POST pacientes', 'POST notificacoes']) assert.equal(chamadas(c).length, 12, c);
});

test('replica morre no meio: outra retoma do passo em que parou', async () => {
  let soltar;
  const trava = new Promise((r) => { soltar = r; });
  let n = 0;
  mundo.falha['POST pacientes'] = () => (++n === 1 ? { depoisDe: trava } : null);
  const morta = criarOrquestrador({ pool, env, config: { ...CFG, leaseMs: 400, timeoutMs: 60000 } });
  const [s] = await slots();
  const a = await pedir(morta, s);
  await morta.assumir();
  for (let i = 0; i < 100 && n === 0; i++) await dormir(10);
  const viva = orq();
  const g = await ate(a.id, 'CONCLUIDA');
  assert.equal(chamadas('POST triagem').length, 1, 'passo já concluido não se repete');
  soltar(); // a replica "morta" acorda e tenta continuar
  await dormir(300);
  assert.equal(chamadas('POST notificacoes').length, 1, 'quem perdeu o lease não prossegue');
  assert.deepEqual(await historico(g.id), ['A 1-triagem OK', 'A 2-pacientes OK', 'A 3-reserva OK', 'A 4-notificacoes OK']);
  assert.equal((await viva.agendamento(a.id)).status, 'AGENDADO');
});

test('replica morre durante a compensacao: outra termina', async () => {
  const o = criarOrquestrador({ pool, env, config: CFG }), [s] = await slots();
  const a = await pedir(o, s);
  const g = await linha(a.id);
  mundo.triagens.add(g.id); mundo.flags.set(`/api/v1/pacientes/${g.paciente_id}/validacao`, g.id);
  await transacao(pool, (c) => agenda.reservar(c, {}, { agendamentoId: a.id, pacienteId: g.paciente_id, slotId: s, sagaId: g.id, urgencia: 'VERDE' }));
  await pool.query("UPDATE saga_instances SET estado='COMPENSANDO', compensar='{3,2,1}', motivo='x', locked_by=gen_random_uuid(), locked_until=now()-interval '1 second'");
  orq();
  await ate(a.id, 'FALHOU');
  await limpo(s, a.id);
});

test('parada ordenada solta a SAGA para outra replica assumir na hora', async () => {
  let soltar;
  mundo.falha['POST triagem'] = { depoisDe: new Promise((r) => { soltar = r; }) };
  const o1 = criarOrquestrador({ pool, env, config: { ...CFG, leaseMs: 60000 } }), [s] = await slots();
  o1.ligar();
  const a = await pedir(o1, s);
  for (let i = 0; i < 100 && !chamadas('POST triagem').length; i++) await dormir(10);
  const parando = o1.parar();
  soltar();
  await parando;
  const g = await linha(a.id);
  assert.deepEqual([g.estado, g.passo_atual, g.locked_by], ['EM_ANDAMENTO', 2, null]);
  orq();
  await ate(a.id, 'CONCLUIDA');
});

test('API: 202 com Location, idempotencia, validacao e permissoes', async (t) => {
  const o = orq(), [s, s2] = await slots(2), amb = await criarAmbiente();
  t.after(() => amb.fechar());
  await amb.limpar();
  server = criarApp({ nome: 't', rotas: criarRotas({ pool, saga: o, consultas: amb.consultas }), pronto: async () => ({ db: 'up' }) }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const eu = randomUUID(), outro = randomUUID();
  const req = async (m, c, { corpo, papel = 'paciente', quem = eu, chave } = {}) => {
    const r = await fetch(base + c, { method: m, body: corpo && JSON.stringify(corpo), headers: { 'content-type': 'application/json', ...(papel && { 'X-User-Role': papel }), 'X-User-Id': quem, ...(chave && { 'Idempotency-Key': chave }) } });
    return { status: r.status, loc: r.headers.get('location'), corpo: await r.json() };
  };
  const corpo = { pacienteId: eu, slotId: s, sintomas: 'tosse ha dois dias' };
  const r = await req('POST', '/agendamentos', { corpo, chave: 'k1' });
  assert.equal(r.status, 202);
  assert.equal(r.loc, `/api/v1/agendamentos/${r.corpo.id}?versaoMinima=0`);
  assert.deepEqual(Object.keys(r.corpo._links), ['self']);
  setTimeout(() => amb.projetar(pool), 300);
  assert.equal((await req('GET', r.loc.replace('/api/v1', ''))).status, 200, 'visivel logo apos o 202, mesmo antes da projecao');
  assert.equal((await req('GET', `/agendamentos/${r.corpo.id}?versaoMinima=x`)).status, 400);
  assert.equal((await req('POST', '/agendamentos', { corpo, chave: 'k1' })).corpo.id, r.corpo.id);
  await ate(r.corpo.id, 'CONCLUIDA');
  assert.equal((await pool.query('SELECT count(*)::int n FROM saga_instances')).rows[0].n, 1);
  assert.equal((await req('GET', `/sagas/${r.corpo.sagaId}`)).corpo.historico.length, 4);
  assert.equal((await req('GET', `/sagas/${r.corpo.sagaId}`, { quem: outro })).status, 403);
  assert.equal((await req('GET', `/agendamentos/${r.corpo.id}`, { quem: outro })).status, 403);
  assert.equal((await req('POST', '/agendamentos', { corpo: { ...corpo, slotId: s2 }, quem: outro })).status, 403);
  assert.equal((await req('POST', '/agendamentos', { corpo, papel: null })).status, 403);
  for (const ruim of [{ sintomas: 'oi' }, { slotId: 'x' }, { slotId: randomUUID() }, { idade: 200 }]) assert.equal((await req('POST', '/agendamentos', { corpo: { ...corpo, ...ruim } })).status, 422, JSON.stringify(ruim));
});
