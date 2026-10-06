-- Infrastructure only: the runtime team owns the existing-domain PostgreSQL migration.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE relay.job_outbox (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('workflow.run','source.ingest','connector.sync','evaluation.run','maintenance.retention')),
  resource_id text NOT NULL,
  request_id text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version=1),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','publishing','published')),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX job_outbox_ready ON relay.job_outbox(state,available_at);
CREATE INDEX job_outbox_workspace ON relay.job_outbox(workspace_id,created_at);
ALTER TABLE relay.job_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.job_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY job_outbox_workspace ON relay.job_outbox
  USING (workspace_id = nullif(current_setting('relay.workspace_id',true),''))
  WITH CHECK (workspace_id = nullif(current_setting('relay.workspace_id',true),''));
