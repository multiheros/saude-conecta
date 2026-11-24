// Transactional Outbox: o evento e gravado na mesma transacao do dado de negocio
// e publicado depois por este poller. Entrega at-least-once.
const { transacao } = require('./db');

const MAX_TENTATIVAS = 10;

// Deve ser chamada com o cliente da transacao em curso.
async function gravarEvento(c, { tipo, rota, agregado, agregadoId, versao, payload, correlationId }) {
  await c.query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, aggregate_version, event_type, routing_key, payload, headers)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [agregado, agregadoId, versao, tipo, rota, payload, { correlationId: correlationId || null }],
  );
}

const envelope = (e) => ({
  eventId: e.id,
  eventType: e.event_type,
  version: e.event_version,
  occurredAt: e.created_at.toISOString(),
  correlationId: e.headers.correlationId || null,
  aggregateType: e.aggregate_type,
  aggregateId: e.aggregate_id,
  aggregateVersion: e.aggregate_version,
  payload: e.payload,
});

// Publica um lote. Devolve quantos eventos foram lidos.
// O NOT EXISTS garante a ordem por agregado mesmo com retry ou varias replicas:
// um evento so sai depois que o anterior do mesmo agregado saiu.
async function publicarLote(pool, publicador, limite = 100) {
  return transacao(pool, async (c) => {
    const { rows } = await c.query(
      `SELECT e.* FROM outbox_events e
        WHERE e.status = 'PENDING' AND e.next_attempt_at <= now()
          AND NOT EXISTS (SELECT 1 FROM outbox_events a
                           WHERE a.aggregate_id = e.aggregate_id AND a.status = 'PENDING' AND a.seq < e.seq)
        ORDER BY e.seq LIMIT $1 FOR UPDATE OF e SKIP LOCKED`,
      [limite],
    );
    const resultados = await Promise.allSettled(rows.map((e) => publicador.publicar(e.routing_key, envelope(e))));
    for (let i = 0; i < rows.length; i++) {
      const r = resultados[i];
      if (r.status === 'fulfilled') {
        await c.query("UPDATE outbox_events SET status='PUBLISHED', published_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1", [rows[i].id]);
      } else if (r.reason.indisponivel) {
        // Broker fora do ar nao conta como tentativa: o evento espera o tempo que for preciso.
        await c.query("UPDATE outbox_events SET last_error=$2, next_attempt_at=now()+interval '1 second' WHERE id=$1", [rows[i].id, r.reason.message]);
      } else {
        await c.query(
          `UPDATE outbox_events
              SET attempts = attempts + 1, last_error = $2,
                  status = CASE WHEN attempts + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END,
                  next_attempt_at = now() + LEAST(power(2, attempts), 300) * interval '1 second'
            WHERE id = $1`,
          [rows[i].id, r.reason.message, MAX_TENTATIVAS],
        );
        console.error(JSON.stringify({ nivel: 'erro', msg: 'outbox: publicacao recusada', eventId: rows[i].id, erro: r.reason.message }));
      }
    }
    return rows.length;
  });
}

// Laco do poller. Devolve uma funcao que para o laco e espera o lote em curso.
function iniciarPoller(pool, publicador, intervaloMs = 500) {
  let parado = false, acordar = () => {};
  const laco = (async () => {
    while (!parado) {
      let lidos = 0;
      if (publicador.conectado()) {
        try { lidos = await publicarLote(pool, publicador); } catch (e) {
          console.error(JSON.stringify({ nivel: 'erro', msg: 'outbox: lote', erro: e.message }));
        }
      }
      // Com eventos no lote, tenta de novo logo: pode haver o proximo do mesmo agregado.
      if (!parado) {
        await new Promise((ok) => { acordar = ok; setTimeout(ok, lidos > 0 ? 20 : intervaloMs); });
      }
    }
  })();
  return async () => { parado = true; acordar(); await laco; };
}

async function metricas(pool) {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE status='PENDING')::int AS pendentes,
            count(*) FILTER (WHERE status='FAILED')::int  AS falhos,
            COALESCE(extract(epoch FROM now() - min(created_at) FILTER (WHERE status='PENDING')), 0)::float AS "idadeMaisAntigoSegundos"
       FROM outbox_events WHERE status <> 'PUBLISHED'`,
  );
  return rows[0];
}

module.exports = { gravarEvento, publicarLote, iniciarPoller, metricas, MAX_TENTATIVAS };
