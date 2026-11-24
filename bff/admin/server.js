const { criarApp, aoEncerrar } = require('../../libs/comum/http');
const { criarRotas } = require('./src/rotas');

// O gateway remove o prefixo /admin/v1.
const PORT = process.env.PORT || 3002;
const app = criarApp({ nome: 'bff-admin', prefixo: '/', rotas: criarRotas(), essencial: 'bff', pronto: async () => ({ bff: 'up' }) });
aoEncerrar(app.listen(PORT, () => console.log(JSON.stringify({ nivel: 'info', msg: `bff-admin ouvindo na porta ${PORT}` }))));
