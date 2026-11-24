const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { criarApp } = require('../../../libs/comum/http');
const { dominioFalso, servir } = require('../../../libs/comum/teste-bff');
const { criarRotas } = require('../src/rotas');

const UBS = 'a1000000-0000-4000-8000-000000000001', GESTORA = 'd1000000-0000-4000-8000-000000000001';
const ID = { 'X-User-Id': GESTORA, 'X-User-Role': 'gestor' };
const ocupacao = (x = {}) => ({ ubsId: UBS, periodo: '2026-11', slotsTotais: 200, reservados: 150, ocupacaoPercentual: 75, porStatus: { AGENDADO: 100, FALTOU: 10, REALIZADO: 90 }, porUrgencia: { VERDE: 80 }, taxaAbsenteismo: 10, serieDiaria: [{ data: '2026-11-03', agendados: 5, faltas: 1 }], defasagemSegundos: 0.4, ...x });
let d, c;
const novo = async (CACHE_SEGUNDOS) => servir(criarApp({ nome: 'bff-admin', prefixo: '/', rotas: criarRotas({ PACIENTES_URL: d.url, AGENDAMENTO_URL: d.url, NOTIFICACOES_URL: d.url, TRIAGEM_URL: d.url, CACHE_SEGUNDOS }), essencial: 'bff', pronto: async () => ({ bff: 'up' }) }), ID);
before(async () => { d = await dominioFalso(); });
after(async () => { await d.fechar(); });
beforeEach(async (t) => {
  if (c) await c.fechar();
  c = await novo('30');
  d.pedidos.length = 0;
  d.respostas = {
    'GET /api/v1/relatorios/ocupacao': (url) => {
      const q = new URL(url, 'http://x').searchParams;
      if (q.get('periodo') === '2026-10') return ocupacao({ taxaAbsenteismo: 14 });
      return q.get('especialidade') === 'Pediatria' ? ocupacao({ porStatus: { AGENDADO: 40 }, ocupacaoPercentual: 60 }) : q.get('especialidade') ? ocupacao({ porStatus: {}, ocupacaoPercentual: 0 }) : ocupacao();
    },
    'GET /api/v1/ubs': [{ id: UBS, nome: 'UBS Centro', endereco: 'Rua', regiao: 'Zona Central' }],
    'GET /api/v1/profissionais': [{ id: 'b1', nome: 'Dra. Ana', especialidade: 'Clínica Geral' }, { id: 'b2', nome: 'Dr. Bruno', especialidade: 'Pediatria' }],
    'GET /api/v1/pacientes/estatisticas': { ubsId: UBS, totalPacientes: 120, porFaixaEtaria: { '18-59': 80 }, porBairro: { Centro: 100 } },
    'GET /api/v1/notificacoes/alertas': [{ tipo: 'GARGALO', ubsId: UBS, especialidade: 'Pediatria', dia: '2026-11-25', ocupacaoPercentual: 90, mensagem: 'm' }, { tipo: 'GARGALO', ubsId: 'outra', especialidade: 'x' }],
  };
});
after(async () => { await c.fechar(); });
const RESUMO = `/agendamentos/resumo?ubsId=${UBS}&periodo=2026-11`;

test('resumo agregado, sem dado pessoal, no formato do comparativo', async () => {
  const { status, corpo } = await c.pedir('GET', RESUMO);
  assert.equal(status, 200);
  assert.deepEqual(corpo.ubs, { id: UBS, nome: 'UBS Centro', regiao: 'Zona Central' });
  assert.deepEqual(corpo.capacidade, { slotsTotais: 200, reservados: 150, ocupacaoPercentual: 75 });
  assert.deepEqual(corpo.absenteismo, { taxa: 10, metaReducao: 30, tendencia: 'QUEDA' });
  assert.deepEqual(corpo.demandaPorEspecialidade, [{ especialidade: 'Pediatria', agendamentos: 40, ocupacao: 60 }]);
  assert.deepEqual([corpo.alertas.length, corpo.alertas[0].especialidade, corpo.pacientes.total, corpo.parcial, corpo.defasagemSegundos], [1, 'Pediatria', 120, false, 0.4]);
  for (const proibido of ['cpf', 'email', 'telefone', 'pacienteNome', 'pacienteId', '"nome":"Dra']) assert.ok(!JSON.stringify(corpo).includes(proibido), proibido);
});

