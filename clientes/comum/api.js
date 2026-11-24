// Acesso ao BFF. Mesma origem do gateway: sem CORS e sem endereco fixo no codigo.

export class ErroApi extends Error {
  constructor(status, titulo, detalhe, correlacao) {
    super(detalhe || titulo);
    this.status = status;
    this.titulo = titulo;
    this.correlacao = correlacao;
  }
}

// Dados do token, so para a tela. Quem confere a assinatura e o gateway.
export function lerToken(token) {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

// O token fica so nesta aba e some ao fecha-la.
export function criarSessao(chave) {
  const ler = () => { try { return sessionStorage.getItem(chave); } catch { return null; } };
  const ouvintes = new Set();
  const gravar = (v) => {
    try { if (v) sessionStorage.setItem(chave, v); else sessionStorage.removeItem(chave); } catch { /* sem armazenamento: vale ate recarregar */ }
    atual = v;
    ouvintes.forEach((f) => f());
  };
  const vale = (t) => { const d = t && lerToken(t); return d && d.exp * 1000 > Date.now() ? t : null; };
  let atual = vale(ler());
  return { token: () => atual, entrar: gravar, sair: () => gravar(null), ouvir: (f) => { ouvintes.add(f); return () => ouvintes.delete(f); } };
}

async function ler(r) {
  const texto = await r.text();
  let corpo = null;
  try { corpo = texto ? JSON.parse(texto) : null; } catch { /* corpo que nao e JSON */ }
  if (r.ok) return corpo;
  const espera = r.headers.get('Retry-After');
  if (r.status === 429) throw new ErroApi(429, 'Muitas requisições', `Aguarde ${espera || 'alguns'} segundos e tente de novo.`);
  throw new ErroApi(r.status, (corpo && corpo.title) || 'Erro', corpo && corpo.detail, r.headers.get('X-Correlation-Id'));
}

async function buscar(caminho, opcoes) {
  try {
    return await fetch(caminho, opcoes);
  } catch {
    throw new ErroApi(0, 'Sem conexão', 'Não foi possível falar com o servidor. Verifique a internet.');
  }
}

export async function login(cpf, senha) {
  const r = await buscar('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cpf, senha }) });
  return (await ler(r)).accessToken;
}

export function criarApi(sessao) {
  async function pedir(metodo, caminho, corpo, cabecalhos) {
    const r = await buscar(caminho, {
      method: metodo,
      headers: { Authorization: `Bearer ${sessao.token()}`, ...(corpo ? { 'content-type': 'application/json' } : {}), ...cabecalhos },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 401) sessao.sair();
    return ler(r);
  }
  return {
    get: (c) => pedir('GET', c),
    post: (c, corpo, cabecalhos) => pedir('POST', c, corpo || {}, cabecalhos),
    seguir: (link, corpo) => pedir(link.method, link.href, link.method === 'GET' ? undefined : corpo || {}), // _links recebidos
  };
}

// randomUUID so existe em origem segura; fora do localhost a demonstracao usa HTTP.
export function novoId() {
  if (globalThis.crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}
