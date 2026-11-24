// Base dos BFFs: chamada aos servicos de dominio em nome do usuario, com degradacao graciosa.
const { chamar } = require('./cliente');
const { Problema } = require('./erros');
const { UUID } = require('./http');

// Barreira propria do BFF, alem da do gateway.
function exigir(perfil) {
  return (req, _res, next) => next(req.get('X-User-Role') === perfil && UUID.test(req.get('X-User-Id')) ? undefined : new Problema(403, 'Sem permissao'));
}

// Repassa a identidade e a correlacao. Recusa do dominio (4xx) volta igual; falha vira 503 ou 504.
async function pedir(req, metodo, url, { corpo, headers, timeoutMs = 3000 } = {}) {
  let r;
  try {
    r = await chamar(metodo, url, { corpo, timeoutMs, headers: { 'X-User-Id': req.get('X-User-Id'), 'X-User-Role': req.get('X-User-Role'), 'X-Correlation-Id': req.correlationId, ...headers } });
  } catch (e) {
    if (!e.remota) throw e;
    console.error(JSON.stringify({ nivel: 'erro', msg: 'dominio indisponivel', correlationId: req.correlationId, url: url.split('?')[0], erro: e.message }));
    throw /^sem resposta/.test(e.message) ? new Problema(504, 'Servico nao respondeu a tempo') : new Problema(503, 'Servico indisponivel');
  }
  if (r.status >= 400) throw new Problema(r.status, (r.corpo && r.corpo.title) || 'Pedido recusado', r.corpo && r.corpo.detail);
  return r.corpo;
}

// Parte dispensavel da resposta: sem ela, a tela abre assim mesmo.
const opcional = (promessa) => promessa.catch((e) => { if (e instanceof Problema) return null; throw e; });

module.exports = { exigir, pedir, opcional };
