const express = require('express');
const jwt = require('jsonwebtoken');
const { transacao } = require('../../../libs/comum/db');
const { Problema } = require('../../../libs/comum/erros');
const { UUID, inteiro, invalido, exigirPerfil, exigirDono, rota } = require('../../../libs/comum/http');
const dominio = require('./pacientes');
const { gerarHash, conferir } = require('./senha');
const { cpfValido } = require('./cpf');

const EXPIRA_EM = 3600;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFONE = /^\+?\d{10,15}$/;
const texto = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;

const dia = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
function dataValida(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) && d < new Date() && d.getUTCFullYear() >= 1900;
}

const representar = (p) => ({
  id: p.id, nome: p.nome, cpf: p.cpf, dataNascimento: dia(p.data_nascimento), email: p.email, telefone: p.telefone, bairro: p.bairro,
  ubsReferenciaId: p.ubs_referencia_id, ativo: p.ativo, criadoEm: p.criado_em,
});

// Campos comuns a cadastro e atualizacao; `exigir` diz se sao obrigatorios.
function validarCampos(d, exigir) {
  const testar = (campo, ok, obrigatorio, msg) => {
    if (d[campo] === undefined ? obrigatorio : !ok(d[campo])) throw invalido(msg);
  };
  testar('nome', (v) => texto(v, 3, 120), exigir, 'nome deve ter de 3 a 120 caracteres.');
  testar('email', (v) => texto(v, 5, 160) && EMAIL.test(v), exigir, 'email invalido.');
  testar('telefone', (v) => TELEFONE.test(v), false, 'telefone invalido.');
  testar('bairro', (v) => texto(v, 1, 80), false, 'bairro invalido.');
  testar('ubsReferenciaId', (v) => UUID.test(v), false, 'ubsReferenciaId deve ser UUID.');
}

function criarRotas({ pool, chavePrivada }) {
  const r = express.Router();
  // Comparado quando o CPF nao existe, para o tempo de resposta nao revelar quem tem cadastro.
  const hashFalso = gerarHash('x');

  r.param('id', (req, _res, next, id) => next(UUID.test(id) ? undefined : new Problema(404, 'Paciente nao encontrado')));
  const sagaDe = (req) => {
    const s = req.get('X-Saga-Id');
    if (!UUID.test(s)) throw new Problema(400, 'X-Saga-Id obrigatorio');
    return s;
  };

  r.post('/auth/login', rota(async (req, res) => {
    const { cpf, senha } = req.body;
    if (typeof cpf !== 'string' || typeof senha !== 'string' || senha.length > 200) throw new Problema(401, 'Credenciais invalidas');
    const { rows: [u] } = await pool.query(
      `SELECT id, senha_hash, 'paciente' AS role FROM pacientes WHERE cpf=$1 AND ativo
       UNION ALL SELECT id, senha_hash, 'gestor' FROM gestores WHERE cpf=$1 AND ativo
       ORDER BY role LIMIT 1`, [cpf]);
    const ok = await conferir(senha, u ? u.senha_hash : await hashFalso);
    if (!u || !ok) throw new Problema(401, 'Credenciais invalidas');
    // `iss` por perfil: e a chave que o gateway usa para escolher o consumidor e suas rotas.
    const accessToken = jwt.sign({ role: u.role }, chavePrivada, { algorithm: 'RS256', subject: u.id, issuer: `saudeconecta-${u.role}`, audience: 'saudeconecta', expiresIn: EXPIRA_EM });
    res.set('Cache-Control', 'no-store').json({ accessToken, tokenType: 'Bearer', expiresIn: EXPIRA_EM });
  }));

  r.post('/pacientes', rota(async (req, res) => {
    const d = req.body;
    validarCampos(d, true);
    if (!cpfValido(d.cpf)) throw invalido('cpf invalido.');
    if (!dataValida(d.dataNascimento)) throw invalido('dataNascimento deve ser AAAA-MM-DD e anterior a hoje.');
    if (!texto(d.senha, 8, 200)) throw invalido('senha deve ter de 8 a 200 caracteres.');
    const hash = await gerarHash(d.senha);
    const p = await transacao(pool, (c) => dominio.cadastrar(c, { correlationId: req.correlationId }, { ...d, id: undefined }, hash));
    res.status(201).location(`/api/v1/pacientes/${p.id}`).json(representar(p));
  }));

  r.get('/pacientes', rota(async (req, res) => {
    exigirPerfil(req, 'gestor');
    const page = Number(req.query.page || 1), size = Number(req.query.size || 20);
    if (!inteiro(page, 1, 1e6) || !inteiro(size, 1, 100)) throw new Problema(400, 'Parametros invalidos', 'page >= 1 e size de 1 a 100.');
    const { rows } = await pool.query('SELECT * FROM pacientes ORDER BY nome, id LIMIT $1 OFFSET $2', [size, (page - 1) * size]);
    const { rows: [{ total }] } = await pool.query('SELECT count(*)::int AS total FROM pacientes');
    res.json({ items: rows.map(representar), page, size, total });
  }));

  r.get('/pacientes/estatisticas', rota(async (req, res) => {
    exigirPerfil(req, 'gestor');
    if (!UUID.test(req.query.ubsId)) throw new Problema(400, 'Parametros invalidos', 'ubsId e obrigatorio.');
    res.json(await dominio.estatisticas(pool, req.query.ubsId));
  }));

  r.get('/pacientes/:id', rota(async (req, res) => {
    exigirDono(req, req.params.id);
    const { rows: [p] } = await pool.query('SELECT * FROM pacientes WHERE id=$1', [req.params.id]);
    if (!p) throw new Problema(404, 'Paciente nao encontrado');
    res.json(representar(p));
  }));

  r.put('/pacientes/:id', rota(async (req, res) => {
    exigirDono(req, req.params.id);
    validarCampos(req.body, false);
    res.json(representar(await transacao(pool, (c) => dominio.atualizar(c, { correlationId: req.correlationId }, req.params.id, req.body))));
  }));

  r.get('/pacientes/:id/historico', rota(async (req, res) => {
    exigirDono(req, req.params.id);
    const { rowCount } = await pool.query('SELECT 1 FROM pacientes WHERE id=$1', [req.params.id]);
    if (!rowCount) throw new Problema(404, 'Paciente nao encontrado');
    const { rows } = await pool.query('SELECT agendamento_id AS "agendamentoId", data, especialidade, ubs, status FROM atendimentos WHERE paciente_id=$1 ORDER BY data DESC LIMIT 100', [req.params.id]);
    res.json(rows);
  }));

  // --- SAGA (so a rede interna chega aqui com perfil 'servico')
  r.post('/pacientes/:id/validacao', rota(async (req, res) => {
    exigirPerfil(req, 'servico');
    const sagaId = sagaDe(req);
    await transacao(pool, (c) => dominio.validar(c, req.params.id, sagaId));
    res.json({ valido: true, agendamentoEmAndamento: true });
  }));
  r.delete('/pacientes/:id/validacao', rota(async (req, res) => {
    exigirPerfil(req, 'servico');
    const sagaId = sagaDe(req);
    await transacao(pool, (c) => dominio.encerrarSaga(c, req.params.id, sagaId));
    res.status(204).end();
  }));
  return r;
}

module.exports = { criarRotas };
