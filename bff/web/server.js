const { criarApp, aoEncerrar } = require('../../libs/comum/http');
const { criarRotas } = require('./src/rotas');

// O gateway remove o prefixo /web/v1.
const PORT = process.env.PORT || 3001;
const app = criarApp({ nome: 'bff-web', prefixo: '/', rotas: criarRotas(), essencial: 'bff', pronto: async () => ({ bff: 'up' }) });
aoEncerrar(app.listen(PORT, () => console.log(JSON.stringify({ nivel: 'info', msg: `bff-web ouvindo na porta ${PORT}` }))));
