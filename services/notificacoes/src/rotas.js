const express = require('express');
const { Problema } = require('../../../libs/comum/erros');
const { UUID, inteiro, invalido, exigirPerfil, exigirDono, rota } = require('../../../libs/comum/http');
const { CANAIS } = require('./loja');

const STATUS = ['AGENDADA', 'ENVIADA', 'FALHA', 'CANCELADA'];
const canaisValidos = (c) => Array.isArray(c) && c.length > 0 && c.length <= CANAIS.length && c.every((x) => CANAIS.includes(x));

function criarRotas({ loja }) {
  const r = express.Router();

  // --- SAGA (so a rede interna chega aqui com perfil 'servico')
  r.post('/notificacoes', rota(async (req, res) => {
    exigirPerfil(req, 'servico');
    const sagaId = req.get('X-Saga-Id');
    if (!UUID.test(sagaId)) throw new Problema(400, 'X-Saga-Id obrigatório');
    const { pacienteId, agendamentoId, dataConsulta, canais } = req.body;
    if (!UUID.test(pacienteId) || !UUID.test(agendamentoId)) throw invalido('pacienteId e agendamentoId devem ser UUID.');
    if (typeof dataConsulta !== 'string' || Number.isNaN(Date.parse(dataConsulta))) throw invalido('dataConsulta inválida.');
    if (canais !== undefined && !canaisValidos(canais)) throw invalido(`canais deve conter: ${CANAIS.join(', ')}.`);
    const l = await loja.criar({ pacienteId, agendamentoId, dataConsulta, canais, sagaId });
    if (!l) throw new Problema(409, 'SAGA já encerrada');
    res.status(201).json(l);
  }));
  r.delete('/notificacoes', rota(async (req, res) => {
    exigirPerfil(req, 'servico');
    if (!UUID.test(req.query.sagaId)) throw new Problema(400, 'Parâmetros inválidos', 'sagaId é obrigatório.');
    await loja.cancelarSaga(req.query.sagaId);
    res.status(204).end();
  }));

  // --- Consultas
  r.get('/notificacoes', rota(async (req, res) => {
    const { pacienteId, status } = req.query;
    if (!UUID.test(pacienteId)) throw new Problema(400, 'Parâmetros inválidos', 'pacienteId é obrigatório.');
    if (status !== undefined && !STATUS.includes(status)) throw new Problema(400, 'Parâmetros inválidos', 'status inválido.');
    exigirDono(req, pacienteId);
    res.json(await loja.doPaciente(pacienteId, status));
  }));
  r.get('/notificacoes/alertas', rota(async (req, res) => {
    exigirPerfil(req, 'gestor');
    res.json(await loja.alertas());
  }));
  r.get('/notificacoes/:id', rota(async (req, res) => {
    const n = UUID.test(req.params.id) ? await loja.buscar(req.params.id) : null;
    if (!n) throw new Problema(404, 'Notificação não encontrada');
    exigirDono(req, n.pacienteId);
    res.json(n);
  }));

  const dono = (req) => {
    if (!UUID.test(req.params.pacienteId)) throw new Problema(404, 'Paciente não encontrado');
    exigirDono(req, req.params.pacienteId);
    return req.params.pacienteId;
  };
  r.get('/pacientes/:pacienteId/preferencias-notificacao', rota(async (req, res) => res.json(await loja.preferencias(dono(req)))));
  r.put('/pacientes/:pacienteId/preferencias-notificacao', rota(async (req, res) => {
    const id = dono(req);
    const { canais, antecedenciaLembreteHoras = 24 } = req.body;
    if (!canaisValidos(canais)) throw invalido(`canais deve conter ao menos um de: ${CANAIS.join(', ')}.`);
    if (!inteiro(antecedenciaLembreteHoras, 3, 168)) throw invalido('antecedenciaLembreteHoras deve ser de 3 a 168.');
    const p = { canais: [...new Set(canais)], antecedenciaLembreteHoras };
    await loja.salvarPreferencias(id, p);
    res.json(p);
  }));
  return r;
}

module.exports = { criarRotas };
