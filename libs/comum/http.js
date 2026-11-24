// Base HTTP dos servicos: correlacao, log, saude, erros RFC 7807 e autorizacao.
const express = require('express');
const os = require('os');
const { randomUUID } = require('crypto');
const { Problema } = require('./erros');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inteiro = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const invalido = (detalhe) => new Problema(422, 'Dados invalidos', detalhe);
const rota = (fn) => (req, res, next) => fn(req, res).catch(next);

// Identidade injetada pelo gateway. O perfil 'servico' so existe na rede interna:
// o gateway descarta X-User-* vindos de fora.
function exigirPerfil(req, ...perfis) {
  if (!perfis.includes(req.get('X-User-Role'))) throw new Problema(403, 'Sem permissao', `Perfil exigido: ${perfis.join(' ou ')}.`);
}
function exigirDono(req, pacienteId) {
  const perfil = req.get('X-User-Role');
  if (perfil === 'gestor' || perfil === 'servico') return;
  if (perfil === 'paciente' && pacienteId && req.get('X-User-Id') === pacienteId) return;
  throw new Problema(403, 'Sem permissao');
}

// `pronto` devolve um objeto { dependencia: 'up'|'down' }; `essencial` e a que define 200/503.
function criarApp({ nome, rotas, pronto, essencial = 'db', metricas, prefixo = '/api/v1' }) {
  const instance = os.hostname();
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.correlationId = req.get('X-Correlation-Id') || randomUUID();
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
  app.use((_req, _res, next) => next(new Problema(404, 'Recurso nao encontrado')));
  app.use((e, req, res, _next) => {
    const jsonInvalido = e.type === 'entity.parse.failed';
    const status = e instanceof Problema ? e.status : jsonInvalido ? 400 : 500;
    if (status === 500) console.error(JSON.stringify({ nivel: 'erro', servico: nome, correlationId: req.correlationId, erro: e.stack }));
    res.status(status).type('application/problem+json').json({
      type: 'about:blank', title: e instanceof Problema ? e.title : jsonInvalido ? 'JSON invalido' : 'Erro interno',
      status, detail: e instanceof Problema ? e.detail : undefined, correlationId: req.correlationId,
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

module.exports = { UUID, inteiro, invalido, rota, exigirPerfil, exigirDono, criarApp, aoEncerrar };
