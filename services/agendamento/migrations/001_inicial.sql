-- Write model do servico de Agendamento (fonte da verdade).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE ubs (
    id       UUID PRIMARY KEY,
    nome     VARCHAR(120) NOT NULL,
    endereco VARCHAR(200) NOT NULL,
    regiao   VARCHAR(80)  NOT NULL
);

CREATE TABLE profissionais (
    id            UUID PRIMARY KEY,
    nome          VARCHAR(120) NOT NULL,
    especialidade VARCHAR(64)  NOT NULL
);

CREATE TABLE slots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ubs_id          UUID NOT NULL REFERENCES ubs(id),
    profissional_id UUID NOT NULL REFERENCES profissionais(id),
    especialidade   VARCHAR(64) NOT NULL,
    inicio          TIMESTAMPTZ NOT NULL,
    fim             TIMESTAMPTZ NOT NULL,
    status          VARCHAR(12) NOT NULL DEFAULT 'LIVRE'
                    CHECK (status IN ('LIVRE','RESERVADO','BLOQUEADO')),
    version         INTEGER NOT NULL DEFAULT 0,
    CHECK (fim > inicio),
    -- O mesmo profissional nao atende em horarios sobrepostos.
    CONSTRAINT slots_sem_sobreposicao
        EXCLUDE USING gist (profissional_id WITH =, tstzrange(inicio, fim) WITH &&)
);
CREATE INDEX idx_slots_busca ON slots (ubs_id, especialidade, inicio) WHERE status = 'LIVRE';

CREATE TABLE agendamentos (
    id            UUID PRIMARY KEY,
    paciente_id   UUID NOT NULL,                  -- referencia logica: sem FK entre servicos
    slot_id       UUID NOT NULL REFERENCES slots(id),
    status        VARCHAR(12) NOT NULL
                  CHECK (status IN ('PENDENTE','AGENDADO','CONFIRMADO','CANCELADO','REALIZADO','FALTOU')),
    urgencia      VARCHAR(8)
                  CHECK (urgencia IN ('VERMELHO','LARANJA','AMARELO','VERDE','AZUL')),
    motivo        VARCHAR(200),
    saga_id       UUID UNIQUE,
    version       INTEGER NOT NULL DEFAULT 1,
    criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agendamentos_paciente ON agendamentos (paciente_id, criado_em DESC);

-- Invariante anti-overbooking garantida pelo banco.
CREATE UNIQUE INDEX uq_slot_agendamento_ativo
    ON agendamentos (slot_id)
    WHERE status IN ('PENDENTE','AGENDADO','CONFIRMADO');

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
