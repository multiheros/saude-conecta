// Dados ficticios de demonstracao. Os IDs sao fixos porque outros servicos os referenciam.
const { transacao } = require('./db');
const { criarEscala } = require('./agenda');

const UBS = [
  ['a1000000-0000-4000-8000-000000000001', 'UBS Centro', 'Rua das Flores, 120', 'Zona Central'],
  ['a1000000-0000-4000-8000-000000000002', 'UBS Jardim Norte', 'Av. dos Ipes, 45', 'Zona Norte'],
];
const PROFISSIONAIS = [
  ['b1000000-0000-4000-8000-000000000001', 'Dra. Ana Souza', 'Clínica Geral'],
  ['b1000000-0000-4000-8000-000000000002', 'Dr. Bruno Reis', 'Pediatria'],
  ['b1000000-0000-4000-8000-000000000003', 'Dra. Carla Dias', 'Ginecologia'],
  ['b1000000-0000-4000-8000-000000000004', 'Dr. Davi Nunes', 'Clínica Geral'],
];
const ESCALAS = [[0, 0], [1, 0], [2, 0], [3, 1]]; // [profissional, ubs]

async function semear(pool) {
  return transacao(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(8003)');
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM ubs');
    if (n > 0) return false;
    for (const u of UBS) await c.query('INSERT INTO ubs (id, nome, endereco, regiao) VALUES ($1,$2,$3,$4)', u);
    for (const p of PROFISSIONAIS) await c.query('INSERT INTO profissionais (id, nome, especialidade) VALUES ($1,$2,$3)', p);
    for (const [p, u] of ESCALAS) {
      for (let diaSemana = 1; diaSemana <= 5; diaSemana++) {
        await criarEscala(c, { correlationId: 'seed' }, { profissionalId: PROFISSIONAIS[p][0], ubsId: UBS[u][0], diaSemana, horaInicio: '08:00', horaFim: '12:00', duracaoSlotMin: 30, semanas: 4 });
      }
    }
    return true;
  });
}

module.exports = { semear, UBS, PROFISSIONAIS };
