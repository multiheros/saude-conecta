-- Estado do orquestrador: persistido para que qualquer replica retome a SAGA.
CREATE TABLE saga_instances (
    id                UUID PRIMARY KEY,
    agendamento_id    UUID NOT NULL UNIQUE,
    paciente_id       UUID NOT NULL,
    slot_id           UUID NOT NULL REFERENCES slots(id),
    sintomas          TEXT,          -- dado de saude: apagado assim que o passo 1 termina
    idade             SMALLINT,
    urgencia          VARCHAR(8),
    estado            VARCHAR(20) NOT NULL DEFAULT 'EM_ANDAMENTO'
                      CHECK (estado IN ('EM_ANDAMENTO','COMPENSANDO','COMPENSACAO_PENDENTE','CONCLUIDA','FALHOU')),
    passo_atual       SMALLINT NOT NULL DEFAULT 1,
    compensar         SMALLINT[] NOT NULL DEFAULT '{}',  -- passos a desfazer, na ordem
    motivo            VARCHAR(200),
    correlation_id    VARCHAR(64),
    chave_idempotencia VARCHAR(100),
    locked_by         UUID,          -- dono atual; toda gravacao confere (fencing)
    locked_until      TIMESTAMPTZ,
    tentativas        INTEGER NOT NULL DEFAULT 0,        -- rodadas de compensacao pendente
    proxima_execucao  TIMESTAMPTZ NOT NULL DEFAULT now(),
    criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (paciente_id, chave_idempotencia)
);
CREATE INDEX idx_saga_ativa ON saga_instances (proxima_execucao)
    WHERE estado IN ('EM_ANDAMENTO','COMPENSANDO','COMPENSACAO_PENDENTE');

CREATE TABLE saga_log (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    saga_id    UUID NOT NULL REFERENCES saga_instances(id),
    passo      VARCHAR(20) NOT NULL,
    tipo       VARCHAR(12) NOT NULL CHECK (tipo IN ('ACAO','COMPENSACAO')),
    resultado  VARCHAR(10) NOT NULL CHECK (resultado IN ('OK','FALHA','PENDENTE')),
    detalhe    VARCHAR(200),
    duracao_ms INTEGER,
    em         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_saga_log ON saga_log (saga_id, id);
