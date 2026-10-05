-- Security-owned repositories. Runtime imports legacy identity data into these tables.
CREATE TABLE relay.security_workspaces (
  workspace_id text PRIMARY KEY, mfa_required boolean NOT NULL DEFAULT false,
  suspended_at timestamptz, email_domains jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE relay.security_accounts (
  id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
  password_hash text NOT NULL, mfa_secret text, mfa_pending text,
  mfa_enabled boolean GENERATED ALWAYS AS (mfa_secret IS NOT NULL) STORED,
  mfa_last_step bigint, disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay.security_sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES relay.security_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, authenticated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_session_user ON relay.security_sessions(user_id);
CREATE TABLE relay.security_challenges (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES relay.security_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('mfa','reset')), attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE TABLE relay.security_recovery_codes (
  user_id text REFERENCES relay.security_accounts(id) ON DELETE CASCADE,
  code_hash text NOT NULL, PRIMARY KEY(user_id,code_hash)
);
CREATE TABLE relay.security_oidc_identities (
  issuer text NOT NULL, subject text NOT NULL, user_id text NOT NULL REFERENCES relay.security_accounts(id),
  PRIMARY KEY(issuer,subject)
);
CREATE TABLE relay.security_oidc_states (
  state_hash text PRIMARY KEY, verifier_envelope text NOT NULL, nonce text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE relay.security_identity_audit (
  id uuid PRIMARY KEY, user_id text NOT NULL, action text NOT NULL, request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay.security_memberships (
  workspace_id text NOT NULL REFERENCES relay.security_workspaces(workspace_id), user_id text NOT NULL REFERENCES relay.security_accounts(id),
  role text NOT NULL CHECK(role IN ('owner','administrator','editor','viewer')),
  PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE relay.security_invitations (
  id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES relay.security_workspaces(workspace_id), email text NOT NULL,
  role text NOT NULL CHECK(role IN ('administrator','editor','viewer')),
  inviter_id text NOT NULL REFERENCES relay.security_accounts(id), token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz
);
CREATE TABLE relay.security_tokens (
  id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES relay.security_workspaces(workspace_id), issuer_id text NOT NULL REFERENCES relay.security_accounts(id),
  application_id text NOT NULL, token_hash text UNIQUE NOT NULL,
  permissions jsonb NOT NULL, resources jsonb NOT NULL, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_token_workspace ON relay.security_tokens(workspace_id,application_id);
CREATE TABLE relay.security_credentials (
  workspace_id text NOT NULL REFERENCES relay.security_workspaces(workspace_id), connection_id text NOT NULL, version integer NOT NULL CHECK(version>0),
  envelope text NOT NULL, key_id text NOT NULL, revoked_at timestamptz,
  PRIMARY KEY(workspace_id,connection_id,version)
);
CREATE TABLE relay.security_audit (
  id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES relay.security_workspaces(workspace_id), actor_kind text NOT NULL, actor_id text NOT NULL,
  action text NOT NULL, target text NOT NULL, request_id text NOT NULL, run_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_audit_workspace ON relay.security_audit(workspace_id,created_at);
CREATE TABLE relay.security_budget_policies (
  workspace_id text PRIMARY KEY REFERENCES relay.security_workspaces(workspace_id), period_id text NOT NULL,
  token_limit bigint NOT NULL CHECK(token_limit>=0), cost_limit_micros bigint CHECK(cost_limit_micros>=0),
  allow_unknown_cost boolean NOT NULL DEFAULT false,
  max_concurrent integer NOT NULL CHECK(max_concurrent BETWEEN 1 AND 128),
  max_reserved_tokens bigint NOT NULL CHECK(max_reserved_tokens>0)
);
CREATE TABLE relay.security_usage (
  id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES relay.security_budget_policies(workspace_id),
  period_id text NOT NULL, run_id text NOT NULL, actor_kind text NOT NULL, actor_id text NOT NULL,
  maximum_tokens bigint NOT NULL CHECK(maximum_tokens>=0), maximum_cost_micros bigint CHECK(maximum_cost_micros>=0),
  tokens bigint CHECK(tokens>=0), cost_micros bigint CHECK(cost_micros>=0),
  provider text, model text, status text NOT NULL CHECK(status IN ('reserved','settled','released','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz
);
CREATE INDEX security_usage_workspace ON relay.security_usage(workspace_id,period_id,status);
CREATE TABLE relay.security_capacity (
  workspace_id text NOT NULL REFERENCES relay.security_budget_policies(workspace_id),
  run_id text NOT NULL, owner_id text NOT NULL, generation bigint NOT NULL CHECK(generation>0),
  expires_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,run_id)
);
CREATE TABLE relay.security_rate_buckets (
  key_hash text PRIMARY KEY, count integer NOT NULL CHECK(count>0), expires_at timestamptz NOT NULL
);
CREATE TABLE relay.security_webhook_replays (
  workspace_id text NOT NULL REFERENCES relay.security_workspaces(workspace_id), application_id text NOT NULL,
  delivery_hash text NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,application_id,delivery_hash)
);
-- Global identities have no tenant RLS: grant only to the dedicated identity repository role.
-- Domain access is scoped even for table owners; superusers remain outside the support envelope.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['security_workspaces','security_memberships','security_invitations','security_tokens',
    'security_credentials','security_audit','security_budget_policies','security_usage','security_capacity','security_webhook_replays'] LOOP
    EXECUTE format('ALTER TABLE relay.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE relay.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON relay.%I USING (workspace_id=current_setting(''relay.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''relay.workspace_id'',true))', table_name);
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA relay FROM PUBLIC;
