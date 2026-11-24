// Regras do dominio. Toda funcao recebe o cliente de uma transacao em curso:
// mudanca de estado e evento sao gravados juntos (Outbox).
const { Problema } = require('../../../libs/comum/erros');
const { gravarEvento } = require('../../../libs/comum/outbox');

const ACOES = {
  PENDENTE: [],
  AGENDADO: ['confirmar', 'reagendar', 'cancelar'],
  CONFIRMADO: ['reagendar', 'cancelar'],
  CANCELADO: [], REALIZADO: [], FALTOU: [],
};
// Comparecimento e registrado pelo gestor; nao vira link para o paciente.
const COMPARECIMENTO_DE = ['AGENDADO', 'CONFIRMADO'];

const SELECT = `
  SELECT a.id, a.paciente_id, a.slot_id, a.status, a.urgencia, a.motivo, a.saga_id, a.version, a.criado_em, a.atualizado_em,
         s.inicio, s.fim, s.especialidade, s.ubs_id, u.nome AS ubs_nome, u.endereco AS ubs_endereco,
         s.profissional_id, p.nome AS profissional_nome
    FROM agendamentos a JOIN slots s ON s.id = a.slot_id
    JOIN ubs u ON u.id = s.ubs_id JOIN profissionais p ON p.id = s.profissional_id`;

const evento = (c, ctx, tipo, rota, agregado, agregadoId, versao, payload) =>
  gravarEvento(c, { tipo, rota: `agendamento.${rota}`, agregado, agregadoId, versao, payload, correlationId: ctx.correlationId });

// Payload autossuficiente: o projetor nao precisa consultar o write model.
const detalhe = (a) => ({
  agendamentoId: a.id, pacienteId: a.paciente_id, status: a.status, urgencia: a.urgencia, motivo: a.motivo, sagaId: a.saga_id, criadoEm: a.criado_em,
  slot: { id: a.slot_id, inicio: a.inicio, fim: a.fim },
  ubs: { id: a.ubs_id, nome: a.ubs_nome, endereco: a.ubs_endereco },
  profissional: { id: a.profissional_id, nome: a.profissional_nome, especialidade: a.especialidade },
});

const eventoAgendamento = (c, ctx, a, tipo, rota, extra) =>
  evento(c, ctx, tipo, `agendamento.${rota}`, 'Agendamento', a.id, a.version, { ...detalhe(a), ...extra });

// Eventos de vaga pertencem ao agregado Slot: assim duas reservas sucessivas da mesma
// vaga, por agendamentos diferentes, saem na ordem certa.
const eventoSlot = (c, ctx, s, tipo, rota, agendamentoId) =>
  evento(c, ctx, tipo, `slot.${rota}`, 'Slot', s.id, s.version, {
    slotId: s.id, agendamentoId, ubsId: s.ubs_id, profissionalId: s.profissional_id,
    especialidade: s.especialidade, inicio: s.inicio, fim: s.fim,
  });

async function ocuparSlot(c, slotId) {
  const { rows: [s] } = await c.query(
    "UPDATE slots SET status='RESERVADO', version=version+1 WHERE id=$1 AND status='LIVRE' AND inicio > now() RETURNING *", [slotId]);
  if (!s) throw new Problema(409, 'Slot indisponível', 'O horário não existe, já passou ou acabou de ser ocupado.');
  return s;
}

async function soltarSlot(c, slotId) {
  const { rows: [s] } = await c.query(
    "UPDATE slots SET status='LIVRE', version=version+1 WHERE id=$1 AND status='RESERVADO' RETURNING *", [slotId]);
  return s;
}

async function buscar(c, id) {
  const { rows: [a] } = await c.query(`${SELECT} WHERE a.id=$1`, [id]);
  return a;
}

async function buscarComTrava(c, id) {
  const { rows: [a] } = await c.query(`${SELECT} WHERE a.id=$1 FOR UPDATE OF a`, [id]);
  if (!a) throw new Problema(404, 'Agendamento não encontrado');
  return a;
}

async function mudarStatus(c, id, status, motivo = null) {
  await c.query('UPDATE agendamentos SET status=$2, motivo=COALESCE($3, motivo), version=version+1, atualizado_em=now() WHERE id=$1', [id, status, motivo]);
  return buscar(c, id);
}

function exigir(a, acao) {
  if (!ACOES[a.status].includes(acao)) throw new Problema(409, 'Transição de estado inválida', `Não é possível ${acao} um agendamento ${a.status}.`);
}

// SAGA passo 3: transacao local do orquestrador. Idempotente por sagaId.
async function reservar(c, ctx, { agendamentoId, pacienteId, slotId, sagaId, urgencia }) {
  const { rows: [ja] } = await c.query('SELECT id FROM agendamentos WHERE saga_id=$1', [sagaId]);
  if (ja) return buscar(c, ja.id);
  const s = await ocuparSlot(c, slotId);
  await c.query(
    "INSERT INTO agendamentos (id, paciente_id, slot_id, status, urgencia, saga_id) VALUES ($1,$2,$3,'PENDENTE',$4,$5)",
    [agendamentoId, pacienteId, slotId, urgencia || null, sagaId]);
  await eventoSlot(c, ctx, s, 'SlotReservado', 'reservado', agendamentoId);
  return buscar(c, agendamentoId);
}

