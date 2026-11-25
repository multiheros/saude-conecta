// BFF do paciente: dados do proprio titular, enxutos e prontos para agir. Nao decide regra de negocio.
const express = require('express');
const { UUID, rota } = require('../../../libs/comum/http');
const { Problema } = require('../../../libs/comum/erros');
const { exigir, pedir, opcional } = require('../../../libs/comum/bff');
const t = require('./textos');

const BASE = '/web/v1';
const TEMPO_TRIAGEM = 14000; // a recomendacao tem teto de 12 s
const ORIENTACOES = ['Leve cartão SUS e documento com foto', 'Chegue 15 minutos antes'];

function criarRotas(env = process.env) {
  const PAC = `${env.PACIENTES_URL}/api/v1`, AGE = `${env.AGENDAMENTO_URL}/api/v1`, TRI = `${env.TRIAGEM_URL}/api/v1`;
  const r = express.Router();
  r.use(exigir('paciente'));
  r.param('id', (_req, _res, next, id) => next(UUID.test(id) ? undefined : new Problema(404, 'Agendamento não encontrado')));
  const eu = (req) => req.get('X-User-Id');
  const paciente = (req) => pedir(req, 'GET', `${PAC}/pacientes/${eu(req)}`);
  const link = (href, method = 'GET') => ({ href: BASE + href, method });

  // Os links vem do dominio (que sabe quais acoes valem agora); aqui so muda o endereco.
  function cartao(a) {
    const _links = Object.fromEntries(Object.entries(a._links || {}).map(([k, v]) => [k, { ...v, href: v.href.replace('/api/v1', BASE) }]));
    if (a.sagaId) _links.andamento = link(`/agendamentos/${a.id}/andamento`);
    return {
      id: a.id, status: a.status, statusTexto: t.STATUS[a.status], motivo: a.motivo || undefined,
      titulo: `Consulta de ${a.especialidade}`, quando: t.quando(a.dataHora), dataHora: a.dataHora,
      onde: a.ubs && `${a.ubs.nome} — ${a.ubs.endereco}`, profissional: a.profissional && a.profissional.nome,
      urgencia: t.urgencia(a.classificacaoUrgencia), versao: a.versao, _links,
    };
  }
  const horario = (nomes) => (s) => ({ slotId: s.slotId || s.id, quando: t.quando(s.inicio), dataHora: s.inicio, especialidade: s.especialidade, profissional: nomes[s.profissionalId] });

  r.get('/home', rota(async (req, res) => {
    const [p, l] = await Promise.all([
      paciente(req),
      opcional(pedir(req, 'GET', `${AGE}/agendamentos?pacienteId=${eu(req)}&size=100`)),
    ]);
    const ativos = l && l.items.filter((a) => ['PENDENTE', 'AGENDADO', 'CONFIRMADO'].includes(a.status) && new Date(a.dataHora) > new Date())
      .sort((a, b) => new Date(a.dataHora) - new Date(b.dataHora));
    res.json({
      nome: p.nome, proximos: ativos && ativos.map(cartao), parcial: l === null || undefined,
      _links: { triagem: link('/triagem', 'POST'), horarios: link('/horarios'), agendar: link('/agendamentos', 'POST'), agendamentos: link('/agendamentos') },
    });
  }));

  // Queixa -> urgencia, orientacao e horarios. Nada e gravado.
  r.post('/triagem', rota(async (req, res) => {
    const { sintomas } = req.body || {};
    const p = await paciente(req);
    if (!p.ubsReferenciaId) throw new Problema(409, 'Sem unidade de referência', 'Procure uma UBS para vincular o seu cadastro.');
    const x = await pedir(req, 'POST', `${TRI}/triagens/recomendacoes`, { corpo: { sintomas, idade: t.idade(p.dataNascimento), ubsId: p.ubsReferenciaId }, timeoutMs: TEMPO_TRIAGEM });
    res.json({
      urgencia: t.urgencia(x.classificacao), justificativa: x.justificativa, especialidade: x.especialidadeSugerida, orientacao: x.orientacao,
      emergencia: x.classificacao === 'VERMELHO', origem: x.origem,
      horarios: x.horarios.map((h) => ({ ...horario({})(h), dentroDoPrazo: h.dentroDoPrazo })), fontes: x.fontes.map(t.fonte),
      _links: x.classificacao === 'VERMELHO' ? {} : { agendar: link('/agendamentos', 'POST'), horarios: link(`/horarios?especialidade=${encodeURIComponent(x.especialidadeSugerida)}`) },
    });
  }));

  r.get('/horarios', rota(async (req, res) => {
    const p = await paciente(req);
    if (!p.ubsReferenciaId) throw new Problema(409, 'Sem unidade de referência', 'Procure uma UBS para vincular o seu cadastro.');
    const q = new URLSearchParams({ ubsId: p.ubsReferenciaId });
    for (const k of ['especialidade', 'dataInicio', 'dataFim']) if (typeof req.query[k] === 'string') q.set(k, req.query[k]);
    const [slots, profs] = await Promise.all([pedir(req, 'GET', `${AGE}/slots?${q}`), opcional(pedir(req, 'GET', `${AGE}/profissionais`))]);
    const nomes = Object.fromEntries((profs || []).map((x) => [x.id, x.nome]));
    res.json({ horarios: slots.slice(0, 40).map(horario(nomes)) });
  }));

  r.get('/agendamentos', rota(async (req, res) => {
    const l = await pedir(req, 'GET', `${AGE}/agendamentos?pacienteId=${eu(req)}&size=50`);
    res.json({ items: l.items.map(cartao), total: l.total });
  }));

  // Paciente e idade vem do cadastro, nunca do corpo da requisicao.
  r.post('/agendamentos', rota(async (req, res) => {
    const { slotId, sintomas } = req.body || {};
    const p = await paciente(req);
    const chave = req.get('Idempotency-Key');
    const a = await pedir(req, 'POST', `${AGE}/agendamentos`, { corpo: { pacienteId: eu(req), slotId, sintomas, idade: t.idade(p.dataNascimento) }, headers: chave ? { 'Idempotency-Key': chave } : {} });
    res.status(202).location(`${BASE}/agendamentos/${a.id}?versaoMinima=${a.versao}`).json(cartao(a));
  }));

  // Logo apos o 202 a projecao pode nao ter chegado: versaoMinima faz a consulta esperar por ela (ate 2 s).
  const consultar = (req, versao = 0) => pedir(req, 'GET', `${AGE}/agendamentos/${req.params.id}?versaoMinima=${versao}`, { timeoutMs: 5000 });

  r.get('/agendamentos/:id', rota(async (req, res) => {
    const a = await consultar(req, /^\d{1,9}$/.test(req.query.versaoMinima) ? req.query.versaoMinima : 0);
    const tr = a.sagaId ? await opcional(pedir(req, 'GET', `${TRI}/triagens?sagaId=${a.sagaId}`)) : null;
    res.json({ ...cartao(a), orientacoes: ORIENTACOES, triagem: tr ? { justificativa: tr.justificativa, origem: tr.origem, fontes: tr.fontes.map(t.fonte) } : undefined });
  }));

  // Os passos da SAGA, para a tela acompanhar.
  r.get('/agendamentos/:id/andamento', rota(async (req, res) => {
    const a = await consultar(req);
    if (!a.sagaId) throw new Problema(404, 'Sem andamento para este agendamento');
    const s = await pedir(req, 'GET', `${AGE}/sagas/${a.sagaId}`);
    res.json({ estado: s.estado, terminou: ['CONCLUIDA', 'FALHOU'].includes(s.estado), motivo: s.motivo || undefined, passos: t.andamento(s), _links: { agendamento: link(`/agendamentos/${a.id}`) } });
  }));

  for (const acao of ['confirmacao', 'reagendamento', 'cancelamento']) {
    r.post(`/agendamentos/:id/${acao}`, rota(async (req, res) => {
      res.json(cartao(await pedir(req, 'POST', `${AGE}/agendamentos/${req.params.id}/${acao}`, { corpo: req.body || {} })));
    }));
  }
  return r;
}

module.exports = { criarRotas };
