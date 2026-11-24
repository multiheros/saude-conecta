const ICONE = { VERMELHO: '●', LARANJA: '▲', AMARELO: '◆', VERDE: '■', AZUL: '○' };

export function Urgencia({ urgencia }) {
  if (!urgencia) return null;
  return <p className={`urgencia u-${urgencia.nivel.toLowerCase()}`}><span aria-hidden="true">{ICONE[urgencia.nivel]}</span> <strong>{urgencia.texto}</strong> <span className="miudo">({urgencia.nivel.toLowerCase()})</span></p>;
}

export function Consulta({ a }) {
  return (
    <a className="cartao consulta" href={`#/agendamentos/${a.id}`}>
      <span className={`etiqueta s-${a.status.toLowerCase()}`}>{a.statusTexto}</span>
      <strong>{a.titulo}</strong>
      <span>{a.quando}</span>
      <span className="suave">{[a.profissional, a.onde].filter(Boolean).join(' · ')}</span>
    </a>
  );
}

export function Horarios({ lista, escolhido, aoEscolher, nome = 'horario' }) {
  if (!lista.length) return <p className="suave">Nenhum horário livre encontrado.</p>;
  return (
    <fieldset className="horarios">
      <legend className="oculto">Horários livres</legend>
      {lista.map((h) => (
        <label key={h.slotId} className="horario">
          <input type="radio" name={nome} value={h.slotId} checked={escolhido === h.slotId} onChange={() => aoEscolher(h.slotId)} />
          <span><strong>{h.quando}</strong><br /><span className="suave">{[h.especialidade, h.profissional].filter(Boolean).join(' · ')}{h.dentroDoPrazo === false ? ' · depois do prazo indicado' : ''}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

export function Fontes({ fontes }) {
  if (!fontes || !fontes.length) return null;
  return <details className="fontes"><summary>Fontes consultadas ({fontes.length})</summary><ul>{fontes.map((f) => <li key={f}>{f}</li>)}</ul></details>;
}
