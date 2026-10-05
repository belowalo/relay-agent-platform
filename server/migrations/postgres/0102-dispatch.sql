-- Only the dedicated dispatcher role receives EXECUTE; no cross-tenant table grants.
-- The SECURITY DEFINER owner must be the migration role (not the application role).
CREATE FUNCTION relay.runtime_workspaces() RETURNS TABLE(workspace_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,relay AS $$
 SELECT w.id FROM relay.workspaces w LEFT JOIN relay.runtime_capacity c ON c.workspace_id=w.id
 WHERE EXISTS(SELECT 1 FROM relay.job_outbox o WHERE o.workspace_id=w.id AND (o.state='pending' OR o.state='publishing' AND o.lease_until<now()) AND o.available_at<=now())
 OR EXISTS(SELECT 1 FROM relay.runs r WHERE r.workspace_id=w.id AND r.actor IS NOT NULL AND r.status IN ('queued','running') AND r.available_at<=now() AND coalesce(r.lease_until,0)<(extract(epoch from clock_timestamp())*1000)::bigint)
 OR EXISTS(SELECT 1 FROM relay.schedules s WHERE s.workspace_id=w.id AND s.enabled=1 AND s.next_at<(extract(epoch from clock_timestamp())*1000)::bigint)
 ORDER BY c.last_claimed_at NULLS FIRST,w.id LIMIT 1000
$$;
REVOKE ALL ON FUNCTION relay.runtime_workspaces() FROM PUBLIC;
