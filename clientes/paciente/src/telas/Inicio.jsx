import { Carregando, Erro, useCarga } from '../../../comum/ui.jsx';
import { api } from '../sessao.js';
import { Consulta } from './pecas.jsx';

export default function Inicio() {
  const { valor, erro, carregando, recarregar } = useCarga(() => api.get('/web/v1/home'), []);
  if (!valor) return erro ? <Erro erro={erro} tentar={recarregar} /> : <Carregando />;
  return (
    <>
      <h1>Olá, {valor.nome.split(' ')[0]}</h1>
      <p><a className="botao" href="#/nova">Marcar uma consulta</a></p>
      <h2>Próximas consultas</h2>
      {valor.parcial && <div className="aviso aviso-alerta" role="status">Não conseguimos buscar suas consultas agora. Elas continuam marcadas. <button className="botao secundario" onClick={recarregar} disabled={carregando}>Atualizar</button></div>}
      {valor.proximos && (valor.proximos.length ? valor.proximos.map((a) => <Consulta key={a.id} a={a} />) : <p className="suave">Você não tem consulta marcada.</p>)}
    </>
  );
}
