import { Entrar, useRota, useSessao } from '../../comum/ui.jsx';
import { sessao } from './sessao.js';
import Andamento from './telas/Andamento.jsx';
import Detalhe from './telas/Detalhe.jsx';
import Inicio from './telas/Inicio.jsx';
import Lista from './telas/Lista.jsx';
import Nova from './telas/Nova.jsx';

function Tela({ rota }) {
  const [, area, id, parte] = rota.split('/');
  if (area === 'nova') return <Nova />;
  if (area === 'agendamentos' && id && parte === 'andamento') return <Andamento key={id} id={id} />;
  if (area === 'agendamentos' && id) return <Detalhe key={id} id={id} />;
  if (area === 'agendamentos') return <Lista />;
  return <Inicio />;
}

export default function App() {
  const token = useSessao(sessao), rota = useRota();
  if (!token) return <Entrar sessao={sessao} perfil="paciente" titulo="Entre na sua conta" texto="Agende consultas na sua unidade de saúde." />;
  const item = (para, texto) => <a href={`#${para}`} aria-current={rota === para ? 'page' : undefined}>{texto}</a>;
  return (
    <>
      <header className="topo">
        <p className="marca"><span aria-hidden="true">✚</span> SaúdeConecta</p>
        <nav aria-label="Principal">{item('/', 'Início')}{item('/nova', 'Nova consulta')}{item('/agendamentos', 'Consultas')}</nav>
        <button className="sair" onClick={() => sessao.sair()}>Sair</button>
      </header>
      <main className="pagina"><Tela rota={rota} /></main>
    </>
  );
}
