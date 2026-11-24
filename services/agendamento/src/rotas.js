const express = require('express');
const { randomUUID } = require('crypto');
const { transacao } = require('./db');
const { Problema } = require('./erros');
const agenda = require('./agenda');
const outbox = require('./outbox');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const invalido = (detalhe) => new Problema(422, 'Dados invalidos', detalhe);
const inteiro = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

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

// Identidade injetada pelo gateway (X-User-Id / X-User-Role).
function exigirPerfil(req, perfil) {
  if (req.get('X-User-Role') !== perfil) throw new Problema(403, 'Sem permissao', `Apenas perfil ${perfil}.`);
}
function exigirDono(req, pacienteId) {
  const perfil = req.get('X-User-Role');
  if (perfil === 'gestor' || (perfil === 'paciente' && req.get('X-User-Id') === pacienteId)) return;
  throw new Problema(403, 'Sem permissao');
}

function criarRotas({ pool }) {
  const r = express.Router();
  const rota = (fn) => (req, res, next) => fn(req, res).catch(next);

  r.param('id', (req, _res, next, id) => next(UUID.test(id) ? undefined : new Problema(404, 'Agendamento nao encontrado')));

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
    const a = await agenda.buscar(pool, req.params.id);
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

function criarApp({ pool, publicador, nome = 'agendamento', instancia }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.correlationId = req.get('X-Correlation-Id') || randomUUID();
    res.set('X-Correlation-Id', req.correlationId);
    const t0 = Date.now();
    res.on('finish', () => {
      if (['/live', '/ready'].includes(req.path)) return;
      console.log(JSON.stringify({ nivel: 'info', servico: nome, correlationId: req.correlationId, metodo: req.method, caminho: req.originalUrl, status: res.statusCode, ms: Date.now() - t0 }));
    });
    next();
  });
  app.use(express.json());

  // Vivo: o processo responde. Nao depende do banco, para nao ser reiniciado por falha alheia.
  app.get('/live', (_req, res) => res.json({ service: nome, status: 'ok', instance: instancia }));
  // Pronto: banco acessivel. RabbitMQ fora nao tira o servico do ar: o Outbox guarda os eventos.
  app.get('/ready', async (_req, res) => {
    const db = await pool.query('SELECT 1').then(() => 'up', () => 'down');
    res.status(db === 'up' ? 200 : 503).json({ service: nome, status: db === 'up' ? 'ok' : 'degraded', db, rabbitmq: publicador.conectado() ? 'up' : 'down', instance: instancia });
  });
  app.get('/metricas', async (_req, res, next) => { try { res.json({ outbox: await outbox.metricas(pool) }); } catch (e) { next(e); } });

  app.use('/api/v1', criarRotas({ pool }));
  app.use((_req, _res, next) => next(new Problema(404, 'Recurso nao encontrado')));
  app.use((e, req, res, _next) => {
    const jsonInvalido = e.type === 'entity.parse.failed';
    const status = e instanceof Problema ? e.status : jsonInvalido ? 400 : 500;
    if (status === 500) console.error(JSON.stringify({ nivel: 'erro', correlationId: req.correlationId, erro: e.stack }));
    res.status(status).type('application/problem+json').json({
      type: 'about:blank', title: e instanceof Problema ? e.title : jsonInvalido ? 'JSON invalido' : 'Erro interno',
      status, detail: e instanceof Problema ? e.detail : undefined, correlationId: req.correlationId,
    });
  });
  return app;
}

module.exports = { criarApp };
