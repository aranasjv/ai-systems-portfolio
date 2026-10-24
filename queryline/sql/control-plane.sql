-- Control plane. Always Postgres: it holds query history, verified examples,
-- and (optionally) pgvector embeddings. The warehouse under analysis can be
-- Postgres, SQL Server, or Oracle.

CREATE TABLE IF NOT EXISTS queries (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  question    text NOT NULL,
  status      text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'refused', 'failed')),
  result      jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queries_tenant_created_idx
  ON queries (tenant_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS few_shot_examples (
  id          bigserial PRIMARY KEY,
  schema_name text NOT NULL,
  question    text NOT NULL,
  sql         text NOT NULL,
  verified    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS few_shot_schema_idx ON few_shot_examples (schema_name, verified);

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id          bigserial PRIMARY KEY,
  query_id    text NOT NULL,
  tenant_id   text NOT NULL,
  payload     jsonb NOT NULL,
  attempts    integer NOT NULL,
  error_class text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
