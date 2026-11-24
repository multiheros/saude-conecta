import { useEffect, useState } from 'react';
import { Carregando, Entrar, Erro, useCarga, useSessao } from '../../comum/ui.jsx';
import Escala from './Escala.jsx';
import { Barras, Colunas, formatar } from './graficos.jsx';
import { api, sessao } from './sessao.js';

const ATUALIZAR_MS = 15000;
const NIVEIS = { VERMELHO: 'Vermelho', LARANJA: 'Laranja', AMARELO: 'Amarelo', VERDE: 'Verde', AZUL: 'Azul' };
const STATUS = { PENDENTE: 'Em andamento', AGENDADO: 'Agendado', CONFIRMADO: 'Confirmado', REALIZADO: 'Realizado', FALTOU: 'Faltou', CANCELADO: 'Cancelado' };
const CIRCUITO = { FECHADO: ['✓', 'Funcionando'], MEIO_ABERTO: ['◐', 'Testando a volta'], ABERTO: ['✕', 'Circuito aberto'] };
const TENDENCIA = { QUEDA: '▼ em queda', ALTA: '▲ em alta', ESTAVEL: '▬ estável' };

function meses() {
  const h = new Date();
  return Array.from({ length: 6 }, (_, i) => { const d = new Date(h.getFullYear(), h.getMonth() + 1 - i, 1); return { valor: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, nome: d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }) }; });
}
const Numero = ({ nome, valor, nota }) => <div className="cartao numero"><p className="suave">{nome}</p><p className="grande">{valor}</p>{nota && <p className="miudo">{nota}</p>}</div>;

function SaudeIA() {
  const { valor: s, erro, recarregar } = useCarga(() => api.get('/admin/v1/saude-ia'), []);
  useEffect(() => { const t = setInterval(recarregar, ATUALIZAR_MS); return () => clearInterval(t); }, [recarregar]);
  return (
    <section className="cartao">
      <h2>Saúde da triagem por IA</h2>
      {!s ? (erro ? <p className="suave">Indisponível agora.</p> : <Carregando />) : (
        <dl>
          <dt>Modelo</dt><dd>{s.habilitado ? s.modelo : 'Sem chave: triagem por regras'}</dd>
          <dt>Situação</dt><dd>{s.habilitado ? <><span aria-hidden="true">{CIRCUITO[s.circuito][0]}</span> {CIRCUITO[s.circuito][1]}</> : 'Não se aplica'}</dd>
          <dt>Chamadas</dt><dd>{s.chamadas} ({s.repeticoes} repetidas)</dd>
          <dt>Respostas do cache</dt><dd>{s.acertosCache}</dd>
          <dt>Respostas por regras</dt><dd>{s.fallbacks}</dd>
          <dt>Tempo do modelo</dt><dd>{s.latenciaMs ? `p50 ${s.latenciaMs.p50} ms, p95 ${s.latenciaMs.p95} ms` : 'sem medidas'}</dd>
          <dt>Réplica</dt><dd className="miudo">{s.instance}</dd>
        </dl>
      )}
    </section>
  );
}

