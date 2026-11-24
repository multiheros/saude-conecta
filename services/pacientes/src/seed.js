// Dados FICTICIOS de demonstracao. CPFs gerados, sem relacao com pessoas reais.
const { transacao } = require('../../../libs/comum/db');
const { cadastrar } = require('./pacientes');
const { gerarHash } = require('./senha');
const { completarCpf } = require('./cpf');

const CENTRO = 'a1000000-0000-4000-8000-000000000001', NORTE = 'a1000000-0000-4000-8000-000000000002';
const GESTOR = { id: 'd1000000-0000-4000-8000-000000000001', nome: 'Gestora Demo', cpf: completarCpf('900000001') };
const idPaciente = (n) => `c1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cpfPaciente = (n) => completarCpf(`1000000${String(n).padStart(2, '0')}`);
const NOMES = ['Maria Demo', 'Joao Demo', 'Rosa Demo', 'Pedro Demo', 'Lucia Demo', 'Carlos Demo', 'Tereza Demo', 'Antonio Demo', 'Clara Demo', 'Miguel Demo', 'Helena Demo', 'Davi Demo', 'Irene Demo', 'Jose Demo'];
const NASCIMENTOS = ['1980-03-10', '1975-07-22', '1990-11-05', '1988-01-30', '1969-09-14', '1995-05-18', '1950-02-02', '1945-12-25', '1955-06-06', '1948-08-08', '1953-04-17', '2018-10-01', '1992-03-03', '1984-04-04'];

async function semear(pool, senha) {
  const hash = await gerarHash(senha);
  return transacao(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(2)');
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM pacientes');
    if (n > 0) return false;
    await c.query('INSERT INTO gestores (id, nome, cpf, senha_hash) VALUES ($1,$2,$3,$4)', [GESTOR.id, GESTOR.nome, GESTOR.cpf, hash]);
    for (let i = 0; i < NOMES.length; i++) {
      await cadastrar(c, { correlationId: 'seed' }, {
        id: idPaciente(i + 1), nome: NOMES[i], cpf: cpfPaciente(i + 1), dataNascimento: NASCIMENTOS[i], email: `paciente${i + 1}@exemplo.com`,
        telefone: `+5535900000${String(i + 1).padStart(3, '0')}`, bairro: i < 7 ? 'Centro' : 'Vila Nova', ubsReferenciaId: i < 12 ? CENTRO : NORTE,
      }, hash);
    }
    return true;
  });
}

module.exports = { semear, GESTOR, idPaciente, cpfPaciente, CENTRO, NORTE };
