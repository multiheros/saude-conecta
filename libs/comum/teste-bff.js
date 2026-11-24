// Apoio aos testes dos BFFs: um dominio falso que registra o que recebeu.
const http = require('http');

async function dominioFalso() {
  const d = { respostas: {}, pedidos: [], atraso: {} };
  const srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', async () => {
      const caminho = req.url.split('?')[0], chave = `${req.method} ${caminho}`;
      d.pedidos.push({ chave, url: req.url, headers: req.headers, corpo: corpo ? JSON.parse(corpo) : null });
      if (d.atraso[chave]) await new Promise((ok) => setTimeout(ok, d.atraso[chave]));
      let r = d.respostas[chave];
      if (typeof r === 'function') r = r(req.url, corpo && JSON.parse(corpo));
      const [status, valor] = Array.isArray(r) && typeof r[0] === 'number' ? r : r === undefined ? [404, { title: `sem resposta para ${chave}` }] : [200, r];
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(valor));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  d.url = `http://127.0.0.1:${srv.address().port}`;
  d.fechar = () => new Promise((ok) => { srv.close(ok); srv.closeAllConnections(); });
  return d;
}

// Sobe o app e devolve um cliente que age como o gateway (injeta a identidade).
async function servir(app, identidade) {
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const pedir = async (metodo, caminho, corpo, headers = identidade) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { 'content-type': 'application/json', ...headers }, body: corpo && JSON.stringify(corpo) });
    const texto = await r.text();
    return { status: r.status, headers: r.headers, corpo: texto ? JSON.parse(texto) : null };
  };
  return { pedir, fechar: () => new Promise((ok) => { srv.close(ok); srv.closeAllConnections(); }) };
}

module.exports = { dominioFalso, servir };
