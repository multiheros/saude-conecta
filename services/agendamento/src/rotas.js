const express = require('express');
const { transacao } = require('../../../libs/comum/db');
const { Problema } = require('../../../libs/comum/erros');
const { UUID, inteiro, invalido, exigirPerfil, exigirDono, rota } = require('../../../libs/comum/http');
const agenda = require('./agenda');

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Recebe a visao de um agendamento: a linha do Write Model (resposta de comando) ou o documento
// do Read Model (resposta de consulta). `projetadoEm` e o nome do paciente so existem na segunda.
function representar(a) {
  const base = `/api/v1/agendamentos/${a.agendamentoId}`;
  const caminho = { confirmar: 'confirmacao', reagendar: 'reagendamento', cancelar: 'cancelamento' };
  const _links = { self: { href: base, method: 'GET' } };
  for (const acao of agenda.ACOES[a.status]) _links[acao] = { href: `${base}/${caminho[acao]}`, method: 'POST' };
  return {
    id: a.agendamentoId, status: a.status, pacienteId: a.pacienteId, pacienteNome: a.pacienteNome, slotId: a.slot.id, dataHora: a.slot.inicio,
    especialidade: a.profissional.especialidade, profissional: a.profissional, ubs: a.ubs, classificacaoUrgencia: a.urgencia,
    sagaId: a.sagaId, motivo: a.motivo, versao: a.versao, atualizadoEm: a.atualizadoEm, projetadoEm: a.projetadoEm, _links,
  };
}
const daLinha = (a) => representar({ ...agenda.detalhe(a), versao: a.version, atualizadoEm: a.atualizado_em });
const parametros = (detalhe) => new Problema(400, 'Parâmetros inválidos', detalhe);

