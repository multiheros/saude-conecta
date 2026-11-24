// Textos prontos para a tela do paciente.
const FUSO = 'America/Sao_Paulo';
const diaSemana = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, weekday: 'long' });
const diaMes = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' });
const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const quando = (iso) => { const d = new Date(iso); return `${diaSemana.format(d).replace('-feira', '')}, ${diaMes.format(d)} às ${hora.format(d)}`; };

const URGENCIA = {
  VERMELHO: 'Procure atendimento imediato', LARANJA: 'Muito urgente', AMARELO: 'Atendimento prioritário',
  VERDE: 'Pode aguardar a consulta', AZUL: 'Atendimento de rotina',
};
const STATUS = {
  PENDENTE: 'Estamos reservando o seu horário', AGENDADO: 'Agendado', CONFIRMADO: 'Presença confirmada',
  CANCELADO: 'Cancelado', REALIZADO: 'Atendimento realizado', FALTOU: 'Você não compareceu',
};
const PASSOS = { '1-triagem': 'Avaliação da urgência', '2-pacientes': 'Conferência do cadastro', '3-reserva': 'Reserva do horário', '4-notificacoes': 'Lembretes' };

const urgencia = (nivel) => (nivel ? { nivel, texto: URGENCIA[nivel] } : null);
const fonte = (f) => [f.documento, f.secao, f.pagina && `p. ${f.pagina}`].filter(Boolean).join(', ');

function idade(dataNascimento, hoje = new Date()) {
  const [a, m, d] = dataNascimento.split('-').map(Number);
  return hoje.getFullYear() - a - (hoje.getMonth() + 1 < m || (hoje.getMonth() + 1 === m && hoje.getDate() < d) ? 1 : 0);
}

// Um passo da SAGA em linguagem de tela.
function andamento(saga) {
  return Object.entries(PASSOS).map(([chave, nome]) => {
    const h = saga.historico.filter((x) => x.passo === chave);
    const acao = h.find((x) => x.tipo === 'ACAO'), desfeito = h.some((x) => x.tipo === 'COMPENSACAO' && x.resultado === 'OK');
    return { nome, situacao: desfeito ? 'DESFEITO' : !acao ? (saga.estado === 'EM_ANDAMENTO' ? 'AGUARDANDO' : 'NAO_EXECUTADO') : acao.resultado === 'OK' ? 'CONCLUIDO' : 'FALHOU' };
  });
}

module.exports = { quando, urgencia, fonte, idade, andamento, STATUS };
