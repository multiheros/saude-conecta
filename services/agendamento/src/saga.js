// Orquestrador da SAGA de agendamento.
//
// Cada passo e gravado antes de seguir. Se o processo morre, o lease expira e outra
// replica retoma do passo em que parou. `locked_by` funciona como fencing: quem perdeu o
// lease nao consegue gravar, entao duas replicas nunca conduzem a mesma SAGA.
const { randomUUID } = require('crypto');
const { transacao } = require('../../../libs/comum/db');
const { Problema } = require('../../../libs/comum/erros');
const { chamar } = require('../../../libs/comum/cliente');
const { gravarEvento } = require('../../../libs/comum/outbox');
const agenda = require('./agenda');

const NOMES = { 1: '1-triagem', 2: '2-pacientes', 3: '3-reserva', 4: '4-notificacoes' };
const MOTIVO = {
  EMERGENCIA: 'Sintomas de emergencia: procure atendimento imediato ou ligue 192 (SAMU).',
  SLOT: 'O horario escolhido acabou de ser ocupado. Escolha outro.',
  EM_ANDAMENTO: 'Voce ja tem um agendamento em andamento. Aguarde a conclusao.',
  RECUSADO: 'Nao foi possivel validar os dados do agendamento.',
  INDISPONIVEL: 'Nao foi possivel concluir o agendamento agora. Tente novamente em instantes.',
};
const ATIVOS = "('EM_ANDAMENTO','COMPENSANDO','COMPENSACAO_PENDENTE')";

