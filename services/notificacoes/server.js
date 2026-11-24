const { criarConsumidor } = require('../../libs/comum/consumidor');
const { criarApp, aoEncerrar } = require('../../libs/comum/http');
const { criarLoja } = require('./src/loja');
const { criarRotas } = require('./src/rotas');

const PORT = process.env.PORT || 8004;
const loja = criarLoja();

// Envio simulado: registra no log. Nao ha integracao com SMS ou e-mail.
async function enviar(n) {
  console.log(JSON.stringify({ nivel: 'info', servico: 'notificacoes', msg: 'envio simulado', id: n.id, tipo: n.tipo, canal: n.canal, agendamentoId: n.agendamentoId }));
}

let parado = false, acordar = () => {};
const envio = (async () => {
  while (!parado) {
    let n = 0;
    try { n = await loja.enviarVencidas(enviar); } catch (e) { console.error(JSON.stringify({ nivel: 'erro', msg: 'envio', erro: e.message })); }
    if (!parado && n === 0) await new Promise((ok) => { acordar = ok; setTimeout(ok, 1000); });
  }
})();

const consumidor = criarConsumidor({ fila: 'notificacoes.agendamento', tratar: (e) => loja.tratarEvento(e) });
consumidor.iniciar();

const app = criarApp({
  nome: 'notificacoes',
  rotas: criarRotas({ loja }),
  pronto: async () => ({
    db: await Promise.race([loja.ping().then(() => 'up', () => 'down'), new Promise((ok) => setTimeout(() => ok('down'), 1500).unref())]),
    rabbitmq: consumidor.conectado() ? 'up' : 'down',
  }),
});
const server = app.listen(PORT, () => console.log(JSON.stringify({ nivel: 'info', msg: `notificacoes ouvindo na porta ${PORT}` })));
aoEncerrar(server, consumidor.fechar, async () => { parado = true; acordar(); await envio; }, loja.fechar);
