// Regras do dominio. As funcoes que alteram estado recebem o cliente de uma transacao.
const { Problema } = require('../../../libs/comum/erros');
const { gravarEvento } = require('../../../libs/comum/outbox');

async function publicarAtualizacao(c, ctx, p) {
  // So o necessario para exibicao em outros servicos (LGPD: minimizacao).
  await gravarEvento(c, {
    tipo: 'PacienteAtualizado', rota: 'pacientes.paciente.atualizado', agregado: 'Paciente', agregadoId: p.id, versao: p.version,
    payload: { pacienteId: p.id, nome: p.nome }, correlationId: ctx.correlationId,
  });
}

async function cadastrar(c, ctx, d, senhaHash) {
  const { rows: [p] } = await c.query(
    `INSERT INTO pacientes (id, nome, cpf, data_nascimento, email, telefone, bairro, ubs_referencia_id, senha_hash)
     VALUES (COALESCE($1, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (cpf) DO NOTHING RETURNING *`,
    [d.id || null, d.nome, d.cpf, d.dataNascimento, d.email, d.telefone || null, d.bairro || null, d.ubsReferenciaId || null, senhaHash]);
  if (!p) throw new Problema(409, 'CPF ja cadastrado');
  await publicarAtualizacao(c, ctx, p);
  return p;
}

async function atualizar(c, ctx, id, d) {
  const { rows: [p] } = await c.query(
    `UPDATE pacientes SET nome=COALESCE($2,nome), email=COALESCE($3,email), telefone=COALESCE($4,telefone),
            bairro=COALESCE($5,bairro), ubs_referencia_id=COALESCE($6,ubs_referencia_id), version=version+1
      WHERE id=$1 RETURNING *`,
    [id, d.nome, d.email, d.telefone, d.bairro, d.ubsReferenciaId]);
  if (!p) throw new Problema(404, 'Paciente nao encontrado');
  await publicarAtualizacao(c, ctx, p);
  return p;
}

// SAGA passo 2. Idempotente para a mesma SAGA.
async function validar(c, id, sagaId) {
  // A trava serializa com a compensacao da mesma SAGA.
  const { rows: [p] } = await c.query('SELECT ativo, agendamento_saga_id FROM pacientes WHERE id=$1 FOR UPDATE', [id]);
  if (!p) throw new Problema(404, 'Paciente nao encontrado');
  if (!p.ativo) throw new Problema(409, 'Paciente inativo');
  const { rowCount: encerrada } = await c.query('SELECT 1 FROM sagas_encerradas WHERE saga_id=$1', [sagaId]);
  if (encerrada) throw new Problema(409, 'SAGA ja encerrada');
  if (p.agendamento_saga_id && p.agendamento_saga_id !== sagaId) throw new Problema(409, 'Agendamento em andamento', 'O paciente ja tem um agendamento em andamento.');
  await c.query('UPDATE pacientes SET agendamento_saga_id=$2 WHERE id=$1', [id, sagaId]);
}

// Limpa a flag se for desta SAGA: compensacao do passo 2 ou fim com sucesso.
async function encerrarSaga(c, id, sagaId) {
  await c.query('SELECT 1 FROM pacientes WHERE id=$1 FOR UPDATE', [id]);
  await c.query('INSERT INTO sagas_encerradas (saga_id) VALUES ($1) ON CONFLICT DO NOTHING', [sagaId]);
  await c.query('UPDATE pacientes SET agendamento_saga_id=NULL WHERE id=$1 AND agendamento_saga_id=$2', [id, sagaId]);
}

async function tratarEvento(c, e) {
  const p = e.payload;
  if (e.eventType === 'AgendamentoCriado') return encerrarSaga(c, p.pacienteId, p.sagaId);
  if (e.eventType === 'AtendimentoRealizado' || e.eventType === 'FaltaRegistrada') {
    await c.query(
      `INSERT INTO atendimentos (agendamento_id, paciente_id, data, especialidade, ubs, status) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (agendamento_id) DO UPDATE SET status=EXCLUDED.status, data=EXCLUDED.data`,
      [p.agendamentoId, p.pacienteId, p.slot.inicio, p.profissional.especialidade, p.ubs.nome, e.eventType === 'FaltaRegistrada' ? 'FALTOU' : 'REALIZADO']);
  }
}

const MINIMO_GRUPO = 5;
// Grupos pequenos sao suprimidos e os numeros arredondados para multiplos de 5: sem isso,
// o grupo oculto sairia por subtracao do total.
async function estatisticas(c, ubsId) {
  const arredonda = (n) => Math.round(n / 5) * 5;
  const grupos = async (expr) => {
    const { rows } = await c.query(`SELECT ${expr} AS g, count(*)::int AS n FROM pacientes WHERE ubs_referencia_id=$1 AND ativo GROUP BY 1 ORDER BY 1`, [ubsId]);
    return Object.fromEntries(rows.filter((r) => r.g && r.n >= MINIMO_GRUPO).map((r) => [r.g, arredonda(r.n)]));
  };
  const { rows: [{ total }] } = await c.query('SELECT count(*)::int AS total FROM pacientes WHERE ubs_referencia_id=$1 AND ativo', [ubsId]);
  const idade = "date_part('year', age(data_nascimento))";
  return {
    ubsId,
    totalPacientes: total >= MINIMO_GRUPO ? arredonda(total) : 0,
    porFaixaEtaria: await grupos(`CASE WHEN ${idade} < 12 THEN '0-11' WHEN ${idade} < 18 THEN '12-17' WHEN ${idade} < 60 THEN '18-59' ELSE '60+' END`),
    porBairro: await grupos('bairro'),
  };
}

module.exports = { cadastrar, atualizar, validar, encerrarSaga, tratarEvento, estatisticas };