// SAGA compensacao do passo 3. So desfaz a reserva da propria SAGA; repetir nao tem efeito.
async function liberarReserva(c, ctx, { sagaId, motivo }) {
  const { rows: [r] } = await c.query("SELECT id, slot_id FROM agendamentos WHERE saga_id=$1 AND status='PENDENTE' FOR UPDATE", [sagaId]);
  if (!r) return null;
  const a = await mudarStatus(c, r.id, 'CANCELADO', motivo);
  const s = await soltarSlot(c, r.slot_id);
  if (s) await eventoSlot(c, ctx, s, 'SlotLiberado', 'liberado', r.id);
  return a;
}

async function confirmar(c, ctx, id) {
  exigir(await buscarComTrava(c, id), 'confirmar');
  const a = await mudarStatus(c, id, 'CONFIRMADO');
  await eventoAgendamento(c, ctx, a, 'AgendamentoConfirmado', 'confirmado');
  return a;
}

async function cancelar(c, ctx, id, motivo) {
  const antes = await buscarComTrava(c, id);
  exigir(antes, 'cancelar');
  const a = await mudarStatus(c, id, 'CANCELADO', motivo || 'Cancelado pelo paciente');
  await eventoAgendamento(c, ctx, a, 'AgendamentoCancelado', 'cancelado');
  const s = await soltarSlot(c, antes.slot_id);
  if (s) await eventoSlot(c, ctx, s, 'SlotLiberado', 'liberado', id);
  return a;
}

async function reagendar(c, ctx, id, novoSlotId) {
  const antes = await buscarComTrava(c, id);
  exigir(antes, 'reagendar');
  if (novoSlotId === antes.slot_id) throw new Problema(409, 'Slot indisponível', 'O novo horário é o mesmo do agendamento atual.');
  const novo = await ocuparSlot(c, novoSlotId);
  if (novo.especialidade !== antes.especialidade) throw new Problema(409, 'Especialidade diferente', 'O novo horário é de outra especialidade.');
  await c.query("UPDATE agendamentos SET slot_id=$2, status='AGENDADO', version=version+1, atualizado_em=now() WHERE id=$1", [id, novoSlotId]);
  const a = await buscar(c, id);
  await eventoAgendamento(c, ctx, a, 'AgendamentoReagendado', 'reagendado', { slotAnteriorId: antes.slot_id });
  await eventoSlot(c, ctx, novo, 'SlotReservado', 'reservado', id);
  const solto = await soltarSlot(c, antes.slot_id);
  if (solto) await eventoSlot(c, ctx, solto, 'SlotLiberado', 'liberado', id);
  return a;
}

async function registrarComparecimento(c, ctx, id, compareceu) {
  const antes = await buscarComTrava(c, id);
  if (!COMPARECIMENTO_DE.includes(antes.status)) throw new Problema(409, 'Transição de estado inválida', `Agendamento ${antes.status}.`);
  const a = await mudarStatus(c, id, compareceu ? 'REALIZADO' : 'FALTOU');
  await eventoAgendamento(c, ctx, a, compareceu ? 'AtendimentoRealizado' : 'FaltaRegistrada', compareceu ? 'realizado' : 'faltou');
  return a;
}

// Gera os slots das proximas `semanas`. Horarios ja existentes ou sobrepostos sao ignorados.
async function criarEscala(c, ctx, e) {
  const { rows: [prof] } = await c.query('SELECT * FROM profissionais WHERE id=$1', [e.profissionalId]);
  const { rows: [ubs] } = await c.query('SELECT * FROM ubs WHERE id=$1', [e.ubsId]);
  if (!prof || !ubs) throw new Problema(422, 'Dados inválidos', 'Profissional ou UBS inexistente.');
  const { rows: slots } = await c.query(
    `WITH dias AS (
       SELECT d::date AS dia
         FROM generate_series((now() AT TIME ZONE 'America/Sao_Paulo')::date,
                              (now() AT TIME ZONE 'America/Sao_Paulo')::date + ($7::int * 7 - 1), interval '1 day') d
        WHERE extract(isodow FROM d) = $4::int),
     horarios AS (
       SELECT (dia + t) AT TIME ZONE 'America/Sao_Paulo' AS inicio
         FROM dias, LATERAL (SELECT $5::time + n * make_interval(mins => $8::int) AS t
                               FROM generate_series(0, (extract(epoch FROM $6::time - $5::time) / 60 / $8::int)::int) n
                              WHERE extract(epoch FROM $5::time) + (n + 1) * $8::int * 60 <= extract(epoch FROM $6::time)) x)
     INSERT INTO slots (ubs_id, profissional_id, especialidade, inicio, fim)
     SELECT $1, $2, $3, inicio, inicio + make_interval(mins => $8::int) FROM horarios WHERE inicio > now()
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [e.ubsId, e.profissionalId, prof.especialidade, e.diaSemana, e.horaInicio, e.horaFim, e.semanas, e.duracaoSlotMin]);
  const { rows: [{ id }] } = await c.query('SELECT gen_random_uuid() AS id');
  if (slots.length) {
    await evento(c, ctx, 'EscalaCriada', 'escala.criada', 'Escala', id, 1, {
      ubs: { id: ubs.id, nome: ubs.nome, regiao: ubs.regiao },
      profissional: { id: prof.id, nome: prof.nome, especialidade: prof.especialidade },
      slots: slots.map((s) => ({ id: s.id, inicio: s.inicio, fim: s.fim, version: s.version })),
    });
  }
  return { id, slotsGerados: slots.length };
}

module.exports = { ACOES, SELECT, detalhe, buscar, reservar, liberarReserva, confirmar, cancelar, reagendar, registrarComparecimento, criarEscala, eventoAgendamento, mudarStatus };
