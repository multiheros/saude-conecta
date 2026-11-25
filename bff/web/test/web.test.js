const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { criarApp } = require('../../../libs/comum/http');
const { dominioFalso, servir } = require('../../../libs/comum/teste-bff');
const { criarRotas } = require('../src/rotas');
const t = require('../src/textos');

const EU = 'c1000000-0000-4000-8000-000000000001', OUTRO = 'c1000000-0000-4000-8000-000000000002';
const UBS = 'a1000000-0000-4000-8000-000000000001', AG = 'e1000000-0000-4000-8000-000000000001', SAGA = 'f1000000-0000-4000-8000-000000000001';
const ID = { 'X-User-Id': EU, 'X-User-Role': 'paciente', 'X-Correlation-Id': 'corr-1' };
const agendamento = (x = {}) => ({
  id: AG, status: 'AGENDADO', pacienteId: EU, pacienteNome: 'Maria Demo', dataHora: '2026-11-04T12:30:00.000Z', especialidade: 'Clínica Geral', slotId: 's1',
  profissional: { id: 'b1', nome: 'Dra. Ana Souza' }, ubs: { id: UBS, nome: 'UBS Centro', endereco: 'Rua das Flores, 120' }, classificacaoUrgencia: 'AMARELO', sagaId: SAGA, versao: 2,
  _links: { self: { href: `/api/v1/agendamentos/${AG}`, method: 'GET' }, cancelar: { href: `/api/v1/agendamentos/${AG}/cancelamento`, method: 'POST' } }, ...x,
});
const em = (dias) => ({ dataHora: new Date(Date.now() + dias * 864e5).toISOString() });
let d, c;
before(async () => {
  d = await dominioFalso();
  c = await servir(criarApp({ nome: 'bff-web', prefixo: '/', rotas: criarRotas({ PACIENTES_URL: d.url, AGENDAMENTO_URL: d.url, TRIAGEM_URL: d.url }), essencial: 'bff', pronto: async () => ({ bff: 'up' }) }), ID);
});
after(async () => { await c.fechar(); await d.fechar(); });
beforeEach(() => {
  d.pedidos.length = 0; d.atraso = {};
  d.respostas = {
    [`GET /api/v1/pacientes/${EU}`]: { id: EU, nome: 'Maria Demo', cpf: '10000000108', dataNascimento: '1986-05-10', ubsReferenciaId: UBS },
    'GET /api/v1/agendamentos': { items: [agendamento(em(3)), agendamento(em(1)), agendamento(em(-1)), agendamento({ status: 'CANCELADO', ...em(2) })], total: 4 },
    [`GET /api/v1/agendamentos/${AG}`]: agendamento(),
    'GET /api/v1/triagens': { justificativa: 'Regra: dor intensa.', origem: 'REGRAS', fontes: [{ documento: 'Caderno', secao: '2.2 Cefaleia', pagina: 32 }, { documento: 'Protocolo', secao: 'Dor', pagina: null }] },
  };
});

test('detalhe: enxuto, com textos prontos, links do BFF e orientacoes', async () => {
  const { status, corpo } = await c.pedir('GET', `/agendamentos/${AG}`);
  assert.equal(status, 200);
  assert.deepEqual([corpo.titulo, corpo.quando, corpo.onde, corpo.profissional], ['Consulta de Clínica Geral', 'quarta, 04/11 às 09:30', 'UBS Centro — Rua das Flores, 120', 'Dra. Ana Souza']);
  assert.deepEqual(corpo.urgencia, { nivel: 'AMARELO', texto: 'Atendimento prioritário' });
  assert.deepEqual(corpo._links.cancelar, { href: `/web/v1/agendamentos/${AG}/cancelamento`, method: 'POST' });
  assert.equal(corpo._links.confirmar, undefined); // so as acoes que o dominio liberou
  assert.equal(corpo._links.andamento.href, `/web/v1/agendamentos/${AG}/andamento`);
  assert.deepEqual(corpo.triagem.fontes, ['Caderno, 2.2 Cefaleia, p. 32', 'Protocolo, Dor']);
  assert.ok(corpo.orientacoes.length);
  assert.ok(!JSON.stringify(corpo).includes('/api/v1') && corpo.pacienteId === undefined);
});

