import { useState } from 'react';
import { Erro } from '../../comum/ui.jsx';
import { api } from './sessao.js';

const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];

export default function Escala({ ubsId, profissionais, aoCriar }) {
  const [f, setF] = useState({ profissionalId: profissionais[0]?.id, diaSemana: 1, horaInicio: '13:00', horaFim: '17:00', duracaoSlotMin: 30, semanas: 4 });
  const [erro, setErro] = useState(null);
  const [feito, setFeito] = useState('');
  const [enviando, setEnviando] = useState(false);
  const campo = (k, numero) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: numero ? Number(e.target.value) : e.target.value }), required: true });
  async function enviar(e) {
    e.preventDefault();
    setErro(null);
    setFeito('');
    setEnviando(true);
    try {
      const r = await api.post('/admin/v1/escalas', { ...f, ubsId });
      setFeito(r.slotsGerados ? `Escala criada: ${r.slotsGerados} horários novos. O painel mostra em até 30 segundos.` : 'Nenhum horário novo: o profissional já tem agenda nesse período.');
      aoCriar();
    } catch (x) { setErro(x); } finally { setEnviando(false); }
  }
  return (
    <section className="cartao">
      <h2>Criar escala</h2>
      <form className="escala" onSubmit={enviar}>
        <label>Profissional<select {...campo('profissionalId')}>{profissionais.map((p) => <option key={p.id} value={p.id}>{p.nome} ({p.especialidade})</option>)}</select></label>
        <label>Dia da semana<select {...campo('diaSemana', true)}>{DIAS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></label>
        <label>Início<input type="time" {...campo('horaInicio')} /></label>
        <label>Fim<input type="time" {...campo('horaFim')} /></label>
        <label>Duração (min)<input type="number" min="5" max="240" {...campo('duracaoSlotMin', true)} /></label>
        <label>Semanas<input type="number" min="1" max="12" {...campo('semanas', true)} /></label>
        <button className="botao" disabled={enviando}>{enviando ? 'Criando…' : 'Criar escala'}</button>
      </form>
      <div role="status">{feito && <div className="aviso">{feito}</div>}</div>
      <Erro erro={erro} />
    </section>
  );
}
