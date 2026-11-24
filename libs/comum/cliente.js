// Cliente HTTP entre servicos. Diz se uma falha PODE ter chegado ao destino:
//   naoEnviado = true  -> a conexao nunca abriu; o destino certamente nao executou nada;
//   naoEnviado = false -> ambigua (timeout, queda no meio, 5xx); o destino pode ter executado.
const http = require('http');

class FalhaRemota extends Error {
  constructor(msg, { naoEnviado = false, status = null } = {}) { super(msg); this.remota = true; this.naoEnviado = naoEnviado; this.status = status; }
}

// Devolve { status, corpo } para 2xx e 4xx. Lanca FalhaRemota para rede, timeout e 5xx.
function chamar(metodo, url, { corpo, headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((ok, erro) => {
    let conectou = false, acabou = false;
    const dados = corpo === undefined ? null : Buffer.from(JSON.stringify(corpo));
    const fim = (fn, v) => { if (acabou) return; acabou = true; clearTimeout(prazo); fn(v); };
    // agent: false -> conexao nova a cada chamada: um socket reaproveitado e ja morto
    // tornaria ambigua uma falha que nao e.
    const req = http.request(url, { method: metodo, agent: false, headers: { accept: 'application/json', ...(dados ? { 'content-type': 'application/json', 'content-length': dados.length } : {}), ...headers } }, (res) => {
      const partes = [];
      res.on('data', (d) => partes.push(d));
      res.on('error', (e) => fim(erro, new FalhaRemota(e.message)));
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString();
        let json = null;
        try { json = texto ? JSON.parse(texto) : null; } catch { /* corpo nao JSON */ }
        if (res.statusCode >= 500 || res.statusCode === 429) return fim(erro, new FalhaRemota(`HTTP ${res.statusCode}`, { status: res.statusCode }));
        fim(ok, { status: res.statusCode, corpo: json });
      });
    });
    const prazo = setTimeout(() => { fim(erro, new FalhaRemota(`sem resposta em ${timeoutMs} ms`, { naoEnviado: !conectou })); req.destroy(); }, timeoutMs);
    req.on('socket', (s) => s.once('connect', () => { conectou = true; }));
    req.on('error', (e) => fim(erro, new FalhaRemota(e.code || e.message, { naoEnviado: !conectou })));
    req.end(dados);
  });
}

module.exports = { chamar, FalhaRemota };
