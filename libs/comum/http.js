// Base HTTP dos servicos: correlacao, log, saude, erros RFC 7807 e autorizacao.
const express = require('express');
const os = require('os');
const { randomUUID } = require('crypto');
const { Problema } = require('./erros');

// So texto casa: RegExp.test converteria ["x"] em "x" e a lista chegaria ao banco.
const padrao = (re) => ({ test: (v) => typeof v === 'string' && re.test(v) });
const UUID = padrao(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const inteiro = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const invalido = (detalhe) => new Problema(422, 'Dados inválidos', detalhe);
const rota = (fn) => (req, res, next) => fn(req, res).catch(next);

// Identidade injetada pelo gateway. O perfil 'servico' so existe na rede interna:
// o gateway descarta X-User-* vindos de fora.
function exigirPerfil(req, ...perfis) {
  if (!perfis.includes(req.get('X-User-Role'))) throw new Problema(403, 'Sem permissão', `Perfil exigido: ${perfis.join(' ou ')}.`);
}
function exigirDono(req, pacienteId) {
  const perfil = req.get('X-User-Role');
  if (perfil === 'gestor' || perfil === 'servico') return;
  if (perfil === 'paciente' && pacienteId && req.get('X-User-Id') === pacienteId) return;
  throw new Problema(403, 'Sem permissão');
}

// Erros do pedido que chegam como excecao: corpo recusado pelo Express e texto que o PostgreSQL nao aceita (byte nulo).
function traduzir(e) {
  if (e.type === 'entity.parse.failed') return new Problema(400, 'JSON inválido');
  if (e.type === 'entity.too.large') return new Problema(413, 'Corpo grande demais');
  if (e.expose && e.status >= 400 && e.status < 500) return new Problema(e.status, 'Requisição inválida');
  return e.code === '22021' ? invalido('O texto contém um caractere não permitido.') : null;
}

// `pronto` devolve um objeto { dependencia: 'up'|'down' }; `essencial` e a que define 200/503.
function criarApp({ nome, rotas, pronto, essencial = 'db', metricas, prefixo = '/api/v1' }) {
  const instance = os.hostname();
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.correlationId = (req.get('X-Correlation-Id') || randomUUID()).slice(0, 64); // cabe na coluna; pode vir de fora
    res.set('X-Correlation-Id', req.correlationId);
    res.set('X-Instance', instance); // qual replica respondeu
    const t0 = Date.now();
    res.on('finish', () => {
      if (['/live', '/ready'].includes(req.path)) return;
      console.log(JSON.stringify({ nivel: 'info', servico: nome, correlationId: req.correlationId, metodo: req.method, caminho: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - t0 }));
    });
    next();
  });
  app.use(express.json());

  // Vivo: o processo responde. Nao depende do banco, para nao ser reiniciado por falha alheia.
  app.get('/live', (_req, res) => res.json({ service: nome, status: 'ok', instance }));
  // Pronto: a dependencia essencial responde.
  app.get('/ready', async (_req, res) => {
    const deps = await pronto();
    const ok = deps[essencial] === 'up';
    res.status(ok ? 200 : 503).json({ service: nome, status: ok ? 'ok' : 'degraded', ...deps, instance });
  });
  if (metricas) app.get('/metricas', rota(async (_req, res) => res.json(await metricas())));

  app.use(prefixo, rotas);
  app.use((_req, _res, next) => next(new Problema(404, 'Recurso não encontrado')));
  app.use((e, req, res, _next) => {
    const p = e instanceof Problema ? e : traduzir(e);
    const status = p ? p.status : 500;
    if (status === 500) console.error(JSON.stringify({ nivel: 'erro', servico: nome, correlationId: req.correlationId, erro: e.stack }));
    res.status(status).type('application/problem+json').json({
      type: 'about:blank', title: p ? p.title : 'Erro interno', status, detail: p ? p.detail : undefined, correlationId: req.correlationId,
    });
  });
  return app;
}

// Encerra na ordem dada, com prazo. Chamado em SIGTERM/SIGINT.
function aoEncerrar(server, ...passos) {
  let encerrando = false;
  const fim = async () => {
    if (encerrando) return;
    encerrando = true;
    setTimeout(() => process.exit(1), 8000).unref();
    server.close();
    for (const p of passos) await p();
    process.exit(0);
  };
  process.on('SIGTERM', fim);
  process.on('SIGINT', fim);
}

module.exports = { UUID, padrao, inteiro, invalido, rota, exigirPerfil, exigirDono, criarApp, aoEncerrar };
