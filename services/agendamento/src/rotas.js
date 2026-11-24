const express = require('express');
const { transacao } = require('../../../libs/comum/db');
const { Problema } = require('../../../libs/comum/erros');
const { UUID, inteiro, invalido, exigirPerfil, exigirDono, rota } = require('../../../libs/comum/http');
const agenda = require('./agenda');

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function representar(a) {
  const base = `/api/v1/agendamentos/${a.id}`;
  const caminho = { confirmar: 'confirmacao', reagendar: 'reagendamento', cancelar: 'cancelamento' };
  const _links = { self: { href: base, method: 'GET' } };
  for (const acao of agenda.ACOES[a.status]) _links[acao] = { href: `${base}/${caminho[acao]}`, method: 'POST' };
  return {
    id: a.id, status: a.status, pacienteId: a.paciente_id, slotId: a.slot_id, dataHora: a.inicio, especialidade: a.especialidade,
    classificacaoUrgencia: a.urgencia, sagaId: a.saga_id, motivo: a.motivo, atualizadoEm: a.atualizado_em, _links,
  };
}

function criarRotas({ pool, saga }) {
  const r = express.Router();

  r.param('id', (req, _res, next, id) => next(UUID.test(id) ? undefined : new Problema(404, 'Recurso nao encontrado')));

  // --- SAGA
  r.post('/agendamentos', rota(async (req, res) => {
    const { pacienteId, slotId, sintomas, idade } = req.body;
    const chave = req.get('Idempotency-Key');
    if (!UUID.test(pacienteId) || !UUID.test(slotId)) throw invalido('pacienteId e slotId devem ser UUID.');
    exigirDono(req, pacienteId);
    if (typeof sintomas !== 'string' || sintomas.trim().length < 10 || sintomas.length > 2000) throw invalido('Descreva os sintomas com 10 a 2000 caracteres.');
    if (idade !== undefined && !inteiro(idade, 0, 130)) throw invalido('idade invalida.');
    if (chave !== undefined && (chave.length < 1 || chave.length > 100)) throw invalido('Idempotency-Key deve ter ate 100 caracteres.');
    const a = await saga.iniciar(req.correlationId, { pacienteId, slotId, sintomas, idade, chave });
    res.status(202).location(`/api/v1/agendamentos/${a.id}`).type('application/hal+json').json(representar(a));
  }));
  r.get('/sagas/:id', rota(async (req, res) => {
    const s = await saga.auditoria(req.params.id);
    if (!s) throw new Problema(404, 'SAGA nao encontrada');
    exigirDono(req, s.pacienteId);
    res.json(s.corpo);
  }));

  // --- Comandos
  const comando = (fn) => rota(async (req, res) => {
    const a = await transacao(pool, async (c) => {
      const atual = await agenda.buscar(c, req.params.id);
      if (!atual) throw new Problema(404, 'Agendamento nao encontrado');
      exigirDono(req, atual.paciente_id);
      return fn(c, { correlationId: req.correlationId }, req);
    });
    res.type('application/hal+json').json(representar(a));
  });
  r.post('/agendamentos/:id/confirmacao', comando((c, ctx, req) => agenda.confirmar(c, ctx, req.params.id)));
  r.post('/agendamentos/:id/cancelamento', comando((c, ctx, req) => {
    const motivo = req.body?.motivo;
    if (motivo !== undefined && (typeof motivo !== 'string' || motivo.length > 200)) throw invalido('motivo deve ser texto de ate 200 caracteres.');
    return agenda.cancelar(c, ctx, req.params.id, motivo);
  }));
  r.post('/agendamentos/:id/reagendamento', comando((c, ctx, req) => {
    if (!UUID.test(req.body?.novoSlotId)) throw invalido('novoSlotId e obrigatorio.');
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

  // --- Consultas. PROVISORIO: passam a ler o Read Model na etapa de CQRS.
  r.get('/slots', rota(async (req, res) => {
    const { ubsId, especialidade, dataInicio, dataFim } = req.query;
    if (!UUID.test(ubsId)) throw new Problema(400, 'Parametros invalidos', 'ubsId e obrigatorio.');
    for (const d of [dataInicio, dataFim]) if (d !== undefined && Number.isNaN(Date.parse(d))) throw new Problema(400, 'Parametros invalidos', 'Data invalida.');
    const { rows } = await pool.query(
      `SELECT id, ubs_id AS "ubsId", profissional_id AS "profissionalId", especialidade, inicio, fim, status FROM slots
        WHERE ubs_id=$1 AND status='LIVRE' AND inicio > now() AND ($2::text IS NULL OR especialidade=$2)
          AND ($3::date IS NULL OR inicio >= $3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND ($4::date IS NULL OR inicio < ($4::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        ORDER BY inicio LIMIT 200`, [ubsId, especialidade || null, dataInicio || null, dataFim || null]);
    res.json(rows);
  }));
  r.get('/agendamentos/:id', rota(async (req, res) => {
    const a = await saga.agendamento(req.params.id);
    if (!a) throw new Problema(404, 'Agendamento nao encontrado');
    exigirDono(req, a.paciente_id);
    res.type('application/hal+json').json(representar(a));
  }));
  r.get('/agendamentos', rota(async (req, res) => {
    const { pacienteId, status } = req.query;
    const page = Number(req.query.page || 1), size = Number(req.query.size || 20);
    if (!inteiro(page, 1, 1e6) || !inteiro(size, 1, 100)) throw new Problema(400, 'Parametros invalidos', 'page >= 1 e size de 1 a 100.');
    if (pacienteId !== undefined && !UUID.test(pacienteId)) throw new Problema(400, 'Parametros invalidos', 'pacienteId invalido.');
    exigirDono(req, pacienteId);
    const filtro = 'WHERE ($1::uuid IS NULL OR a.paciente_id=$1) AND ($2::text IS NULL OR a.status=$2)';
    const { rows } = await pool.query(`${agenda.SELECT} ${filtro} ORDER BY a.criado_em DESC LIMIT $3 OFFSET $4`, [pacienteId || null, status || null, size, (page - 1) * size]);
    const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM agendamentos a ${filtro}`, [pacienteId || null, status || null]);
    res.json({ items: rows.map(representar), page, size, total });
  }));
  r.get('/relatorios/ocupacao', rota(async (req, res) => {
    exigirPerfil(req, 'gestor');
    const { ubsId, periodo } = req.query;
    if (!UUID.test(ubsId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) throw new Problema(400, 'Parametros invalidos', 'ubsId e periodo (AAAA-MM) sao obrigatorios.');
    const { rows: [t] } = await pool.query(
      `SELECT count(*)::int AS "slotsTotais", count(*) FILTER (WHERE status='RESERVADO')::int AS reservados FROM slots
        WHERE ubs_id=$1 AND to_char(inicio AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM')=$2`, [ubsId, periodo]);
    res.json({ ubsId, periodo, ...t, ocupacaoPercentual: t.slotsTotais ? Math.round((1000 * t.reservados) / t.slotsTotais) / 10 : 0 });
  }));
  return r;
}

module.exports = { criarRotas };