function criarRotas({ pool, saga, consultas }) {
  const r = express.Router();

  r.param('id', (req, _res, next, id) => next(UUID.test(id) ? undefined : new Problema(404, 'Recurso não encontrado')));

  // --- SAGA
  r.post('/agendamentos', rota(async (req, res) => {
    const { pacienteId, slotId, sintomas, idade } = req.body;
    const chave = req.get('Idempotency-Key');
    if (!UUID.test(pacienteId) || !UUID.test(slotId)) throw invalido('pacienteId e slotId devem ser UUID.');
    exigirDono(req, pacienteId);
    if (typeof sintomas !== 'string' || sintomas.trim().length < 10 || sintomas.length > 2000) throw invalido('Descreva os sintomas com 10 a 2000 caracteres.');
    if (idade !== undefined && !inteiro(idade, 0, 130)) throw invalido('idade inválida.');
    if (chave !== undefined && (chave.length < 1 || chave.length > 100)) throw invalido('Idempotency-Key deve ter até 100 caracteres.');
    const a = await saga.iniciar(req.correlationId, { pacienteId, slotId, sintomas, idade, chave });
    // O GET de Location espera a projecao da versao que o cliente acabou de ver.
    res.status(202).location(`/api/v1/agendamentos/${a.id}?versaoMinima=${a.version}`).type('application/hal+json').json(daLinha(a));
  }));
  r.get('/sagas/:id', rota(async (req, res) => {
    const s = await saga.auditoria(req.params.id);
    if (!s) throw new Problema(404, 'SAGA não encontrada');
    exigirDono(req, s.pacienteId);
    res.json(s.corpo);
  }));

  // --- Comandos
  const comando = (fn) => rota(async (req, res) => {
    const a = await transacao(pool, async (c) => {
      const atual = await agenda.buscar(c, req.params.id);
      if (!atual) throw new Problema(404, 'Agendamento não encontrado');
      exigirDono(req, atual.paciente_id);
      return fn(c, { correlationId: req.correlationId }, req);
    });
    res.type('application/hal+json').json(daLinha(a));
  });
  r.post('/agendamentos/:id/confirmacao', comando((c, ctx, req) => agenda.confirmar(c, ctx, req.params.id)));
  r.post('/agendamentos/:id/cancelamento', comando((c, ctx, req) => {
    const motivo = req.body?.motivo;
    if (motivo !== undefined && (typeof motivo !== 'string' || motivo.length > 200)) throw invalido('motivo deve ser texto de até 200 caracteres.');
    return agenda.cancelar(c, ctx, req.params.id, motivo);
  }));
  r.post('/agendamentos/:id/reagendamento', comando((c, ctx, req) => {
    if (!UUID.test(req.body?.novoSlotId)) throw invalido('novoSlotId é obrigatório.');
    return agenda.reagendar(c, ctx, req.params.id, req.body.novoSlotId);
  }));
  r.post('/agendamentos/:id/comparecimento', comando((c, ctx, req) => {
    exigirPerfil(req, 'gestor');
    if (typeof req.body?.compareceu !== 'boolean') throw invalido('compareceu deve ser booleano.');
    return agenda.registrarComparecimento(c, ctx, req.params.id, req.body.compareceu);
  }));
  r.post('/escalas', rota(async (req, res) => {
    exigirPerfil(req, 'gestor');
    const e = { semanas: 4, ...req.body };
    if (!UUID.test(e.profissionalId) || !UUID.test(e.ubsId)) throw invalido('profissionalId e ubsId devem ser UUID.');
    if (!inteiro(e.diaSemana, 1, 7)) throw invalido('diaSemana deve ser de 1 (segunda) a 7 (domingo).');
    if (!HORA.test(e.horaInicio) || !HORA.test(e.horaFim) || e.horaInicio >= e.horaFim) throw invalido('horaInicio deve ser anterior a horaFim, no formato HH:MM.');
    if (!inteiro(e.duracaoSlotMin, 5, 240)) throw invalido('duracaoSlotMin deve ser de 5 a 240.');
    if (!inteiro(e.semanas, 1, 12)) throw invalido('semanas deve ser de 1 a 12.');
    res.status(201).json(await transacao(pool, (c) => agenda.criarEscala(c, { correlationId: req.correlationId }, e)));
  }));

  // --- Catalogo: dado de referencia, que nao muda por evento. Le direto do PostgreSQL.
  r.get('/ubs', rota(async (_req, res) => res.json((await pool.query('SELECT id, nome, endereco, regiao FROM ubs ORDER BY nome')).rows)));
  r.get('/profissionais', rota(async (_req, res) => res.json((await pool.query('SELECT id, nome, especialidade FROM profissionais ORDER BY nome')).rows)));

  // --- Consultas (CQRS): so o Read Model. Ver consultas.js.
  r.get('/slots', rota(async (req, res) => {
    const { ubsId, especialidade, dataInicio, dataFim } = req.query;
    if (!UUID.test(ubsId)) throw parametros('ubsId é obrigatório.');
    if (especialidade !== undefined && typeof especialidade !== 'string') throw parametros('especialidade inválida.');
    for (const d of [dataInicio, dataFim]) if (d !== undefined && !DATA.test(d)) throw parametros('Data deve ser AAAA-MM-DD.');
    res.json(await consultas.slots({ ubsId, especialidade, dataInicio, dataFim }));
  }));
  r.get('/agendamentos/:id', rota(async (req, res) => {
    const v = req.query.versaoMinima;
    if (v !== undefined && !/^\d{1,9}$/.test(v)) throw parametros('versaoMinima deve ser um inteiro.');
    const a = await consultas.obter(req.params.id, v === undefined ? undefined : Number(v));
    if (!a) throw new Problema(404, 'Agendamento não encontrado');
    exigirDono(req, a.pacienteId);
    res.type('application/hal+json').json(representar(a));
  }));
  r.get('/agendamentos', rota(async (req, res) => {
    const { pacienteId, status } = req.query;
    const page = Number(req.query.page || 1), size = Number(req.query.size || 20);
    if (!inteiro(page, 1, 1e6) || !inteiro(size, 1, 100)) throw parametros('page >= 1 e size de 1 a 100.');
    if (pacienteId !== undefined && !UUID.test(pacienteId)) throw parametros('pacienteId inválido.');
    if (status !== undefined && !Object.hasOwn(agenda.ACOES, status)) throw parametros('status inválido.');
    exigirDono(req, pacienteId);
    const { itens, total } = await consultas.listar({ pacienteId, status, page, size });
    res.json({ items: itens.map(representar), page, size, total });
  }));
  r.get('/relatorios/ocupacao', rota(async (req, res) => {
    exigirPerfil(req, 'gestor');
    const { ubsId, periodo, especialidade } = req.query;
    if (!UUID.test(ubsId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) throw parametros('ubsId e período (AAAA-MM) são obrigatórios.');
    if (especialidade !== undefined && typeof especialidade !== 'string') throw parametros('especialidade inválida.');
    res.json(await consultas.ocupacao({ ubsId, periodo, especialidade }));
  }));
  return r;
}

module.exports = { criarRotas };
