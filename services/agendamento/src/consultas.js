// Lado de leitura (CQRS): so MongoDB e Redis, nunca o PostgreSQL.
const { Problema } = require('../../../libs/comum/erros');
const { dia } = require('./projetor');

const ESPERA_MS = 2000;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const percentual = (parte, todo) => (todo ? Math.round((1000 * parte) / todo) / 10 : 0);

function criarConsultas({ leitura, esperaMs = ESPERA_MS }) {
  const { agendamentos, ocupacao, controle, cache } = leitura;
  const fora = () => new Problema(503, 'Consulta indisponível', 'O modelo de leitura está fora do ar. Agendamentos continuam sendo aceitos.');
  const protegida = (fn) => async (...args) => {
    if (!leitura.conectado()) throw fora();
    try { return await fn(...args); } catch (e) {
      if (!e.name || !e.name.startsWith('Mongo')) throw e;
      console.error(JSON.stringify({ nivel: 'erro', msg: 'consulta sem read model', erro: e.message }));
      throw fora();
    }
  };
  const visao = ({ _id, paciente, ...d }) => ({ agendamentoId: _id, pacienteId: paciente.id, pacienteNome: paciente.nome, ...d });

  return {
    // Com `versaoMinima`, espera a projecao alcancar a escrita que o cliente acabou de fazer (read-your-writes).
    obter: protegida(async (id, versaoMinima) => {
      const limite = Date.now() + esperaMs;
      for (;;) {
        const d = await agendamentos.findOne({ _id: id.toLowerCase() });
        if (versaoMinima === undefined || (d && d.versao >= versaoMinima) || Date.now() >= limite) return d && visao(d);
        await dormir(50);
      }
    }),

    listar: protegida(async ({ pacienteId, status, page, size }) => {
      const filtro = { ...(pacienteId && { 'paciente.id': pacienteId.toLowerCase() }), ...(status && { status }) };
      const [itens, total] = await Promise.all([
        agendamentos.find(filtro).sort({ criadoEm: -1, _id: 1 }).skip((page - 1) * size).limit(size).toArray(),
        agendamentos.countDocuments(filtro),
      ]);
      return { itens: itens.map(visao), total };
    }),

    slots: protegida(async ({ ubsId, especialidade, dataInicio, dataFim }) => {
      ubsId = ubsId.toLowerCase();
      let dias = await cache.ler(ubsId);
      if (!dias) {
        const docs = await ocupacao.find({ ubsId, dia: { $gte: dia(Date.now()) } }).toArray();
        await cache.carregar(ubsId, docs);
        dias = docs.map((d) => ({ dia: d.dia, livres: cache.livres(d) }));
      }
      const agora = new Date().toISOString();
      return dias
        .filter((d) => (!dataInicio || d.dia >= dataInicio) && (!dataFim || d.dia <= dataFim))
        .flatMap((d) => d.livres)
        .filter((s) => s.inicio > agora && (!especialidade || s.especialidade === especialidade))
        .sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : a.id < b.id ? -1 : 1))
        .slice(0, 200);
    }),

    ocupacao: protegida(async ({ ubsId, periodo, especialidade }) => {
      const faixa = { $gte: `${periodo}-01`, $lte: `${periodo}-31` };
      const [dias, grupos, projecao] = await Promise.all([
        ocupacao.aggregate([
          { $match: { ubsId: ubsId.toLowerCase(), dia: faixa, ...(especialidade && { especialidade }) } },
          { $group: { _id: '$dia', total: { $sum: '$total' }, reservados: { $sum: '$reservados' } } }, { $sort: { _id: 1 } },
        ]).toArray(),
        agendamentos.aggregate([
          { $match: { 'ubs.id': ubsId.toLowerCase(), dia: faixa, ...(especialidade && { 'profissional.especialidade': especialidade }) } },
          { $group: { _id: { status: '$status', urgencia: '$urgencia', dia: '$dia' }, n: { $sum: 1 } } },
        ]).toArray(),
        controle.findOne({ _id: 'projecao' }),
      ]);
      const porStatus = {}, porUrgencia = {}, faltas = {};
      const somar = (o, k, n) => { o[k] = (o[k] || 0) + n; };
      for (const { _id: g, n } of grupos) {
        somar(porStatus, g.status, n);
        if (g.urgencia && g.status !== 'CANCELADO') somar(porUrgencia, g.urgencia, n);
        if (g.status === 'FALTOU') somar(faltas, g.dia, n);
      }
      const slotsTotais = dias.reduce((t, d) => t + d.total, 0), reservados = dias.reduce((t, d) => t + d.reservados, 0);
      const faltou = porStatus.FALTOU || 0;
      return {
        ubsId, periodo, slotsTotais, reservados, ocupacaoPercentual: percentual(reservados, slotsTotais), porStatus, porUrgencia,
        taxaAbsenteismo: percentual(faltou, faltou + (porStatus.REALIZADO || 0)),
        serieDiaria: dias.map((d) => ({ data: d._id, agendados: d.reservados, faltas: faltas[d._id] || 0 })),
        defasagemSegundos: projecao ? Math.round(projecao.atrasoMs / 100) / 10 : null,
      };
    }),
  };
}

module.exports = { criarConsultas };
