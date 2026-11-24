// Testes de integracao contra um Redis real e descartavel.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { criarApp } = require('../../../libs/comum/http');
const { criarLoja } = require('../src/loja');
const { criarRotas } = require('../src/rotas');

const loja = criarLoja();
const H = 3600e3;
let server, base;

before(async () => {
  server = criarApp({ nome: 'teste', rotas: criarRotas({ loja }), pronto: async () => ({ db: 'up' }) }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
});
beforeEach(() => loja.redis.flushdb());
after(async () => { server.close(); await loja.fechar(); });

async function chamar(metodo, caminho, { corpo, papel, usuario, saga } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (papel) headers['X-User-Role'] = papel;
  if (usuario) headers['X-User-Id'] = usuario;
  if (saga) headers['X-Saga-Id'] = saga;
  const r = await fetch(base + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const t = await r.text();
  return { status: r.status, corpo: t ? JSON.parse(t) : null };
}
const pedido = (emHoras = 72) => ({ pacienteId: randomUUID(), agendamentoId: randomUUID(), sagaId: randomUUID(), dataConsulta: new Date(Date.now() + emHoras * H).toISOString() });
const criar = (d) => chamar('POST', '/notificacoes', { papel: 'servico', saga: d.sagaId, corpo: { pacienteId: d.pacienteId, agendamentoId: d.agendamentoId, dataConsulta: d.dataConsulta } });
const ev = (eventType, d, aggregateVersion, extra) => ({ eventId: randomUUID(), eventType, aggregateVersion, payload: { agendamentoId: d.agendamentoId, pacienteId: d.pacienteId, sagaId: d.sagaId, slot: { inicio: d.dataConsulta }, ...extra } });
const situacao = async (d) => (await loja.doPaciente(d.pacienteId)).map((n) => `${n.tipo}:${n.status}`).sort();
const enviadas = async (agora) => { const l = []; await loja.enviarVencidas(async (n) => l.push(n.tipo), agora); return l; };

test('passo 4: cria confirmacao e lembretes, idempotente por SAGA', async () => {
  const d = pedido();
  const a = await criar(d), b = await criar(d);
  assert.equal(a.status, 201);
  assert.deepEqual(a.corpo.map((n) => n.tipo), ['CONFIRMACAO', 'LEMBRETE_24H', 'LEMBRETE_2H']);
  assert.deepEqual(a.corpo, b.corpo);
});

test('pedidos simultaneos da mesma SAGA nao duplicam', async () => {
  const d = pedido();
  await Promise.all(Array.from({ length: 8 }, () => criar(d)));
  assert.equal((await loja.doPaciente(d.pacienteId)).length, 3);
});

test('lembrete cujo horario ja passou nao e criado', async () => {
  assert.deepEqual((await criar(pedido(10))).corpo.map((n) => n.tipo), ['CONFIRMACAO', 'LEMBRETE_2H']);
  assert.deepEqual((await criar(pedido(1))).corpo.map((n) => n.tipo), ['CONFIRMACAO']);
});

test('nada e enviado antes de a SAGA concluir', async () => {
  const d = pedido();
  await criar(d);
  assert.deepEqual(await enviadas(Date.now() + 100 * H), []);
  await loja.tratarEvento(ev('AgendamentoCriado', d, 2));
  assert.deepEqual(await enviadas(Date.now() + 1), ['CONFIRMACAO']);
  assert.deepEqual(await situacao(d), ['CONFIRMACAO:ENVIADA', 'LEMBRETE_24H:AGENDADA', 'LEMBRETE_2H:AGENDADA']);
});

test('compensacao cancela todas as da SAGA, so dela, e pode repetir', async () => {
  const a = pedido(), b = pedido();
  await criar(a); await criar(b);
  for (let i = 0; i < 2; i++) assert.equal((await chamar('DELETE', `/notificacoes?sagaId=${a.sagaId}`, { papel: 'servico' })).status, 204);
  assert.deepEqual(await situacao(a), ['CONFIRMACAO:CANCELADA', 'LEMBRETE_24H:CANCELADA', 'LEMBRETE_2H:CANCELADA']);
  assert.ok((await situacao(b)).every((s) => s.endsWith('AGENDADA')));
  await loja.tratarEvento(ev('AgendamentoCriado', a, 2));
  assert.deepEqual(await enviadas(Date.now() + 100 * H), []);
});

test('pedido atrasado, entregue depois da compensacao, e recusado', async () => {
  const d = pedido();
  await chamar('DELETE', `/notificacoes?sagaId=${d.sagaId}`, { papel: 'servico' });
  assert.equal((await criar(d)).status, 409);
  assert.deepEqual(await situacao(d), []);
});

test('cada notificacao sai no maximo uma vez, com varios envios em paralelo', async () => {
  const ds = Array.from({ length: 20 }, () => pedido());
  for (const d of ds) { await criar(d); await loja.tratarEvento(ev('AgendamentoCriado', d, 2)); }
  const l = [];
  await Promise.all(Array.from({ length: 6 }, () => loja.enviarVencidas(async (n) => l.push(n.id), Date.now() + 1)));
  assert.equal(l.length, 20);
  assert.equal(new Set(l).size, 20);
});

test('cancelamento retira lembretes; evento antigo que chega depois e ignorado', async () => {
  const d = pedido();
  await criar(d);
  await loja.tratarEvento(ev('AgendamentoCancelado', d, 3));
  await loja.tratarEvento(ev('AgendamentoCriado', d, 2));
  assert.deepEqual(await enviadas(Date.now() + 100 * H), []);
  assert.ok((await situacao(d)).every((s) => s.endsWith('CANCELADA')));
});

test('reagendamento refaz os lembretes para a nova data, uma vez', async () => {
  const d = pedido(72);
  await criar(d);
  await loja.tratarEvento(ev('AgendamentoCriado', d, 2));
  const nova = { ...d, dataConsulta: new Date(Date.now() + 200 * H).toISOString() };
  const e = ev('AgendamentoReagendado', nova, 3);
  await loja.tratarEvento(e); await loja.tratarEvento(e);
  const ativas = (await loja.doPaciente(d.pacienteId, 'AGENDADA'));
  assert.deepEqual(ativas.map((n) => n.tipo), ['CONFIRMACAO', 'LEMBRETE_24H', 'LEMBRETE_2H']);
  assert.equal(ativas[2].enviarEm, new Date(new Date(nova.dataConsulta) - 2 * H).toISOString());
});

test('reagendamento antigo que chega atrasado nao sobrepoe o mais novo', async () => {
  const d = pedido(72);
  await criar(d);
  await loja.tratarEvento(ev('AgendamentoCriado', d, 2));
  const em = (h) => ({ ...d, dataConsulta: new Date(Date.now() + h * H).toISOString() });
  const novo = em(300);
  await loja.tratarEvento(ev('AgendamentoReagendado', novo, 4));
  await loja.tratarEvento(ev('AgendamentoReagendado', em(200), 3));
  await loja.tratarEvento(ev('AgendamentoReagendado', novo, 4));
  const ativas = await loja.doPaciente(d.pacienteId, 'AGENDADA');
  assert.equal(ativas.length, 3);
  assert.equal(ativas[2].enviarEm, new Date(new Date(novo.dataConsulta) - 2 * H).toISOString());
  assert.equal((await loja.doPaciente(d.pacienteId)).length, 6, 'evento repetido não pode criar mais');
});

test('preferencias definem canal e antecedencia', async () => {
  const d = pedido(72), url = `/pacientes/${d.pacienteId}/preferencias-notificacao`, eu = { papel: 'paciente', usuario: d.pacienteId };
  assert.deepEqual((await chamar('GET', url, eu)).corpo, { canais: ['SMS'], antecedenciaLembreteHoras: 24 });
  assert.equal((await chamar('PUT', url, { ...eu, corpo: { canais: ['POMBO'] } })).status, 422);
  assert.equal((await chamar('PUT', url, { ...eu, corpo: { canais: [] } })).status, 422);
  assert.equal((await chamar('PUT', url, { ...eu, corpo: { canais: ['EMAIL'], antecedenciaLembreteHoras: 48 } })).status, 200);
  assert.equal((await chamar('GET', url, { papel: 'paciente', usuario: randomUUID() })).status, 403);
  const l = (await criar(d)).corpo.find((n) => n.tipo === 'LEMBRETE_24H');
  assert.deepEqual([l.canal, l.enviarEm], ['EMAIL', new Date(new Date(d.dataConsulta) - 48 * H).toISOString()]);
});

test('permissoes e validacao', async () => {
  const d = pedido();
  const n = (await criar(d)).corpo[0];
  for (const papel of [undefined, 'paciente', 'gestor']) {
    assert.equal((await chamar('POST', '/notificacoes', { papel, saga: d.sagaId, corpo: {} })).status, 403);
    assert.equal((await chamar('DELETE', `/notificacoes?sagaId=${d.sagaId}`, { papel })).status, 403);
  }
  assert.equal((await chamar('DELETE', '/notificacoes', { papel: 'servico' })).status, 400);
  assert.equal((await chamar('POST', '/notificacoes', { papel: 'servico', corpo: {} })).status, 400);
  assert.equal((await chamar('POST', '/notificacoes', { papel: 'servico', saga: d.sagaId, corpo: { pacienteId: 'x' } })).status, 422);
  assert.equal((await chamar('GET', `/notificacoes/${n.id}`, { papel: 'paciente', usuario: d.pacienteId })).status, 200);
  assert.equal((await chamar('GET', `/notificacoes/${n.id}`, { papel: 'paciente', usuario: randomUUID() })).status, 403);
  assert.equal((await chamar('GET', `/notificacoes?pacienteId=${d.pacienteId}`, { papel: 'paciente', usuario: randomUUID() })).status, 403);
  assert.equal((await chamar('GET', `/notificacoes/${randomUUID()}`, { papel: 'gestor' })).status, 404);
  assert.equal((await chamar('GET', '/notificacoes/alertas', { papel: 'paciente', usuario: d.pacienteId })).status, 403);
});

test('alerta de gargalo a partir de 85% no dia, tolerante a repeticao e desordem', async () => {
  const ubsId = randomUUID(), especialidade = 'Pediatria', inicio = new Date(Date.now() + 48 * H).toISOString();
  const slots = Array.from({ length: 8 }, () => ({ id: randomUUID(), inicio, fim: inicio, version: 0 }));
  const vaga = (tipo, s, v) => loja.tratarEvento({ eventType: tipo, aggregateVersion: v, payload: { slotId: s.id, ubsId, especialidade, inicio, fim: inicio } });
  const escala = { eventType: 'EscalaCriada', aggregateVersion: 1, payload: { ubs: { id: ubsId }, profissional: { especialidade }, slots } };
  await loja.tratarEvento(escala); await loja.tratarEvento(escala);
  for (const s of slots.slice(0, 6)) { await vaga('SlotReservado', s, 1); await vaga('SlotReservado', s, 1); }
  assert.deepEqual(await loja.alertas(), [], '75% ainda nao e gargalo');
  await vaga('SlotReservado', slots[6], 1);
  const [a] = (await chamar('GET', '/notificacoes/alertas', { papel: 'gestor' })).corpo;
  assert.deepEqual([a.tipo, a.ubsId, a.ocupacaoPercentual], ['GARGALO', ubsId, 87.5]);
  await vaga('SlotLiberado', slots[6], 2);
  await vaga('SlotReservado', slots[6], 1);
  assert.deepEqual(await loja.alertas(), [], 'reserva antiga nao pode reocupar a vaga liberada');
});
