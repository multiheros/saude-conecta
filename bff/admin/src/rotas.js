// BFF do gestor: numeros agregados de uma unidade, sem dado pessoal.
const express = require('express');
const { UUID, rota } = require('../../../libs/comum/http');
const { Problema } = require('../../../libs/comum/erros');
const { exigir, pedir, opcional } = require('../../../libs/comum/bff');

const META_REDUCAO = 30; // % de reducao do absenteismo prevista no projeto
const mesAnterior = (p) => { const [a, m] = p.split('-').map(Number); return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`; };
const tendencia = (agora, antes) => (!antes || antes.faltas + antes.realizados === 0 ? null : agora > antes.taxa ? 'ALTA' : agora < antes.taxa ? 'QUEDA' : 'ESTAVEL');
const resumoFaltas = (o) => o && { taxa: o.taxaAbsenteismo, faltas: o.porStatus.FALTOU || 0, realizados: o.porStatus.REALIZADO || 0 };

function criarRotas(env = process.env) {
  const PAC = `${env.PACIENTES_URL}/api/v1`, AGE = `${env.AGENDAMENTO_URL}/api/v1`, NOT = `${env.NOTIFICACOES_URL}/api/v1`, TRI = `${env.TRIAGEM_URL}/api/v1`;
  const CACHE_MS = Number(env.CACHE_SEGUNDOS || 30) * 1000;
  const cache = new Map();
  const r = express.Router();
  r.use(exigir('gestor'));

  r.get('/unidades', rota(async (req, res) => {
    const [ubs, profissionais] = await Promise.all([pedir(req, 'GET', `${AGE}/ubs`), pedir(req, 'GET', `${AGE}/profissionais`)]);
    res.json({ ubs, profissionais });
  }));

  // So a ocupacao e indispensavel; o resto, se faltar, vem nulo e a resposta sai marcada como parcial.
  async function resumo(req, ubsId, periodo) {
    const ocupacao = (p, esp) => pedir(req, 'GET', `${AGE}/relatorios/ocupacao?${new URLSearchParams({ ubsId, periodo: p, ...(esp && { especialidade: esp }) })}`);
    const [o, antes, ubs, profs, pacientes, alertas] = await Promise.all([
      ocupacao(periodo), opcional(ocupacao(mesAnterior(periodo))), opcional(pedir(req, 'GET', `${AGE}/ubs`)), opcional(pedir(req, 'GET', `${AGE}/profissionais`)),
      opcional(pedir(req, 'GET', `${PAC}/pacientes/estatisticas?ubsId=${ubsId}`)), opcional(pedir(req, 'GET', `${NOT}/notificacoes/alertas`)),
    ]);
    const especialidades = profs && [...new Set(profs.map((p) => p.especialidade))].sort();
    const porEsp = especialidades && await Promise.all(especialidades.map((e) => opcional(ocupacao(periodo, e))));
    const u = ubs && ubs.find((x) => x.id === ubsId);
    return {
      ubs: u ? { id: u.id, nome: u.nome, regiao: u.regiao } : { id: ubsId }, periodo,
      capacidade: { slotsTotais: o.slotsTotais, reservados: o.reservados, ocupacaoPercentual: o.ocupacaoPercentual },
      porStatus: o.porStatus, porUrgencia: o.porUrgencia,
      absenteismo: { taxa: o.taxaAbsenteismo, metaReducao: META_REDUCAO, tendencia: tendencia(o.taxaAbsenteismo, resumoFaltas(antes)) },
      demandaPorEspecialidade: porEsp && especialidades.map((e, i) => porEsp[i] && ({
        especialidade: e, agendamentos: Object.values(porEsp[i].porStatus).reduce((x, n) => x + n, 0), ocupacao: porEsp[i].ocupacaoPercentual,
      })).filter((x) => x && (x.agendamentos || x.ocupacao)),
      serieDiaria: o.serieDiaria,
      pacientes: pacientes && { total: pacientes.totalPacientes, porFaixaEtaria: pacientes.porFaixaEtaria, porBairro: pacientes.porBairro },
      alertas: alertas && alertas.filter((a) => a.ubsId === ubsId).map(({ tipo, especialidade, dia, ocupacaoPercentual, mensagem }) => ({ tipo, especialidade, dia, ocupacaoPercentual, mensagem })),
      defasagemSegundos: o.defasagemSegundos, geradoEm: new Date().toISOString(),
      parcial: [antes, ubs, profs, pacientes, alertas, ...(porEsp || [])].includes(null),
    };
  }

  r.get('/agendamentos/resumo', rota(async (req, res) => {
    const { ubsId, periodo } = req.query;
    if (!UUID.test(ubsId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) throw new Problema(400, 'Parametros invalidos', 'ubsId e periodo (AAAA-MM) sao obrigatorios.');
    const chave = `${ubsId.toLowerCase()}|${periodo}`, guardado = cache.get(chave);
    if (guardado && Date.now() - guardado.em < CACHE_MS) return res.set('X-Cache', 'HIT').json(guardado.valor);
    const valor = await resumo(req, ubsId.toLowerCase(), periodo);
    if (!valor.parcial) { // resposta incompleta nao fica guardada
      if (cache.size >= 200) cache.clear();
      cache.set(chave, { em: Date.now(), valor });
    }
    res.set('X-Cache', 'MISS').json(valor);
  }));

  r.get('/saude-ia', rota(async (req, res) => res.json(await pedir(req, 'GET', `${TRI}/triagens/saude-llm`))));

  r.post('/escalas', rota(async (req, res) => {
    const e = await pedir(req, 'POST', `${AGE}/escalas`, { corpo: req.body || {}, timeoutMs: 5000 });
    cache.clear();
    res.status(201).json(e);
  }));
  return r;
}

module.exports = { criarRotas };
