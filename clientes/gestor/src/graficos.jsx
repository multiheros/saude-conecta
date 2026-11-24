import { useId, useState } from 'react';

const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
export const formatar = (n) => num.format(n);

function Tabela({ titulo, cabecalho, linhas }) {
  return (
    <details className="tabela"><summary>Ver em tabela</summary>
      <table><caption className="oculto">{titulo}</caption><thead><tr>{cabecalho.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
        <tbody>{linhas.map((l) => <tr key={l[0]}>{l.map((v, i) => (i ? <td key={i}>{v}</td> : <th key={i} scope="row">{v}</th>))}</tr>)}</tbody></table>
    </details>
  );
}

// Barras horizontais de uma serie so: o titulo diz o que e, sem legenda.
export function Barras({ titulo, dados, sufixo = '', maximo, vazio = 'Sem dados no período.', marca }) {
  const teto = maximo || Math.max(1, ...dados.map((d) => d.valor));
  return (
    <section className="cartao grafico">
      <h2>{titulo}</h2>
      {dados.length === 0 ? <p className="suave">{vazio}</p> : (
        <ul className="barras">
          {dados.map((d) => (
            <li key={d.nome} title={`${d.nome}: ${formatar(d.valor)}${sufixo}`}>
              <span className="nome">{marca && <i className={marca(d)} aria-hidden="true" />}{d.rotulo || d.nome}</span>
              <span className="trilho"><span className="barra" style={{ width: `${(100 * d.valor) / teto}%` }} /></span>
              <span className="valor">{formatar(d.valor)}{sufixo}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const L = 720, A = 200, ESQ = 36, BASE = 170, TOPO = 12;
const dia = (d) => d.slice(8) + '/' + d.slice(5, 7);
function escala(maximo) {
  const passo = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((p) => maximo / p <= 4) || 1000;
  return { passo, teto: Math.max(passo, Math.ceil(maximo / passo) * passo) };
}

// Colunas por dia, com leitura do valor ao passar o mouse ou focar.
export function Colunas({ titulo, dados }) {
  const [foco, setFoco] = useState(null);
  const desc = useId();
  if (!dados.length) return <section className="cartao grafico largo"><h2>{titulo}</h2><p className="suave">Sem horários no período.</p></section>;
  const { passo, teto } = escala(Math.max(...dados.map((d) => d.agendados)));
  const faixa = (L - ESQ) / dados.length, larg = Math.min(24, faixa - 2), y = (v) => BASE - ((BASE - TOPO) * v) / teto;
  const marcas = Array.from({ length: teto / passo + 1 }, (_, i) => i * passo), pula = Math.ceil(dados.length / 12);
  const d = foco !== null ? dados[foco] : null;
  return (
    <section className="cartao grafico largo">
      <h2>{titulo}</h2>
      <p id={desc} className="oculto">Use a tecla Tab para ler o valor de cada dia, ou veja a tabela.</p>
      <div className="area">
        <svg viewBox={`0 0 ${L} ${A}`} role="group" aria-label={titulo} aria-describedby={desc}>
          {marcas.map((m) => <g key={m}><line x1={ESQ} x2={L} y1={y(m)} y2={y(m)} className="grade" /><text x={ESQ - 8} y={y(m) + 4} textAnchor="end">{m}</text></g>)}
          {dados.map((p, i) => {
            const x = ESQ + faixa * i + (faixa - larg) / 2, alt = BASE - y(p.agendados), r = Math.min(4, alt, larg / 2);
            return (
              <g key={p.data} tabIndex="0" role="img" aria-label={`${dia(p.data)}: ${p.agendados} agendados, ${p.faltas} faltas`} className={foco === i ? 'coluna ativa' : 'coluna'}
                onPointerEnter={() => setFoco(i)} onPointerLeave={() => setFoco(null)} onFocus={() => setFoco(i)} onBlur={() => setFoco(null)}>
                <rect x={ESQ + faixa * i} y={TOPO} width={faixa} height={BASE - TOPO} className="alvo" />
                {alt > 0 && <path d={`M${x},${BASE} v${-(alt - r)} q0,${-r} ${r},${-r} h${larg - 2 * r} q${r},0 ${r},${r} v${alt - r} z`} />}
                {i % pula === 0 && <text x={x + larg / 2} y={BASE + 18} textAnchor="middle">{dia(p.data)}</text>}
              </g>
            );
          })}
        </svg>
        {d && <div className="dica" style={{ left: `${(100 * (ESQ + faixa * (foco + 0.5))) / L}%` }}><strong>{d.agendados}</strong> agendados<br /><strong>{d.faltas}</strong> faltas<br /><span className="suave">{dia(d.data)}</span></div>}
      </div>
      <Tabela titulo={titulo} cabecalho={['Dia', 'Agendados', 'Faltas']} linhas={dados.map((p) => [dia(p.data), p.agendados, p.faltas])} />
    </section>
  );
}