test('identidade e correlacao vao para o dominio, e o BFF tem barreira propria', async () => {
  const r = await c.pedir('GET', '/home');
  assert.equal(r.headers.get('x-correlation-id'), 'corr-1');
  for (const p of d.pedidos) assert.deepEqual([p.headers['x-user-id'], p.headers['x-user-role'], p.headers['x-correlation-id']], [EU, 'paciente', 'corr-1']);
  d.pedidos.length = 0;
  for (const h of [{}, { ...ID, 'X-User-Role': 'gestor' }, { ...ID, 'X-User-Id': 'x' }, { 'X-User-Role': 'paciente' }]) assert.equal((await c.pedir('GET', '/home', undefined, h)).status, 403);
  assert.equal(d.pedidos.length, 0);
});

test('home mostra so os ativos que ainda vao acontecer, por data, e abre mesmo com Agendamento fora', async () => {
  let r = await c.pedir('GET', '/home');
  assert.deepEqual([r.corpo.nome, r.corpo.proximos.length, r.corpo.parcial], ['Maria Demo', 2, undefined]);
  assert.ok(r.corpo.proximos[0].dataHora < r.corpo.proximos[1].dataHora);
  assert.ok(!JSON.stringify(r.corpo).includes('10000000108'));
  d.respostas['GET /api/v1/agendamentos'] = [503, {}];
  r = await c.pedir('GET', '/home');
  assert.deepEqual([r.status, r.corpo.proximos, r.corpo.parcial], [200, null, true]);
});

test('detalhe abre sem a Triagem; sem Agendamento, 503; travado, 504', async () => {
  d.respostas['GET /api/v1/triagens'] = [500, {}];
  assert.equal((await c.pedir('GET', `/agendamentos/${AG}`)).corpo.triagem, undefined);
  d.respostas[`GET /api/v1/agendamentos/${AG}`] = [503, { title: 'Consulta indisponível' }];
  const r = await c.pedir('GET', `/agendamentos/${AG}`);
  assert.deepEqual([r.status, r.headers.get('content-type').split(';')[0]], [503, 'application/problem+json']);
  d.atraso[`GET /api/v1/pacientes/${EU}`] = 4000;
  assert.equal((await c.pedir('GET', '/home')).status, 504);
});

test('agendar usa o cadastro, e nao o que vier no corpo', async () => {
  d.respostas['POST /api/v1/agendamentos'] = (_u, b) => [202, agendamento({ status: 'PENDENTE', versao: 0, pacienteId: b.pacienteId })];
  const r = await c.pedir('POST', '/agendamentos', { slotId: 's1', sintomas: 'dor de cabeca forte', pacienteId: OUTRO, idade: 3 }, { ...ID, 'Idempotency-Key': 'k1' });
  assert.deepEqual([r.status, r.headers.get('location'), r.corpo.status], [202, `/web/v1/agendamentos/${AG}?versaoMinima=0`, 'PENDENTE']);
  const p = d.pedidos.find((x) => x.chave === 'POST /api/v1/agendamentos');
  assert.deepEqual([p.corpo.pacienteId, p.corpo.idade, p.headers['idempotency-key']], [EU, t.idade('1986-05-10'), 'k1']);
});

test('recusa do dominio volta com o mesmo status e mensagem', async () => {
  d.respostas[`POST /api/v1/agendamentos/${AG}/confirmacao`] = [409, { title: 'Transição de estado inválida', detail: 'Agendamento CANCELADO.' }];
  const r = await c.pedir('POST', `/agendamentos/${AG}/confirmacao`);
  assert.deepEqual([r.status, r.corpo.title, r.corpo.detail], [409, 'Transição de estado inválida', 'Agendamento CANCELADO.']);
  assert.equal((await c.pedir('GET', '/agendamentos/nao-e-uuid')).status, 404);
  assert.equal((await c.pedir('POST', `/agendamentos/${AG}/comparecimento`)).status, 404); // acao do gestor
});

