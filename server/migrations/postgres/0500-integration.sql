-- Integration ownership: identity/domain consistency and narrowly exposed discovery.
ALTER TABLE relay.security_workspaces ADD CONSTRAINT security_workspace_domain
  FOREIGN KEY(workspace_id) REFERENCES relay.workspaces(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE relay.security_tokens ADD CONSTRAINT security_application_domain
  FOREIGN KEY(workspace_id,application_id) REFERENCES relay.applications(workspace_id,id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION relay.identity_workspaces(account_id text)
RETURNS TABLE(id text,name text,settings text,created_at text,role text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,relay AS $$
  SELECT w.id,w.name,w.settings,w.created_at,m.role FROM relay.workspaces w
  JOIN relay.security_memberships m ON m.workspace_id=w.id
  JOIN relay.security_accounts a ON a.id=m.user_id
  JOIN relay.security_workspaces sw ON sw.workspace_id=w.id
  WHERE m.user_id=account_id AND a.disabled_at IS NULL AND sw.suspended_at IS NULL
  AND (NOT sw.mfa_required OR a.mfa_enabled)
$$;
REVOKE ALL ON FUNCTION relay.identity_workspaces(text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION relay.runtime_workspaces() RETURNS TABLE(workspace_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,relay AS $$
 SELECT w.id FROM relay.workspaces w LEFT JOIN relay.runtime_capacity c ON c.workspace_id=w.id
 WHERE EXISTS(SELECT 1 FROM relay.job_outbox o WHERE o.workspace_id=w.id AND (o.state='pending' OR o.state='publishing' AND o.lease_until<now()) AND o.available_at<=now())
 OR EXISTS(SELECT 1 FROM relay.runs r WHERE r.workspace_id=w.id AND r.actor IS NOT NULL AND r.status IN ('queued','running') AND r.available_at<=now() AND coalesce(r.lease_until,0)<(extract(epoch from clock_timestamp())*1000)::bigint)
 OR EXISTS(SELECT 1 FROM relay.schedules s WHERE s.workspace_id=w.id AND s.enabled=1 AND s.next_at<(extract(epoch from clock_timestamp())*1000)::bigint)
 OR EXISTS(SELECT 1 FROM relay.knowledge_jobs j WHERE j.workspace_id=w.id AND (j.state='queued' OR j.state='running' AND j.expires_at<(extract(epoch from clock_timestamp())*1000)::bigint))
 ORDER BY c.last_claimed_at NULLS FIRST,w.id LIMIT 1000
$$;