function Painel() {
  const opcoes = meses();
  const [ubs, setUbs] = useState(null);
  const [periodo, setPeriodo] = useState(opcoes[1].valor);
  const u = useCarga(() => api.get('/admin/v1/unidades'), []);
  const ubsId = ubs || u.valor?.ubs[0]?.id;
  const r = useCarga(() => (ubsId ? api.get(`/admin/v1/agendamentos/resumo?ubsId=${ubsId}&periodo=${periodo}`) : Promise.resolve(null)), [ubsId, periodo]);
  const { recarregar } = r;
  useEffect(() => { const t = setInterval(recarregar, ATUALIZAR_MS); return () => clearInterval(t); }, [recarregar]);
  if (!u.valor) return u.erro ? <Erro erro={u.erro} tentar={u.recarregar} /> : <Carregando />;
  const s = r.valor && r.valor.ubs.id === ubsId && r.valor.periodo === periodo ? r.valor : null;
  const pares = (o, nomes) => Object.entries(nomes).filter(([k]) => o[k]).map(([k, nome]) => ({ chave: k, nome, valor: o[k] }));
  return (
    <>
      <div className="filtros">
        <label>Mês<select value={periodo} onChange={(e) => setPeriodo(e.target.value)}>{opcoes.map((m) => <option key={m.valor} value={m.valor}>{m.nome}</option>)}</select></label>
        <label>Unidade<select value={ubsId} onChange={(e) => setUbs(e.target.value)}>{u.valor.ubs.map((x) => <option key={x.id} value={x.id}>{x.nome}</option>)}</select></label>
        <p className="miudo" role="status">{s ? `Atualizado às ${new Date(s.geradoEm).toLocaleTimeString('pt-BR')} · defasagem da leitura: ${s.defasagemSegundos === null ? 'sem medida' : `${formatar(s.defasagemSegundos)} s`}` : ''}</p>
      </div>
      <Erro erro={r.erro} tentar={recarregar} />
      {!s ? (!r.erro && <Carregando />) : (
        <div className={r.carregando ? 'conteudo recarregando' : 'conteudo'}>
          {s.parcial && <div className="aviso aviso-alerta" role="status"><strong>Dados parciais.</strong> Algum serviço não respondeu; o que falta aparece como indisponível.</div>}
          <div className="numeros">
            <Numero nome="Ocupação" valor={`${formatar(s.capacidade.ocupacaoPercentual)}%`} nota={`${formatar(s.capacidade.reservados)} de ${formatar(s.capacidade.slotsTotais)} horários`} />
            <Numero nome="Agendamentos" valor={formatar(Object.values(s.porStatus).reduce((a, n) => a + n, 0))} nota={`${formatar(s.porStatus.CANCELADO || 0)} cancelados`} />
            <Numero nome="Absenteísmo" valor={`${formatar(s.absenteismo.taxa)}%`} nota={s.absenteismo.tendencia ? `${TENDENCIA[s.absenteismo.tendencia]} sobre o mês anterior` : 'sem mês anterior para comparar'} />
            <Numero nome="Pacientes da unidade" valor={s.pacientes ? (s.pacientes.total ? `≈ ${formatar(s.pacientes.total)}` : 'menos de 5') : 'indisponível'} nota="arredondado, sem dado individual" />
          </div>
          <section className="cartao">
            <h2>Alertas de lotação</h2>
            {!s.alertas ? <p className="suave">Indisponível agora.</p> : s.alertas.length ? <ul className="alertas">{s.alertas.slice(0, 5).map((a) => <li key={a.especialidade + a.dia}><span aria-hidden="true">⚠</span> {a.mensagem}</li>)}</ul> : <p className="suave">Nenhum dia acima de 85%.</p>}
          </section>
          <Colunas titulo="Agendamentos por dia" dados={s.serieDiaria} />
          <div className="duas">
            <Barras titulo="Por urgência" dados={pares(s.porUrgencia, NIVEIS)} marca={(d) => `cor u-${d.chave.toLowerCase()}`} />
            <Barras titulo="Por situação" dados={pares(s.porStatus, STATUS)} />
            {s.demandaPorEspecialidade && <Barras titulo="Ocupação por especialidade" sufixo="%" maximo={100} dados={s.demandaPorEspecialidade.map((d) => ({ nome: d.especialidade, valor: d.ocupacao }))} />}
            {s.pacientes && <Barras titulo="Pacientes por faixa etária" dados={Object.entries(s.pacientes.porFaixaEtaria).map(([nome, valor]) => ({ nome, rotulo: `${nome} anos`, valor }))} vazio="Grupos com menos de 5 pessoas não são mostrados." />}
          </div>
        </div>
      )}
      <div className="duas"><Escala key={ubsId} ubsId={ubsId} profissionais={u.valor.profissionais} aoCriar={() => setTimeout(recarregar, 2000)} /><SaudeIA /></div>
    </>
  );
}

export default function App() {
  const token = useSessao(sessao);
  if (!token) return <Entrar sessao={sessao} perfil="gestor" titulo="Painel do gestor" texto="Ocupação, faltas e urgências da sua unidade." />;
  return (
    <>
      <header className="topo"><p className="marca"><span aria-hidden="true">✚</span> SaúdeConecta · Painel</p><button className="botao secundario" onClick={() => sessao.sair()}>Sair</button></header>
      <main><h1>Panorama da unidade</h1><Painel /></main>
    </>
  );
}
