import { useState } from 'react';
import { Carregando, Erro, useCarga } from '../../../comum/ui.jsx';
import { api } from '../sessao.js';
import { Fontes, Horarios, Urgencia } from './pecas.jsx';

const BOTOES = { confirmar: 'Confirmar presença', reagendar: 'Trocar o horário', cancelar: 'Cancelar consulta' };

export default function Detalhe({ id }) {
  const [minima, setMinima] = useState(0); // versao da ultima escrita: a leitura espera por ela
  const { valor: a, erro, recarregar } = useCarga(() => api.get(`/web/v1/agendamentos/${id}?versaoMinima=${minima}`), [id, minima]);
  const [acao, setAcao] = useState(null);
  const [horarios, setHorarios] = useState(null);
  const [slot, setSlot] = useState(null);
  const [falha, setFalha] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  if (!a) return erro ? <Erro erro={erro} tentar={recarregar} /> : <Carregando />;

  async function tentar(f) {
    setFalha(null);
    setOcupado(true);
    try { await f(); } catch (e) { setFalha(e); recarregar(); } finally { setOcupado(false); }
  }
  const executar = (nome, corpo) => tentar(async () => {
    const r = await api.seguir(a._links[nome], corpo);
    setAcao(null);
    setMinima(r.versao);
  });
  function abrir(nome) {
    if (nome === 'confirmar') return executar('confirmar');
    setAcao(nome);
    setFalha(null);
    if (nome === 'reagendar') tentar(async () => { setSlot(null); setHorarios(null); setHorarios((await api.get(`/web/v1/horarios?especialidade=${encodeURIComponent(a.titulo.replace('Consulta de ', ''))}`)).horarios); });
  }
  return (
    <>
      <p><a href="#/agendamentos">← Minhas consultas</a></p>
      <section className="cartao">
        <span className={`etiqueta s-${a.status.toLowerCase()}`}>{a.statusTexto}</span>
        <h1>{a.titulo}</h1>
        <dl>
          <dt>Quando</dt><dd>{a.quando}</dd>
          {a.onde && <><dt>Onde</dt><dd>{a.onde}</dd></>}
          {a.profissional && <><dt>Com</dt><dd>{a.profissional}</dd></>}
          {a.motivo && <><dt>Motivo</dt><dd>{a.motivo}</dd></>}
        </dl>
        <Urgencia urgencia={a.urgencia} />
        {a.triagem && <><p>{a.triagem.justificativa}</p><Fontes fontes={a.triagem.fontes} /></>}
        {['PENDENTE', 'AGENDADO', 'CONFIRMADO'].includes(a.status) && <><h2>Antes de ir</h2><ul>{a.orientacoes.map((o) => <li key={o}>{o}</li>)}</ul></>}
      </section>
      <p className="acoes">
        {Object.entries(BOTOES).filter(([k]) => a._links[k]).map(([k, texto]) => (
          <button key={k} className={`botao ${k === 'confirmar' ? '' : k === 'cancelar' ? 'perigo' : 'secundario'}`} onClick={() => abrir(k)} disabled={ocupado}>{texto}</button>
        ))}
        {a.status === 'PENDENTE' && a._links.andamento && <a className="botao secundario" href={`#/agendamentos/${id}/andamento`}>Acompanhar</a>}
      </p>
      {acao === 'cancelar' && a._links.cancelar && (
        <section className="cartao" role="alertdialog" aria-label="Cancelar consulta">
          <p><strong>Cancelar esta consulta?</strong> O horário volta a ficar livre para outra pessoa.</p>
          <p className="acoes"><button className="botao perigo" autoFocus onClick={() => executar('cancelar')} disabled={ocupado}>Sim, cancelar</button><button className="botao secundario" onClick={() => setAcao(null)}>Voltar</button></p>
        </section>
      )}
      {acao === 'reagendar' && a._links.reagendar && (
        <section className="cartao">
          <h2>Escolha o novo horário</h2>
          {horarios ? <Horarios lista={horarios} escolhido={slot} aoEscolher={setSlot} nome="novo" /> : <Carregando />}
          <p className="acoes"><button className="botao" onClick={() => executar('reagendar', { novoSlotId: slot })} disabled={!slot || ocupado}>Trocar</button><button className="botao secundario" onClick={() => setAcao(null)}>Voltar</button></p>
        </section>
      )}
      <Erro erro={falha} />
    </>
  );
}