test('triagem usa idade e unidade do cadastro e traduz o resultado', async () => {
  d.respostas['POST /api/v1/triagens/recomendacoes'] = { classificacao: 'VERDE', justificativa: 'j', especialidadeSugerida: 'Clínica Geral', origem: 'LLM', orientacao: 'o', fontes: [], horarios: [{ slotId: 's1', inicio: '2026-11-04T12:30:00Z', especialidade: 'Clínica Geral', dentroDoPrazo: true }] };
  let { corpo } = await c.pedir('POST', '/triagem', { sintomas: 'dor de garganta', ubsId: OUTRO, idade: 2 });
  assert.deepEqual(d.pedidos.at(-1).corpo, { sintomas: 'dor de garganta', idade: t.idade('1986-05-10'), ubsId: UBS });
  assert.deepEqual([corpo.emergencia, corpo.horarios[0].quando, corpo._links.agendar.method], [false, 'quarta, 04/11 às 09:30', 'POST']);
  d.respostas['POST /api/v1/triagens/recomendacoes'] = { classificacao: 'VERMELHO', especialidadeSugerida: 'Clínica Geral', orientacao: 'Ligue 192', fontes: [], horarios: [] };
  ({ corpo } = await c.pedir('POST', '/triagem', { sintomas: 'nao consigo respirar' }));
  assert.deepEqual([corpo.emergencia, corpo._links], [true, {}]);
});

test('horarios da unidade do paciente, com nome do profissional quando houver', async () => {
  d.respostas['GET /api/v1/slots'] = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, inicio: '2026-11-04T12:30:00Z', especialidade: 'Pediatria', profissionalId: 'b1' }));
  d.respostas['GET /api/v1/profissionais'] = [{ id: 'b1', nome: 'Dra. Ana Souza' }];
  const { corpo } = await c.pedir('GET', `/horarios?especialidade=Pediatria&ubsId=${OUTRO}`);
  assert.deepEqual([corpo.horarios.length, corpo.horarios[0].profissional], [40, 'Dra. Ana Souza']);
  const q = new URL(d.pedidos.find((p) => p.chave === 'GET /api/v1/slots').url, 'http://x').searchParams;
  assert.deepEqual([q.get('ubsId'), q.get('especialidade')], [UBS, 'Pediatria']);
  d.respostas['GET /api/v1/profissionais'] = [500, {}];
  assert.equal((await c.pedir('GET', '/horarios')).status, 200);
  d.respostas[`GET /api/v1/pacientes/${EU}`].ubsReferenciaId = null;
  assert.equal((await c.pedir('GET', '/horarios')).status, 409);
});

test('andamento traduz os passos da SAGA', async () => {
  const h = (passo, tipo, resultado) => ({ passo, tipo, resultado });
  const ver = async (estado, historico, motivo) => {
    d.respostas[`GET /api/v1/sagas/${SAGA}`] = { id: SAGA, estado, motivo, historico };
    const { corpo } = await c.pedir('GET', `/agendamentos/${AG}/andamento`);
    return [corpo.terminou, ...corpo.passos.map((p) => p.situacao)];
  };
  const ok = (n) => ['1-triagem', '2-pacientes', '3-reserva', '4-notificacoes'].slice(0, n).map((p) => h(p, 'ACAO', 'OK'));
  assert.deepEqual(await ver('EM_ANDAMENTO', ok(2)), [false, 'CONCLUIDO', 'CONCLUIDO', 'AGUARDANDO', 'AGUARDANDO']);
  assert.ok(d.pedidos.some((p) => p.url.endsWith(`${AG}?versaoMinima=0`))); // espera a projecao
  assert.deepEqual(await ver('CONCLUIDA', ok(4)), [true, 'CONCLUIDO', 'CONCLUIDO', 'CONCLUIDO', 'CONCLUIDO']);
  assert.deepEqual(await ver('COMPENSANDO', [...ok(3), h('4-notificacoes', 'ACAO', 'FALHA'), h('3-reserva', 'COMPENSACAO', 'OK'), h('2-pacientes', 'COMPENSACAO', 'PENDENTE')]), [false, 'CONCLUIDO', 'CONCLUIDO', 'DESFEITO', 'FALHOU']);
  assert.deepEqual(await ver('FALHOU', [h('1-triagem', 'ACAO', 'OK'), h('2-pacientes', 'ACAO', 'FALHA'), h('1-triagem', 'COMPENSACAO', 'OK')]), [true, 'DESFEITO', 'FALHOU', 'NAO_EXECUTADO', 'NAO_EXECUTADO']);
});

test('idade vira no dia do aniversario', () => {
  assert.equal(t.idade('2000-11-24', new Date(2026, 10, 23)), 25);
  assert.equal(t.idade('2000-11-24', new Date(2026, 10, 24)), 26);
});