test('tendencia compara com o mes anterior, inclusive na virada do ano', async () => {
  d.respostas['GET /api/v1/relatorios/ocupacao'] = (url) => ocupacao(url.includes('periodo=2025-12') ? { taxaAbsenteismo: 4 } : {});
  const r = await c.pedir('GET', RESUMO.replace('2026-11', '2026-01'));
  assert.equal(r.corpo.absenteismo.tendencia, 'ALTA');
  assert.ok(d.pedidos.some((p) => p.url.includes('periodo=2025-12')));
  d.respostas['GET /api/v1/relatorios/ocupacao'] = (url) => ocupacao(url.includes('periodo=2026-02') ? { porStatus: {}, taxaAbsenteismo: 0 } : {});
  assert.equal((await c.pedir('GET', RESUMO.replace('2026-11', '2026-03'))).corpo.absenteismo.tendencia, null); // sem atendimento antes, nao ha tendencia
});

for (const [nome, chave, campo] of [['Notificacoes', 'GET /api/v1/notificacoes/alertas', 'alertas'], ['Pacientes', 'GET /api/v1/pacientes/estatisticas', 'pacientes'], ['catalogo', 'GET /api/v1/profissionais', 'demandaPorEspecialidade']]) {
  test(`${nome} fora: resposta parcial, que nao fica no cache`, async () => {
    const boa = d.respostas[chave];
    d.respostas[chave] = [503, {}];
    let r = await c.pedir('GET', RESUMO);
    assert.deepEqual([r.status, r.corpo.parcial, r.corpo[campo], r.corpo.capacidade.slotsTotais], [200, true, null, 200]);
    d.respostas[chave] = boa;
    r = await c.pedir('GET', RESUMO);
    assert.deepEqual([r.corpo.parcial, r.headers.get('x-cache')], [false, 'MISS']);
  });
}

test('sem a ocupacao nao ha resumo', async () => {
  d.respostas['GET /api/v1/relatorios/ocupacao'] = [503, {}];
  assert.equal((await c.pedir('GET', RESUMO)).status, 503);
});

test('cache curto por unidade e periodo; criar escala limpa', async () => {
  await c.pedir('GET', RESUMO);
  const n = d.pedidos.length;
  assert.equal((await c.pedir('GET', RESUMO)).headers.get('x-cache'), 'HIT');
  assert.equal(d.pedidos.length, n);
  assert.equal((await c.pedir('GET', RESUMO.replace('2026-11', '2026-10'))).headers.get('x-cache'), 'MISS');
  d.respostas['POST /api/v1/escalas'] = [201, { slotsCriados: 8 }];
  const r = await c.pedir('POST', '/escalas', { diaSemana: 1 });
  assert.deepEqual([r.status, r.corpo, d.pedidos.at(-1).corpo], [201, { slotsCriados: 8 }, { diaSemana: 1 }]);
  assert.equal((await c.pedir('GET', RESUMO)).headers.get('x-cache'), 'MISS');
  const curto = await novo('0.2');
  await curto.pedir('GET', RESUMO);
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal((await curto.pedir('GET', RESUMO)).headers.get('x-cache'), 'MISS');
  await curto.fechar();
});

test('so gestor; parametros conferidos; recusa do dominio repassada', async () => {
  for (const h of [{}, { ...ID, 'X-User-Role': 'paciente' }, { 'X-User-Role': 'gestor' }]) assert.equal((await c.pedir('GET', RESUMO, undefined, h)).status, 403);
  for (const q of ['', '?ubsId=x&periodo=2026-11', `?ubsId=${UBS}&periodo=2026-13`]) assert.equal((await c.pedir('GET', `/agendamentos/resumo${q}`)).status, 400);
  d.respostas['POST /api/v1/escalas'] = [422, { title: 'Dados invalidos', detail: 'diaSemana' }];
  const r = await c.pedir('POST', '/escalas', {});
  assert.deepEqual([r.status, r.corpo.detail], [422, 'diaSemana']);
});

test('unidades e saude da IA', async () => {
  const u = (await c.pedir('GET', '/unidades')).corpo;
  assert.deepEqual([u.ubs.length, u.profissionais.length], [1, 2]);
  d.respostas['GET /api/v1/triagens/saude-llm'] = { circuito: 'FECHADO' };
  assert.equal((await c.pedir('GET', '/saude-ia')).corpo.circuito, 'FECHADO');
});
