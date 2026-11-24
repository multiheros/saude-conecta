import { useRef, useState } from 'react';
import { novoId } from '../../../comum/api.js';
import { Erro, ir } from '../../../comum/ui.jsx';
import { api } from '../sessao.js';
import { Fontes, Horarios, Urgencia } from './pecas.jsx';

export default function Nova() {
  const [sintomas, setSintomas] = useState('');
  const [triagem, setTriagem] = useState(null);
  const [horarios, setHorarios] = useState(null);
  const [slot, setSlot] = useState(null);
  const [ocupado, setOcupado] = useState('');
  const [erro, setErro] = useState(null);
  const chave = useRef(null); // a mesma em todo reenvio do mesmo pedido

  const fazer = (nome, f) => async (e) => {
    if (e) e.preventDefault();
    setErro(null);
    setOcupado(nome);
    try { await f(); } catch (x) { setErro(x); } finally { setOcupado(''); }
  };
  const avaliar = fazer('triagem', async () => {
    const t = await api.post('/web/v1/triagem', { sintomas });
    setTriagem(t);
    setHorarios(t.horarios);
    setSlot(null);
    chave.current = null;
  });
  const outros = fazer('horarios', async () => { setHorarios((await api.seguir(triagem._links.horarios)).horarios); setSlot(null); });
  const agendar = fazer('agendar', async () => {
    chave.current ||= { slot, id: novoId() };
    if (chave.current.slot !== slot) chave.current = { slot, id: novoId() };
    const a = await api.post('/web/v1/agendamentos', { slotId: slot, sintomas }, { 'Idempotency-Key': chave.current.id });
    ir(`/agendamentos/${a.id}/andamento`);
  });

  return (
    <>
      <h1>Nova consulta</h1>
      <form onSubmit={avaliar}>
        <label>O que você está sentindo?
          <textarea rows="4" value={sintomas} onChange={(e) => { setSintomas(e.target.value); setTriagem(null); }} minLength={10} maxLength={2000} required
            placeholder="Conte o que sente, há quanto tempo e se algo piora." aria-describedby="dica" />
        </label>
        <p id="dica" className="miudo">Não escreva nome, CPF ou telefone aqui. Se for uma emergência, ligue <a href="tel:192">192</a>.</p>
        {!triagem && <button className="botao" disabled={ocupado !== ''}>{ocupado === 'triagem' ? 'Avaliando…' : 'Continuar'}</button>}
      </form>
      <div aria-live="polite">
        {ocupado === 'triagem' && <p className="carregando">Avaliando a urgência e procurando horários…</p>}
        {triagem && (
          <section className={`cartao resultado ${triagem.emergencia ? 'emergencia' : ''}`}>
            <Urgencia urgencia={triagem.urgencia} />
            <p>{triagem.justificativa}</p>
            <p><strong>{triagem.orientacao}</strong></p>
            {triagem.emergencia && <p><a className="botao perigo" href="tel:192">Ligar para o 192</a></p>}
            <p className="miudo">Esta avaliação é uma sugestão para organizar o atendimento. Não é diagnóstico.{triagem.origem === 'REGRAS' ? ' Feita por regras: o assistente está indisponível.' : ''}</p>
            <Fontes fontes={triagem.fontes} />
          </section>
        )}
      </div>
      {triagem && !triagem.emergencia && horarios && (
        <section>
          <h2>Escolha o horário <span className="suave">({triagem.especialidade})</span></h2>
          <Horarios lista={horarios} escolhido={slot} aoEscolher={setSlot} />
          <p className="acoes">
            <button className="botao" onClick={agendar} disabled={!slot || ocupado !== ''}>{ocupado === 'agendar' ? 'Enviando…' : 'Agendar'}</button>
            <button className="botao secundario" onClick={outros} disabled={ocupado !== ''}>Ver mais horários</button>
          </p>
        </section>
      )}
      <Erro erro={erro} />
    </>
  );
}
