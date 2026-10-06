CREATE TABLE relay.model_connection_probes (
 workspace_id text NOT NULL REFERENCES relay.workspaces(id), id uuid NOT NULL,
 connection_id text NOT NULL, actor jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('started','settled','failed','uncertain','reconciled')),
 resolution_hash text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(workspace_id,id)
);
ALTER TABLE relay.model_connection_probes ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.model_connection_probes FORCE ROW LEVEL SECURITY;
CREATE POLICY model_connection_probes_workspace ON relay.model_connection_probes USING(workspace_id=current_setting('relay.workspace_id',true)) WITH CHECK(workspace_id=current_setting('relay.workspace_id',true));
