import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { lerToken, login } from './api.js';

export const useSessao = (sessao) => useSyncExternalStore(sessao.ouvir, sessao.token);

// Rota no fragmento da URL: #/agendamentos/123
export function useRota() {
  const rota = useSyncExternalStore((f) => { addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, () => location.hash.slice(1) || '/');
  return rota;
}
export const ir = (rota) => { location.hash = rota; };

// Carrega e guarda o ultimo valor bom: recarregar nao pisca a tela.
export function useCarga(funcao, dependencias) {
  const [estado, setEstado] = useState({ valor: null, erro: null, carregando: true });
  const vez = useRef(0);
  const carregar = useCallback(async () => {
    const minha = ++vez.current;
    setEstado((e) => ({ ...e, carregando: true }));
    try {
      const valor = await funcao();
      if (minha === vez.current) setEstado({ valor, erro: null, carregando: false });
    } catch (erro) {
      if (minha === vez.current) setEstado((e) => ({ ...e, erro, carregando: false }));
    }
    // eslint-disable-next-line
  }, dependencias);
  useEffect(() => { carregar(); return () => { vez.current++; }; }, [carregar]);
  return { ...estado, recarregar: carregar };
}

export function Erro({ erro, tentar }) {
  if (!erro) return null;
  return (
    <div className="aviso aviso-erro" role="alert">
      <strong>{erro.titulo || 'Algo deu errado'}</strong>
      <p>{erro.message}</p>
      {erro.correlacao && <p className="miudo">Código para o suporte: {erro.correlacao}</p>}
      {tentar && <button className="botao secundario" onClick={tentar}>Tentar de novo</button>}
    </div>
  );
}

export const Carregando = ({ texto = 'Carregando…' }) => <p className="carregando" role="status">{texto}</p>;

export function Entrar({ sessao, titulo, texto, perfil }) {
  const [cpf, setCpf] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);
  async function enviar(e) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      const token = await login(cpf.replace(/\D/g, ''), senha);
      if (lerToken(token)?.role !== perfil) throw Object.assign(new Error(perfil === 'gestor' ? 'Este painel é só para gestores.' : 'Gestores entram pelo painel, em /painel.'), { titulo: 'Acesso não permitido' });
      sessao.entrar(token);
    } catch (x) {
      setErro(x.status === 401 ? Object.assign(x, { titulo: 'CPF ou senha incorretos', message: 'Confira os dados e tente de novo.' }) : x);
    } finally {
      setEnviando(false);
    }
  }
  return (
    <main className="entrar">
      <form className="cartao" onSubmit={enviar}>
        <p className="marca"><span aria-hidden="true">✚</span> SaúdeConecta</p>
        <h1>{titulo}</h1>
        <p className="suave">{texto}</p>
        <label>CPF<input value={cpf} onChange={(e) => setCpf(e.target.value)} inputMode="numeric" autoComplete="username" required /></label>
        <label>Senha<input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="current-password" required /></label>
        <Erro erro={erro} />
        <button className="botao" disabled={enviando}>{enviando ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </main>
  );
}
