CREATE TABLE relay.connector_connections (
  workspace_id text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL,
  config jsonb NOT NULL,
  secret_ref jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disconnected')),
  generation bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE relay.connector_sync (
  workspace_id text NOT NULL,
  id text NOT NULL,
  connection_id text NOT NULL,
  cursor text,
  owner_id uuid,
  generation bigint NOT NULL DEFAULT 0,
  expires_at timestamptz,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,connection_id) REFERENCES relay.connector_connections(workspace_id,id)
);
CREATE TABLE relay.connector_sync_items (
  workspace_id text NOT NULL,
  sync_id text NOT NULL,
  external_id text NOT NULL,
  source_id text NOT NULL,
  revision text NOT NULL,
  removed boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,sync_id,external_id),
  FOREIGN KEY(workspace_id,sync_id) REFERENCES relay.connector_sync(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX connector_sync_expiry ON relay.connector_sync(expires_at);
ALTER TABLE relay.connector_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.connector_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE relay.connector_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.connector_sync FORCE ROW LEVEL SECURITY;
ALTER TABLE relay.connector_sync_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE relay.connector_sync_items FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_connections_workspace ON relay.connector_connections USING (workspace_id = current_setting('relay.workspace_id',true)) WITH CHECK (workspace_id = current_setting('relay.workspace_id',true));
CREATE POLICY connector_sync_workspace ON relay.connector_sync USING (workspace_id = current_setting('relay.workspace_id',true)) WITH CHECK (workspace_id = current_setting('relay.workspace_id',true));
CREATE POLICY connector_sync_items_workspace ON relay.connector_sync_items USING (workspace_id = current_setting('relay.workspace_id',true)) WITH CHECK (workspace_id = current_setting('relay.workspace_id',true));
