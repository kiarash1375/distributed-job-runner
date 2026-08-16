CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  image            TEXT NOT NULL,
  command          TEXT[] NOT NULL,
  timeout_seconds  INTEGER NOT NULL DEFAULT 300,
  idempotency_key  TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'PENDING',
  exit_code        INTEGER,
  error_message    TEXT,
  container_id     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key_uniq
  ON jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_pending_by_agent
  ON jobs (agent_id, created_at) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS job_log_chunks (
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  stream     TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, seq)
);

CREATE TABLE IF NOT EXISTS job_events (
  id         BIGSERIAL PRIMARY KEY,
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);