ALTER TABLE relay.runs ADD COLUMN actor text;
ALTER TABLE relay.runs ADD COLUMN request_id text;
ALTER TABLE relay.runs ADD COLUMN event_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE relay.runs ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE relay.runs ADD COLUMN recovery_count integer NOT NULL DEFAULT 0;
ALTER TABLE relay.runs ADD COLUMN max_attempts integer NOT NULL DEFAULT 4;
ALTER TABLE relay.runs ADD COLUMN limits text NOT NULL DEFAULT '{}';
ALTER TABLE relay.runs ADD COLUMN child_key text;
CREATE UNIQUE INDEX runtime_child ON relay.runs(workspace_id, parent_id, child_key) WHERE child_key IS NOT NULL;
ALTER TABLE relay.events ADD COLUMN sequence bigint;
CREATE UNIQUE INDEX runtime_event_order ON relay.events(run_id,sequence);
CREATE INDEX runtime_claim ON relay.runs(workspace_id,status,available_at,lease_until);
ALTER TABLE relay.actions ADD COLUMN arguments text;
ALTER TABLE relay.actions ADD COLUMN call_key text;
ALTER TABLE relay.actions ADD COLUMN argument_hash text;
ALTER TABLE relay.actions ADD COLUMN idempotency_key text;
ALTER TABLE relay.actions ADD COLUMN lease_generation bigint;
ALTER TABLE relay.actions ADD COLUMN provider_request_id text;
ALTER TABLE relay.actions ADD COLUMN resolution text;
ALTER TABLE relay.actions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX runtime_action_call ON relay.actions(workspace_id,run_id,step_id,call_key);

CREATE TABLE relay.runtime_approvals (
 id text PRIMARY KEY, workspace_id text NOT NULL, run_id text NOT NULL REFERENCES relay.runs(id),
 step_id text NOT NULL REFERENCES relay.steps(id), action_id text NOT NULL REFERENCES relay.actions(id),
 argument_hash text NOT NULL, arguments text NOT NULL, checkpoint text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 reviewer text, decision_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(action_id)
);
CREATE TABLE relay.runtime_dead_letters (
 id text PRIMARY KEY, workspace_id text NOT NULL, run_id text NOT NULL REFERENCES relay.runs(id),
 code text NOT NULL, attempts integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 recovered_at timestamptz, resolution text
);
CREATE TABLE relay.runtime_capacity (
 workspace_id text PRIMARY KEY REFERENCES relay.workspaces(id), max_running integer NOT NULL DEFAULT 4 CHECK(max_running BETWEEN 1 AND 128),
 max_queued integer NOT NULL DEFAULT 1000 CHECK(max_queued BETWEEN 1 AND 100000), last_claimed_at timestamptz
);
CREATE TABLE relay.runtime_schedule_fires (
 workspace_id text NOT NULL, schedule_id text NOT NULL REFERENCES relay.schedules(id),
 due_at bigint NOT NULL, run_id text NOT NULL REFERENCES relay.runs(id), PRIMARY KEY(schedule_id,due_at)
);
CREATE INDEX runtime_approval_run ON relay.runtime_approvals(workspace_id,run_id,status);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['runtime_approvals','runtime_dead_letters','runtime_capacity','runtime_schedule_fires'] LOOP
  EXECUTE format('ALTER TABLE relay.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE relay.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant ON relay.%I USING (workspace_id=nullif(current_setting(''relay.workspace_id'',true),'''')) WITH CHECK (workspace_id=nullif(current_setting(''relay.workspace_id'',true),''''))',tab);
 END LOOP;
END $$;

-- Legacy/imported runs lack an execution actor and are deliberately never automatically executed.
UPDATE relay.actions SET status=CASE WHEN status='completed' THEN 'succeeded' WHEN status IN ('running','pending') AND side_effect=1 THEN 'uncertain' WHEN status='running' THEN 'failed' ELSE status END;
CREATE FUNCTION relay.runtime_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='runs' AND (NEW.graph IS DISTINCT FROM OLD.graph OR NEW.input IS DISTINCT FROM OLD.input OR NEW.actor IS DISTINCT FROM OLD.actor OR NEW.limits IS DISTINCT FROM OLD.limits) THEN
  RAISE EXCEPTION 'Run snapshot is immutable';
 ELSIF TG_TABLE_NAME='versions' AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'Published revision is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER run_snapshot BEFORE UPDATE ON relay.runs FOR EACH ROW EXECUTE FUNCTION relay.runtime_immutable();
CREATE TRIGGER published_revision BEFORE UPDATE ON relay.versions FOR EACH ROW EXECUTE FUNCTION relay.runtime_immutable();
