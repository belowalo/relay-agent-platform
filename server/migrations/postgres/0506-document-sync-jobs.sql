CREATE TABLE relay.document_sync_jobs (
 workspace_id text NOT NULL, id uuid NOT NULL, sync_id text NOT NULL,
 collection_id text NOT NULL, context jsonb NOT NULL, specification jsonb NOT NULL,
 connection_generation bigint NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed')),
 claim uuid, deadline timestamptz, attempts integer NOT NULL DEFAULT 0,
 result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,sync_id) REFERENCES relay.connector_sync(workspace_id,id),
 FOREIGN KEY(workspace_id,collection_id) REFERENCES relay.collections(workspace_id,id)
);
CREATE UNIQUE INDEX document_sync_active ON relay.document_sync_jobs(workspace_id,sync_id) WHERE state IN ('queued','running');
ALTER TABLE relay.document_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.document_sync_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY document_sync_jobs_workspace ON relay.document_sync_jobs USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
