import { useEffect, useState } from 'react';
import { Carregando, Erro } from '../../../comum/ui.jsx';
import { api } from '../sessao.js';

const SITUACAO = {
  AGUARDANDO: ['…', 'aguardando'], CONCLUIDO: ['✓', 'concluído'], FALHOU: ['✕', 'não deu certo'],
  DESFEITO: ['↺', 'desfeito'], NAO_EXECUTADO: ['–', 'não foi necessário'],
};
const INTERVALO = 800, LIMITE_FALHAS = 5;

export default function Andamento({ id }) {
  const [a, setA] = useState(null);
  const [erro, setErro] = useState(null);
  const [vez, setVez] = useState(0);
  useEffect(() => {
    let vivo = true, falhas = 0, relogio;
    async function consultar() {
      try {
        const r = await api.get(`/web/v1/agendamentos/${id}/andamento`);
        if (!vivo) return;
        falhas = 0;
        setA(r);
        setErro(null);
        if (r.terminou) return;
      } catch (e) {
        if (!vivo) return;
        if (++falhas >= LIMITE_FALHAS) { setErro(e); return; }
      }
      relogio = setTimeout(consultar, INTERVALO * (1 + falhas));
    }
    consultar();
    return () => { vivo = false; clearTimeout(relogio); };
  }, [id, vez]);

  if (!a) return erro ? <Erro erro={erro} tentar={() => setVez(vez + 1)} /> : <Carregando texto="Enviando o seu pedido…" />;
  const ok = a.estado === 'CONCLUIDA', falhou = a.terminou && !ok, desfazendo = ['COMPENSANDO', 'COMPENSACAO_PENDENTE'].includes(a.estado);
  return (
    <>
      <h1>{ok ? 'Consulta marcada' : falhou ? 'Não foi possível marcar' : desfazendo ? 'Algo deu errado, estamos desfazendo' : 'Marcando a sua consulta'}</h1>
      <ol className="passos" aria-label="Etapas do agendamento">
        {a.passos.map((p) => (
          <li key={p.nome} className={`p-${p.situacao.toLowerCase()}`}>
            <span className="bola" aria-hidden="true">{SITUACAO[p.situacao][0]}</span>
            <span>{p.nome}<br /><span className="miudo">{SITUACAO[p.situacao][1]}</span></span>
          </li>
        ))}
      </ol>
      <div role="status">
        {falhou && <div className="aviso aviso-alerta"><strong>{a.motivo || 'O pedido não pôde ser concluído.'}</strong><p>Nada ficou reservado no seu nome.</p></div>}
      </div>
      <Erro erro={erro} tentar={() => setVez(vez + 1)} />
      <p className="acoes">
        {ok && <a className="botao" href={`#/agendamentos/${id}`}>Ver a consulta</a>}
        {falhou && <a className="botao" href="#/nova">Tentar de novo</a>}
        {a.terminou && <a className="botao secundario" href="#/">Início</a>}
      </p>
    </>
  );
}
