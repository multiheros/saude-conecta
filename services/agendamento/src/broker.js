// Publicador RabbitMQ com publisher confirms e reconexao.
const amqp = require('amqplib');

const EXCHANGE = 'saudeconecta.events';

class Indisponivel extends Error { constructor(m) { super(m); this.indisponivel = true; } }

function criarPublicador(env = process.env) {
  const url = {
    protocol: 'amqp', hostname: env.RABBITMQ_HOST, port: Number(env.RABBITMQ_PORT || 5672),
    username: env.RABBITMQ_USER, password: env.RABBITMQ_PASSWORD, heartbeat: 10,
  };
  let canal = null, conexao = null, fechado = false, timer = null;
  const devolvidos = new Set();

  function agendar() { if (!fechado) timer = setTimeout(conectar, 2000); }

  async function conectar() {
    try {
      const cx = await amqp.connect(url, { timeout: 3000 });
      cx.on('error', () => {}); // 'close' vem em seguida e trata a reconexao
      cx.on('close', () => { if (conexao === cx) { canal = null; conexao = null; agendar(); } });
      conexao = cx;
      const ch = await cx.createConfirmChannel();
      ch.setMaxListeners(0); // um ouvinte de 'close' por publicacao em voo
      ch.on('error', () => {});
      ch.on('close', () => { if (canal === ch) { canal = null; cx.close().catch(() => {}); } });
      ch.on('return', (m) => devolvidos.add(m.properties.messageId));
      if (fechado) { await cx.close(); return; }
      canal = ch;
      console.log(JSON.stringify({ nivel: 'info', msg: 'rabbitmq conectado' }));
    } catch (e) {
      console.error(JSON.stringify({ nivel: 'erro', msg: 'rabbitmq indisponivel', erro: e.message }));
      const cx = conexao;
      conexao = null;
      if (cx) cx.close().catch(() => {});
      agendar();
    }
  }

  // Resolve so depois do confirm do broker. `mandatory`: evento sem fila e erro, nao sumico.
  function publicar(rota, evento, prazoMs = 5000) {
    const ch = canal;
    if (!ch) return Promise.reject(new Indisponivel('sem conexao com o RabbitMQ'));
    return new Promise((ok, erro) => {
      const prazo = setTimeout(() => fim(new Indisponivel('sem confirm do RabbitMQ no prazo')), prazoMs);
      const aoFechar = () => fim(new Indisponivel('canal fechado antes do confirm'));
      function fim(e) {
        clearTimeout(prazo);
        ch.removeListener('close', aoFechar);
        const voltou = devolvidos.delete(evento.eventId);
        if (e) return erro(e);
        return voltou ? erro(new Error(`evento sem fila de destino: ${rota}`)) : ok();
      }
      ch.once('close', aoFechar);
      try {
        ch.publish(EXCHANGE, rota, Buffer.from(JSON.stringify(evento)), {
          persistent: true, mandatory: true, contentType: 'application/json',
          messageId: evento.eventId, type: evento.eventType, correlationId: evento.correlationId || undefined,
        }, (e) => {
          if (!e) return fim();
          // canal caiu = indisponibilidade; nack do broker = recusa
          return fim(canal === ch ? e : new Indisponivel(e.message));
        });
      } catch (e) { fim(new Indisponivel(e.message)); }
    });
  }

  return {
    iniciar: conectar,
    conectado: () => canal !== null,
    publicar,
    async fechar() { fechado = true; clearTimeout(timer); canal = null; if (conexao) await conexao.close().catch(() => {}); },
  };
}

module.exports = { criarPublicador, EXCHANGE };
