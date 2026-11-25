// Testes de integracao contra PostgreSQL e RabbitMQ reais e descartaveis.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { randomUUID, generateKeyPairSync } = require('crypto');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const { criarPool, migrar, transacao, umaVez } = require('../../../libs/comum/db');
const { criarApp } = require('../../../libs/comum/http');
const { criarConsumidor } = require('../../../libs/comum/consumidor');
const { criarPublicador } = require('../../../libs/comum/broker');
const outbox = require('../../../libs/comum/outbox');
const { criarRotas } = require('../src/rotas');
const { tratarEvento } = require('../src/pacientes');
const { semear, GESTOR, idPaciente, cpfPaciente, CENTRO } = require('../src/seed');
const { completarCpf } = require('../src/cpf');

const pool = criarPool();
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const FILA = 'pacientes.agendamento', P1 = idPaciente(1), P2 = idPaciente(2);
let server, base, cx, canal, consumidor;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const ate = async (fn, msg) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await dormir(50); } assert.fail(msg); };

before(async () => {
  for (let i = 0; ; i++) { try { await pool.query('SELECT 1'); break; } catch (e) { if (i > 30) throw e; await dormir(500); } }
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrar(pool, path.join(__dirname, '..', 'migrations'));
  assert.equal(await semear(pool, 'demo12345'), true);
  server = criarApp({ nome: 'teste', rotas: criarRotas({ pool, chavePrivada: privateKey }), pronto: async () => ({ db: 'up' }) }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  cx = await amqp.connect({ protocol: 'amqp', hostname: process.env.RABBITMQ_HOST, username: process.env.RABBITMQ_USER, password: process.env.RABBITMQ_PASSWORD });
  canal = await cx.createChannel();
  consumidor = criarConsumidor({ fila: FILA, pausaMs: 20, tratar: (e) => umaVez(pool, 'pacientes', e.eventId, (c) => tratarEvento(c, e)) });
  await consumidor.iniciar();
});
beforeEach(async () => {
  await pool.query('UPDATE pacientes SET agendamento_saga_id=NULL, ativo=true; TRUNCATE sagas_encerradas, atendimentos, processed_events, outbox_events');
  await canal.purgeQueue(`${FILA}.dlq`);
});
after(async () => { await consumidor.fechar(); await cx.close(); server.close(); await pool.end(); });

async function chamar(metodo, caminho, { corpo, papel, usuario, saga } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (papel) headers['X-User-Role'] = papel;
  if (usuario) headers['X-User-Id'] = usuario;
  if (saga) headers['X-Saga-Id'] = saga;
  const r = await fetch(base + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const t = await r.text();
  return { status: r.status, headers: r.headers, corpo: t ? JSON.parse(t) : null };
}
const flag = async (id) => (await pool.query('SELECT agendamento_saga_id f FROM pacientes WHERE id=$1', [id])).rows[0].f;
const validar = (id, saga) => chamar('POST', `/pacientes/${id}/validacao`, { papel: 'servico', saga });
const reverter = (id, saga) => chamar('DELETE', `/pacientes/${id}/validacao`, { papel: 'servico', saga });
const novo = (extra) => ({ nome: 'Teste Silva', cpf: completarCpf(String(Math.floor(Math.random() * 8e8) + 1e8)), dataNascimento: '1990-01-01', email: 't@exemplo.com', senha: 'segredo123', ...extra });
const evento = (eventType, payload, extra) => ({ eventId: randomUUID(), eventType, aggregateVersion: 1, payload, ...extra });
const publicar = (e) => canal.publish('saudeconecta.events', { AgendamentoCriado: 'agendamento.agendamento.criado', AtendimentoRealizado: 'agendamento.agendamento.realizado', FaltaRegistrada: 'agendamento.agendamento.faltou' }[e.eventType], Buffer.from(typeof e === 'string' ? e : JSON.stringify(e)));
const dlq = async () => (await canal.checkQueue(`${FILA}.dlq`)).messageCount;

test('login emite JWT RS256 com perfil, e nao diferencia CPF de senha errada', async () => {
  const ok = await chamar('POST', '/auth/login', { corpo: { cpf: cpfPaciente(1), senha: 'demo12345' } });
  assert.equal(ok.status, 200);
  const t = jwt.verify(ok.corpo.accessToken, publicKey, { algorithms: ['RS256'], audience: 'saudeconecta', issuer: 'saudeconecta-paciente' });
  assert.deepEqual([t.sub, t.role, t.exp - t.iat], [P1, 'paciente', 3600]);
  const g = await chamar('POST', '/auth/login', { corpo: { cpf: GESTOR.cpf, senha: 'demo12345' } });
  assert.equal(jwt.verify(g.corpo.accessToken, publicKey).role, 'gestor');
  const a = await chamar('POST', '/auth/login', { corpo: { cpf: cpfPaciente(1), senha: 'errada123' } });
  const b = await chamar('POST', '/auth/login', { corpo: { cpf: '12345678909', senha: 'demo12345' } });
  assert.deepEqual([a.status, b.status, a.corpo.title], [401, 401, b.corpo.title]);
  assert.equal((await chamar('POST', '/auth/login', { corpo: {} })).status, 401);
  await pool.query('UPDATE pacientes SET ativo=false WHERE id=$1', [P1]);
  assert.equal((await chamar('POST', '/auth/login', { corpo: { cpf: cpfPaciente(1), senha: 'demo12345' } })).status, 401);
});

test('cadastro: valida, cria, recusa CPF repetido e nunca expoe a senha', async () => {
  const d = novo();
  const r = await chamar('POST', '/pacientes', { corpo: d });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('location'), `/api/v1/pacientes/${r.corpo.id}`);
  assert.equal(r.corpo.dataNascimento, '1990-01-01');
  assert.ok(!JSON.stringify(r.corpo).match(/senha|scrypt/));
  assert.equal((await chamar('POST', '/pacientes', { corpo: novo({ cpf: d.cpf }) })).status, 409);
  assert.equal((await chamar('POST', '/auth/login', { corpo: { cpf: d.cpf, senha: 'segredo123' } })).status, 200);
  for (const ruim of [{ cpf: '12345678900' }, { cpf: '11111111111' }, { email: 'x' }, { senha: 'curta' }, { nome: 'a' }, { dataNascimento: '2030-01-01' }, { dataNascimento: '1990-02-30' }, { ubsReferenciaId: 'x' }, { telefone: 'abc' }, { telefone: ['+5535900000001'] }, { dataNascimento: ['1990-01-01'] }, { nome: 'Ma\u0000ria' }]) {
    assert.equal((await chamar('POST', '/pacientes', { corpo: novo(ruim) })).status, 422, JSON.stringify(ruim));
  }
  await pool.query('DELETE FROM pacientes WHERE id=$1', [r.corpo.id]);
});

test('cadastros simultaneos do mesmo CPF: um vence', async () => {
  const cpf = novo().cpf;
  const r = await Promise.all(Array.from({ length: 5 }, () => chamar('POST', '/pacientes', { corpo: novo({ cpf }) })));
  assert.deepEqual(r.map((x) => x.status).sort(), [201, 409, 409, 409, 409]);
  await pool.query('DELETE FROM pacientes WHERE cpf=$1', [cpf]);
});

test('cliente nao escolhe o proprio id nem o perfil no cadastro', async () => {
  const id = randomUUID();
  const r = await chamar('POST', '/pacientes', { corpo: novo({ id, perfil: 'gestor', ativo: false }) });
  assert.notEqual(r.corpo.id, id);
  assert.equal(r.corpo.ativo, true);
  await pool.query('DELETE FROM pacientes WHERE id=$1', [r.corpo.id]);
});

test('acesso: cada paciente so ve o seu; lista e estatisticas sao do gestor', async () => {
  assert.equal((await chamar('GET', `/pacientes/${P1}`, { papel: 'paciente', usuario: P1 })).status, 200);
  assert.equal((await chamar('GET', `/pacientes/${P1}`, { papel: 'paciente', usuario: P2 })).status, 403);
  assert.equal((await chamar('GET', `/pacientes/${P1}`)).status, 403);
  assert.equal((await chamar('PUT', `/pacientes/${P1}`, { papel: 'paciente', usuario: P2, corpo: { nome: 'Outro' } })).status, 403);
  assert.equal((await chamar('GET', `/pacientes/${P1}/historico`, { papel: 'paciente', usuario: P2 })).status, 403);
  assert.equal((await chamar('GET', '/pacientes', { papel: 'paciente', usuario: P1 })).status, 403);
  assert.equal((await chamar('GET', `/pacientes/estatisticas?ubsId=${CENTRO}`, { papel: 'paciente', usuario: P1 })).status, 403);
  assert.equal((await chamar('GET', '/pacientes?size=5', { papel: 'gestor' })).corpo.items.length, 5);
  assert.equal((await chamar('GET', '/pacientes?size=500', { papel: 'gestor' })).status, 400);
});

test('validacao da SAGA so e aceita da rede interna', async () => {
  for (const papel of [undefined, 'paciente', 'gestor']) {
    assert.equal((await chamar('POST', `/pacientes/${P1}/validacao`, { papel, usuario: P1, saga: randomUUID() })).status, 403);
    assert.equal((await chamar('DELETE', `/pacientes/${P1}/validacao`, { papel, usuario: P1, saga: randomUUID() })).status, 403);
  }
  assert.equal((await chamar('POST', `/pacientes/${P1}/validacao`, { papel: 'servico' })).status, 400);
});

test('SAGA passo 2: idempotente, exclusivo por paciente, e compensa so o proprio', async () => {
  const a = randomUUID(), b = randomUUID();
  assert.equal((await validar(P1, a)).status, 200);
  assert.equal((await validar(P1, a)).status, 200);
  assert.equal((await validar(P1, b)).status, 409);
  assert.equal((await reverter(P1, b)).status, 204);
  assert.equal(await flag(P1), a, 'outra SAGA não pode limpar a flag');
  assert.equal((await reverter(P1, a)).status, 204);
  assert.equal((await reverter(P1, a)).status, 204);
  assert.equal(await flag(P1), null);
  assert.equal((await validar(randomUUID(), a)).status, 404);
  await pool.query('UPDATE pacientes SET ativo=false WHERE id=$1', [P1]);
  assert.equal((await validar(P1, randomUUID())).status, 409);
});

test('pedido atrasado, entregue depois da compensacao, nao prende o paciente', async () => {
  const a = randomUUID();
  await reverter(P1, a);
  assert.equal((await validar(P1, a)).status, 409);
  assert.equal(await flag(P1), null);
});

test('validacoes simultaneas de SAGAs diferentes: uma vence', async () => {
  const r = await Promise.all(Array.from({ length: 6 }, () => validar(P1, randomUUID())));
  assert.equal(r.filter((x) => x.status === 200).length, 1);
});

test('AgendamentoCriado limpa a flag da propria SAGA: o paciente pode agendar de novo', async () => {
  const a = randomUUID(), b = randomUUID();
  await validar(P1, a);
  publicar(evento('AgendamentoCriado', { pacienteId: P1, sagaId: randomUUID() }));
  publicar(evento('AgendamentoCriado', { pacienteId: P1, sagaId: a }));
  await ate(async () => (await flag(P1)) === null, 'flag nao foi limpa');
  assert.equal((await validar(P1, b)).status, 200);
});

test('evento repetido tem efeito uma vez; historico reflete atendimento e falta', async () => {
  const p = (id) => ({ agendamentoId: id, pacienteId: P1, slot: { inicio: '2026-11-01T12:00:00Z' }, profissional: { especialidade: 'Pediatria' }, ubs: { nome: 'UBS Centro' } });
  const e = evento('AtendimentoRealizado', p(randomUUID()));
  publicar(e); publicar(e); publicar(evento('FaltaRegistrada', p(randomUUID())));
  await ate(async () => (await pool.query('SELECT count(*)::int n FROM processed_events')).rows[0].n === 2, 'eventos nao processados');
  const h = (await chamar('GET', `/pacientes/${P1}/historico`, { papel: 'paciente', usuario: P1 })).corpo;
  assert.deepEqual(h.map((x) => x.status).sort(), ['FALTOU', 'REALIZADO']);
});

test('umaVez: efeito unico por evento, e falha permite nova tentativa', async () => {
  const id = randomUUID();
  let n = 0;
  await assert.rejects(umaVez(pool, 't', id, async () => { throw new Error('falhou'); }), /falhou/);
  await Promise.all(Array.from({ length: 5 }, () => umaVez(pool, 't', id, async () => { n++; })));
  assert.equal(n, 1);
  assert.equal(await umaVez(pool, 'outro', id, async () => { n++; }), true);
});

test('mensagem defeituosa vai para a DLQ e não trava a fila', async () => {
  const a = randomUUID();
  await validar(P1, a);
  canal.publish('saudeconecta.events', 'agendamento.agendamento.criado', Buffer.from('nao e json'));
  publicar(evento('AtendimentoRealizado', { agendamentoId: 'x' }));
  publicar(evento('AgendamentoCriado', { pacienteId: P1, sagaId: a }));
  await ate(async () => (await flag(P1)) === null, 'fila travada');
  await ate(async () => (await dlq()) === 2, 'DLQ vazia');
});

test('falha transitoria (banco fora) insiste em vez de descartar', async () => {
  let n = 0, feito = false;
  await consumidor.fechar();
  const c = criarConsumidor({ fila: FILA, pausaMs: 5, tratar: async () => { if (++n < 8) throw Object.assign(new Error('fora'), { code: 'ECONNREFUSED' }); feito = true; } });
  await c.iniciar();
  publicar(evento('AgendamentoCriado', {}));
  await ate(async () => feito, 'desistiu');
  assert.equal(await dlq(), 0);
  await c.fechar();
  consumidor = criarConsumidor({ fila: FILA, pausaMs: 20, tratar: (e) => umaVez(pool, 'pacientes', e.eventId, (x) => tratarEvento(x, e)) });
  await consumidor.iniciar();
});

test('estatisticas: so agregados, grupos pequenos ocultos e sem vazar por subtracao', async () => {
  const r = (await chamar('GET', `/pacientes/estatisticas?ubsId=${CENTRO}`, { papel: 'gestor' })).corpo;
  assert.ok(!/Demo|exemplo|\d{11}/.test(JSON.stringify({ ...r, ubsId: undefined })));
  assert.equal(r.porFaixaEtaria['0-11'], undefined, 'grupo com 1 crianca deve ser oculto');
  for (const n of [r.totalPacientes, ...Object.values(r.porFaixaEtaria), ...Object.values(r.porBairro)]) assert.equal(n % 5, 0);
  const vazia = (await chamar('GET', `/pacientes/estatisticas?ubsId=${randomUUID()}`, { papel: 'gestor' })).corpo;
  assert.equal(vazia.totalPacientes, 0);
});

test('atualizar perfil publica PacienteAtualizado so com o necessario, e chega ao RabbitMQ', async () => {
  const r = await chamar('PUT', `/pacientes/${P2}`, { papel: 'paciente', usuario: P2, corpo: { nome: 'Nome Novo', cpf: '00000000000' } });
  assert.deepEqual([r.status, r.corpo.nome, r.corpo.cpf], [200, 'Nome Novo', cpfPaciente(2)]);
  const { rows: [e] } = await pool.query('SELECT payload FROM outbox_events');
  assert.deepEqual(e.payload, { pacienteId: P2, nome: 'Nome Novo' });
  const pub = criarPublicador();
  await pub.iniciar();
  await canal.purgeQueue('agendamento.pacientes');
  assert.equal(await outbox.publicarLote(pool, pub), 1);
  const m = await canal.get('agendamento.pacientes', { noAck: true });
  assert.equal(JSON.parse(m.content).payload.nome, 'Nome Novo');
  await assert.rejects(pub.publicar('rota.sem.fila', { eventId: randomUUID() }), /sem fila de destino/);
  await pub.fechar();
});

test('cadastro que falha nao deixa evento para tras', async () => {
  await assert.rejects(transacao(pool, async (c) => {
    await require('../src/pacientes').cadastrar(c, {}, novo(), 'h');
    throw new Error('queda');
  }), /queda/);
  assert.equal((await pool.query('SELECT 1 FROM outbox_events')).rowCount, 0);
});
