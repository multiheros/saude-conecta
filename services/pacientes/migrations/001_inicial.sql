-- Unico servico que guarda dados pessoais. Os demais conhecem so o id do paciente.
CREATE TABLE pacientes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome                VARCHAR(120) NOT NULL,
    cpf                 CHAR(11)     NOT NULL UNIQUE,
    data_nascimento     DATE         NOT NULL,
    email               VARCHAR(160) NOT NULL,
    telefone            VARCHAR(20),
    bairro              VARCHAR(80),
    ubs_referencia_id   UUID,
    senha_hash          TEXT         NOT NULL,
    ativo               BOOLEAN      NOT NULL DEFAULT true,
    agendamento_saga_id UUID,        -- flag "agendamento em andamento": guarda a SAGA dona
    version             INTEGER      NOT NULL DEFAULT 1,
    criado_em           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_pacientes_ubs ON pacientes (ubs_referencia_id);

CREATE TABLE gestores (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome       VARCHAR(120) NOT NULL,
    cpf        CHAR(11)     NOT NULL UNIQUE,
    senha_hash TEXT         NOT NULL,
    ativo      BOOLEAN      NOT NULL DEFAULT true
);

-- SAGAs ja encerradas para este servico. Impede que um pedido atrasado (perdido num
-- timeout e entregue depois da compensacao) ligue a flag de novo, para sempre.
CREATE TABLE sagas_encerradas (
    saga_id UUID PRIMARY KEY,
    em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE atendimentos (
    agendamento_id UUID PRIMARY KEY,
    paciente_id    UUID NOT NULL REFERENCES pacientes(id),
    data           TIMESTAMPTZ NOT NULL,
    especialidade  VARCHAR(64) NOT NULL,
    ubs            VARCHAR(120) NOT NULL,
    status         VARCHAR(12) NOT NULL CHECK (status IN ('REALIZADO','FALTOU'))
);
CREATE INDEX idx_atendimentos_paciente ON atendimentos (paciente_id, data DESC);

CREATE TABLE processed_events (
    consumer     VARCHAR(64) NOT NULL,
    event_id     UUID        NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

CREATE TABLE outbox_events (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),  -- = eventId
    seq               BIGINT       GENERATED ALWAYS AS IDENTITY,           -- ordem de gravacao
    aggregate_type    VARCHAR(64)  NOT NULL,
    aggregate_id      UUID         NOT NULL,
    aggregate_version INTEGER      NOT NULL,
    event_type        VARCHAR(96)  NOT NULL,
    event_version     SMALLINT     NOT NULL DEFAULT 1,
    routing_key       VARCHAR(128) NOT NULL,
    payload           JSONB        NOT NULL,
    headers           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    status            VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','PUBLISHED','FAILED')),
    attempts          INTEGER      NOT NULL DEFAULT 0,
    last_error        TEXT,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    next_attempt_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    published_at      TIMESTAMPTZ
);
CREATE INDEX idx_outbox_pending   ON outbox_events (seq) WHERE status = 'PENDING';
CREATE INDEX idx_outbox_aggregate ON outbox_events (aggregate_id, seq) WHERE status = 'PENDING';