class LeasePerdido extends Error {}
// Falha de um passo. `ambigua`: o participante pode ter executado.
class FalhaPasso extends Error {
  constructor(motivo, detalhe, { ambigua = false, concluiu = false } = {}) { super(detalhe); this.motivo = motivo; this.ambigua = ambigua; this.concluiu = concluiu; }
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function criarOrquestrador({ pool, env = process.env, config = {} }) {
  const cfg = { leaseMs: 15000, timeoutMs: 3000, timeoutTriagemMs: 10000, tentativas: 3, backoffMs: 300, pendenteMs: 2000, intervaloMs: 500, simultaneas: 5, ...config };
  const URLS = { triagem: env.TRIAGEM_URL, pacientes: env.PACIENTES_URL, notificacoes: env.NOTIFICACOES_URL };

  // --- Persistencia com fencing
  async function comLease(s, fn) {
    return transacao(pool, async (c) => {
      const { rowCount } = await c.query(
        "UPDATE saga_instances SET locked_until=now()+$3*interval '1 ms', atualizado_em=now() WHERE id=$1 AND locked_by=$2", [s.id, s.dono, cfg.leaseMs]);
      if (!rowCount) throw new LeasePerdido();
      return fn(c);
    });
  }
  const renovar = (s) => comLease(s, async () => {});
  const registrar = (c, s, passo, tipo, resultado, detalhe, t0) => c.query(
    'INSERT INTO saga_log (saga_id, passo, tipo, resultado, detalhe, duracao_ms) VALUES ($1,$2,$3,$4,$5,$6)',
    [s.id, NOMES[passo], tipo, resultado, detalhe ? String(detalhe).slice(0, 200) : null, t0 ? Date.now() - t0 : null]);

  const cabecalhos = (s, passo) => ({
    'X-User-Role': 'servico', 'X-Saga-Id': s.id, 'X-Correlation-Id': s.correlation_id || s.id, ...(passo ? { 'Idempotency-Key': `${s.id}:${passo}` } : {}),
  });

  // Chama um participante com retry. Repetir e seguro: a acao e idempotente por SAGA.
  async function remoto(s, metodo, url, { corpo, passo, timeoutMs = cfg.timeoutMs, tentativas = cfg.tentativas, soSeNaoEnviado = false } = {}) {
    let ambigua = false;
    for (let n = 1; ; n++) {
      await renovar(s);
      try {
        return { ...(await chamar(metodo, url, { corpo, timeoutMs, headers: cabecalhos(s, passo) })), ambigua };
      } catch (e) {
        if (!e.remota) throw e;
        if (!e.naoEnviado) ambigua = true;
        if (n >= tentativas || (soSeNaoEnviado && !e.naoEnviado)) { e.ambigua = ambigua; throw e; }
        await dormir(cfg.backoffMs * 3 ** (n - 1));
      }
    }
  }
  async function acao(s, passo, metodo, url, corpo, opcoes = {}) {
    let r;
    try {
      r = await remoto(s, metodo, url, { corpo, passo, ...opcoes });
    } catch (e) {
      if (!e.remota) throw e;
      throw new FalhaPasso(MOTIVO.INDISPONIVEL, e.message, { ambigua: e.ambigua });
    }
    // 4xx: o participante recusou. Se antes houve resposta perdida, ainda pode haver o que desfazer.
    if (r.status >= 400) throw new FalhaPasso(r.status === 409 && passo === 2 ? MOTIVO.EM_ANDAMENTO : MOTIVO.RECUSADO, `HTTP ${r.status} ${(r.corpo && (r.corpo.detail || r.corpo.title)) || ''}`.trim(), { ambigua: r.ambigua });
    return r.corpo;
  }

  // --- Passos. Cada um devolve o que grava na propria linha da SAGA, dentro da transacao.
  const passos = {
    async 1(s) {
      const t = await acao(s, 1, 'POST', `${URLS.triagem}/api/v1/triagens`,
        { pacienteId: s.paciente_id, sintomas: s.sintomas, ...(s.idade == null ? {} : { idade: s.idade }) },
        { timeoutMs: cfg.timeoutTriagemMs, soSeNaoEnviado: true }); // a Triagem ja trata retry do LLM: nao repetir por timeout
      if (t.classificacao === 'VERMELHO') throw new FalhaPasso(MOTIVO.EMERGENCIA, 'VERMELHO', { concluiu: true });
      return { detalhe: t.classificacao, gravar: (c) => c.query('UPDATE saga_instances SET urgencia=$2, sintomas=NULL WHERE id=$1', [s.id, t.classificacao]) };
    },
    async 2(s) {
      await acao(s, 2, 'POST', `${URLS.pacientes}/api/v1/pacientes/${s.paciente_id}/validacao`);
      return {};
    },
    async 3(s) {
      return { gravar: (c) => agenda.reservar(c, ctx(s), { agendamentoId: s.agendamento_id, pacienteId: s.paciente_id, slotId: s.slot_id, sagaId: s.id, urgencia: s.urgencia }) };
    },
    async 4(s) {
      const { rows: [{ inicio }] } = await pool.query('SELECT inicio FROM slots WHERE id=$1', [s.slot_id]);
      const l = await acao(s, 4, 'POST', `${URLS.notificacoes}/api/v1/notificacoes`, { pacienteId: s.paciente_id, agendamentoId: s.agendamento_id, dataConsulta: inicio });
      return {
        detalhe: `${l.length} notificacoes`,
        async gravar(c) { // ultimo passo: conclui na mesma transacao
          const a = await agenda.mudarStatus(c, s.agendamento_id, 'AGENDADO');
          await agenda.eventoAgendamento(c, ctx(s), a, 'AgendamentoCriado', 'criado');
          await c.query("UPDATE saga_instances SET estado='CONCLUIDA', locked_by=NULL, locked_until=NULL WHERE id=$1", [s.id]);
        },
      };
    },
  };
  const ctx = (s) => ({ correlationId: s.correlation_id });

  const compensacoes = {
    1: (s, o) => remoto(s, 'DELETE', `${URLS.triagem}/api/v1/triagens?sagaId=${s.id}`, o),
    2: (s, o) => remoto(s, 'DELETE', `${URLS.pacientes}/api/v1/pacientes/${s.paciente_id}/validacao`, o),
    4: (s, o) => remoto(s, 'DELETE', `${URLS.notificacoes}/api/v1/notificacoes?sagaId=${s.id}`, o),
  };

  // Marca a falha e monta a lista a desfazer: concluidos em ordem inversa e, por ultimo, o
  // passo que falhou de forma ambigua. Este fica no fim porque o participante
  // provavelmente esta fora, e espera-lo prenderia o horario do paciente.
  async function falhar(s, passo, f, t0) {
    const lista = [];
    for (let p = f.concluiu ? passo : passo - 1; p >= 1; p--) lista.push(p);
    if (f.ambigua && !f.concluiu && compensacoes[passo]) lista.push(passo);
    await comLease(s, async (c) => {
      await registrar(c, s, passo, 'ACAO', 'FALHA', f.message, t0);
      await c.query("UPDATE saga_instances SET estado='COMPENSANDO', compensar=$2, motivo=$3, sintomas=NULL WHERE id=$1", [s.id, lista, f.motivo]);
      // Sem reserva, nao ha linha em agendamentos: o cancelamento e anunciado ja aqui.
      if (passo <= 3) await eventoCancelado(c, s, f.motivo);
    });
  }
  async function eventoCancelado(c, s, motivo) {
    const a = await agenda.buscar(c, s.agendamento_id) || await agendaDaSaga(c, { ...s, motivo, estado: 'FALHOU' });
    await agenda.eventoAgendamento(c, ctx(s), a, 'AgendamentoCancelado', 'cancelado');
  }

  async function compensar(s) {
    const pendentes = [];
    for (const p of s.compensar) {
      const t0 = Date.now();
      if (p === 3) {
        await comLease(s, async (c) => {
          const a = await agenda.liberarReserva(c, ctx(s), { sagaId: s.id, motivo: s.motivo });
          if (a) await agenda.eventoAgendamento(c, ctx(s), a, 'AgendamentoCancelado', 'cancelado');
          await registrar(c, s, 3, 'COMPENSACAO', 'OK', null, t0);
          await c.query('UPDATE saga_instances SET compensar=array_remove(compensar, 3::smallint) WHERE id=$1', [s.id]);
        });
        continue;
      }
      let erro = null;
      try {
        // Em rodada de repeticao, uma tentativa basta: a proxima rodada insiste.
        const r = await compensacoes[p](s, s.tentativas > 0 ? { tentativas: 1 } : {});
        if (r.status >= 400 && r.status !== 404) erro = `HTTP ${r.status}`;
      } catch (e) {
        if (!e.remota) throw e;
        erro = e.message;
      }
      await comLease(s, async (c) => {
        // Repeticoes seguidas com a mesma falha nao enchem o log.
        if (!erro || s.tentativas === 0) await registrar(c, s, p, 'COMPENSACAO', erro ? 'PENDENTE' : 'OK', erro, t0);
        if (!erro) await c.query('UPDATE saga_instances SET compensar=array_remove(compensar, $2::smallint) WHERE id=$1', [s.id, p]);
      });
      if (erro) pendentes.push(p);
    }
    await comLease(s, (c) => (pendentes.length
      ? c.query(
        `UPDATE saga_instances SET estado='COMPENSACAO_PENDENTE', tentativas=tentativas+1, locked_by=NULL, locked_until=NULL,
                proxima_execucao=now() + LEAST($2 * power(2, LEAST(tentativas, 10)), 60000) * interval '1 ms' WHERE id=$1`, [s.id, cfg.pendenteMs])
      : c.query("UPDATE saga_instances SET estado='FALHOU', locked_by=NULL, locked_until=NULL WHERE id=$1", [s.id])));
    if (pendentes.length) console.error(JSON.stringify({ nivel: 'alerta', msg: 'compensacao pendente', sagaId: s.id, passos: pendentes.map((p) => NOMES[p]) }));
  }

  async function ler(id, dono) {
    const { rows: [s] } = await pool.query('SELECT * FROM saga_instances WHERE id=$1 AND locked_by=$2', [id, dono]);
    if (!s) throw new LeasePerdido();
    return { ...s, dono };
  }

  // Conduz uma SAGA ate um estado de repouso (ou ate pedirem para parar, entre passos).
  async function conduzir(id, dono) {
    try {
      for (;;) {
        const s = await ler(id, dono);
        if (s.estado !== 'EM_ANDAMENTO') return await compensar(s);
        if (parado) { await pool.query('UPDATE saga_instances SET locked_by=NULL, locked_until=NULL WHERE id=$1 AND locked_by=$2', [id, dono]); return; }
        const passo = s.passo_atual, t0 = Date.now();
        try {
          const r = await passos[passo](s);
          await comLease(s, async (c) => {
            await registrar(c, s, passo, 'ACAO', 'OK', r.detalhe, t0);
            await c.query('UPDATE saga_instances SET passo_atual=$2 WHERE id=$1', [id, Math.min(passo + 1, 4)]);
            if (r.gravar) await r.gravar(c);
          });
          if (passo === 4) return;
        } catch (e) {
          const f = e instanceof FalhaPasso ? e
            : e instanceof Problema && passo === 3 ? new FalhaPasso(e.status === 409 ? MOTIVO.SLOT : MOTIVO.RECUSADO, e.detail || e.title) : null;
          if (!f) throw e;
          await falhar(s, passo, f, t0);
        }
      }
    } catch (e) {
      // Lease perdido: outra replica assumiu. Banco fora: o lease expira e alguem retoma.
      if (!(e instanceof LeasePerdido)) console.error(JSON.stringify({ nivel: 'erro', msg: 'saga interrompida, sera retomada', sagaId: id, erro: e.message }));
    }
  }

  // --- Laco: assume SAGAs prontas ou abandonadas (lease vencido)
  let parado = false, acordar = () => {}, laco = null;
  const emCurso = new Set();
  async function assumir() {
    const vagas = cfg.simultaneas - emCurso.size;
    if (vagas <= 0) return 0;
    const { rows } = await pool.query(
      `UPDATE saga_instances SET locked_by=gen_random_uuid(), locked_until=now()+$2*interval '1 ms'
        WHERE id IN (SELECT id FROM saga_instances
                      WHERE estado IN ${ATIVOS} AND proxima_execucao <= now() AND (locked_until IS NULL OR locked_until < now())
                      ORDER BY proxima_execucao LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, locked_by`, [vagas, cfg.leaseMs]);
    for (const { id, locked_by: dono } of rows) {
      const p = conduzir(id, dono).finally(() => { emCurso.delete(p); acordar(); });
      emCurso.add(p);
    }
    return rows.length;
  }

  // --- API
  async function iniciar(correlationId, { pacienteId, slotId, sintomas, idade, chave }) {
    const r = await transacao(pool, async (c) => {
      const { rowCount } = await c.query('SELECT 1 FROM slots WHERE id=$1', [slotId]);
      if (!rowCount) throw new Problema(422, 'Dados invalidos', 'Horario inexistente.');
      const { rows: [s] } = await c.query(
        `INSERT INTO saga_instances (id, agendamento_id, paciente_id, slot_id, sintomas, idade, correlation_id, chave_idempotencia)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (paciente_id, chave_idempotencia) DO NOTHING RETURNING *`,
        [randomUUID(), randomUUID(), pacienteId, slotId, sintomas, idade ?? null, correlationId, chave || null]);
      if (!s) { // mesmo Idempotency-Key: devolve a SAGA ja iniciada
        const { rows: [ja] } = await c.query('SELECT * FROM saga_instances WHERE paciente_id=$1 AND chave_idempotencia=$2', [pacienteId, chave]);
        return ja;
      }
      await agenda.eventoAgendamento(c, { correlationId }, await agendaDaSaga(c, s), 'AgendamentoSolicitado', 'solicitado');
      return s;
    });
    acordar();
    return agendamento(r.agendamento_id);
  }

  // Visao do agendamento: a linha, se a reserva aconteceu, ou o que a SAGA sabe dele.
  async function agendamento(id) {
    const a = await agenda.buscar(pool, id);
    if (a) return a;
    const { rows: [s] } = await pool.query('SELECT * FROM saga_instances WHERE agendamento_id=$1', [id]);
    return s ? agendaDaSaga(pool, s) : null;
  }

  async function auditoria(id) {
    const { rows: [s] } = await pool.query('SELECT * FROM saga_instances WHERE id=$1', [id]);
    if (!s) return null;
    const { rows } = await pool.query('SELECT passo, tipo, resultado, detalhe, duracao_ms AS "duracaoMs", em FROM saga_log WHERE saga_id=$1 ORDER BY id', [id]);
    return { pacienteId: s.paciente_id, corpo: { id: s.id, agendamentoId: s.agendamento_id, estado: s.estado, motivo: s.motivo, criadoEm: s.criado_em, atualizadoEm: s.atualizado_em, historico: rows } };
  }

  return {
    iniciar, agendamento, auditoria, assumir,
    async metricas() {
      const { rows } = await pool.query('SELECT estado, count(*)::int AS n FROM saga_instances GROUP BY 1');
      return Object.fromEntries(rows.map((r) => [r.estado, r.n]));
    },
    ligar() {
      laco = (async () => {
        while (!parado) {
          try { await assumir(); } catch (e) { console.error(JSON.stringify({ nivel: 'erro', msg: 'saga: assumir', erro: e.message })); }
          if (!parado) await new Promise((ok) => { acordar = ok; setTimeout(ok, cfg.intervaloMs); });
        }
      })();
    },
    // Termina o passo em curso e solta as SAGAs para outra replica.
    async parar() { parado = true; acordar(); await laco; await Promise.all([...emCurso]); },
  };
}

// Monta a visao de um agendamento que ainda nao tem linha propria (antes do passo 3, ou SAGA que falhou antes dele).
// Versao 0 = solicitado; 1 = cancelado sem reserva. A linha em agendamentos, quando existe, comeca em 1 e so emite a partir de 2.
async function agendaDaSaga(c, s) {
  const { rows: [d] } = await c.query(
    `SELECT s.inicio, s.fim, s.especialidade, s.ubs_id, u.nome AS ubs_nome, u.endereco AS ubs_endereco, s.profissional_id, p.nome AS profissional_nome
       FROM slots s JOIN ubs u ON u.id=s.ubs_id JOIN profissionais p ON p.id=s.profissional_id WHERE s.id=$1`, [s.slot_id]);
  const cancelado = s.estado !== 'EM_ANDAMENTO';
  return {
    ...d, id: s.agendamento_id, paciente_id: s.paciente_id, slot_id: s.slot_id, status: cancelado ? 'CANCELADO' : 'PENDENTE', urgencia: s.urgencia,
    motivo: cancelado ? s.motivo : null, saga_id: s.id, version: cancelado ? 1 : 0, criado_em: s.criado_em, atualizado_em: s.atualizado_em,
  };
}

module.exports = { criarOrquestrador, agendaDaSaga, NOMES, MOTIVO };
