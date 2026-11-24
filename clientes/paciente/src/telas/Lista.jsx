import { Carregando, Erro, useCarga } from '../../../comum/ui.jsx';
import { api } from '../sessao.js';
import { Consulta } from './pecas.jsx';

export default function Lista() {
  const { valor, erro, recarregar } = useCarga(() => api.get('/web/v1/agendamentos'), []);
  if (!valor) return erro ? <Erro erro={erro} tentar={recarregar} /> : <Carregando />;
  return <><h1>Minhas consultas</h1>{valor.items.length ? valor.items.map((a) => <Consulta key={a.id} a={a} />) : <p className="suave">Nenhuma consulta até agora.</p>}</>;
}
