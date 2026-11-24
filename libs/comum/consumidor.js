// Consumidor RabbitMQ com reconexao, retry e DLQ.
// Processa uma mensagem por vez (prefetch 1), preservando a ordem da fila nesta instancia.
const amqp = require('amqplib');

const TENTATIVAS = 3;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Falha de infraestrutura (banco fora): insiste sem limite, em vez de mandar para a DLQ.
const TRANSITORIOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '08006', '08001', '53300', '40001', '40P01']);
const transitorio = (e) => TRANSITORIOS.has(e.code) || /Connection terminated|timeout exceeded when trying to connect|Connection is closed|max retries per request/i.test(e.message);

function criarConsumidor({ fila, tratar, env = process.env, pausaMs = 500 }) {
  const url = {
    protocol: 'amqp', hostname: env.RABBITMQ_HOST, port: Number(env.RABBITMQ_PORT || 5672),
    username: env.RABBITMQ_USER, password: env.RABBITMQ_PASSWORD, heartbeat: 10,
  };
  let conexao = null, fechado = false, timer = null, emCurso = Promise.resolve();

  async function processar(canal, m) {
    let evento;
    try { evento = JSON.parse(m.content.toString()); } catch { return canal.nack(m, false, false); }
    for (let n = 1; !fechado;) {
      try {
        await tratar(evento);
        return canal.ack(m);
      } catch (e) {
        const t = transitorio(e);
        console.error(JSON.stringify({ nivel: 'erro', msg: 'consumo', fila, eventId: evento.eventId, eventType: evento.eventType, tentativa: n, transitorio: t, erro: e.message }));
        if (!t && n++ >= TENTATIVAS) return canal.nack(m, false, false); // vai para a DLQ
        await espera(t ? pausaMs * 2 : pausaMs * n);
      }
    }
    // Encerrando: sem ack, a mensagem volta para a fila.
  }

  async function conectar() {
    try {
      const cx = await amqp.connect(url, { timeout: 3000 });
      conexao = cx;
      cx.on('error', () => {});
      cx.on('close', () => { if (conexao === cx) { conexao = null; agendar(); } });
      const canal = await cx.createChannel();
      canal.on('error', () => {});
      canal.on('close', () => cx.close().catch(() => {}));
      await canal.prefetch(1);
      await canal.consume(fila, (m) => {
        if (m) emCurso = processar(canal, m).catch(() => {}); // ack em canal fechado: sera reentregue
        else cx.close().catch(() => {}); // fila removida: reconecta
      });
      if (fechado) await cx.close();
      else console.log(JSON.stringify({ nivel: 'info', msg: 'consumindo', fila }));
    } catch (e) {
      console.error(JSON.stringify({ nivel: 'erro', msg: 'consumidor sem RabbitMQ', fila, erro: e.message }));
      const cx = conexao;
      conexao = null;
      if (cx) cx.close().catch(() => {});
      agendar();
    }
  }
  function agendar() { if (!fechado) timer = setTimeout(conectar, 2000); }

  return {
    iniciar: conectar,
    conectado: () => conexao !== null,
    async fechar() {
      fechado = true;
      clearTimeout(timer);
      await emCurso;
      const cx = conexao;
      conexao = null;
      if (cx) await cx.close().catch(() => {});
    },
  };
}

module.exports = { criarConsumidor, transitorio };
