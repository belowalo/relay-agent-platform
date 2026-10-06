CREATE OR REPLACE FUNCTION relay.runtime_workspaces() RETURNS TABLE(workspace_id text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,relay AS $$
 SELECT w.id FROM relay.workspaces w LEFT JOIN relay.runtime_capacity c ON c.workspace_id=w.id
 WHERE EXISTS(SELECT 1 FROM relay.job_outbox o WHERE o.workspace_id=w.id AND (o.state='pending' OR o.state='publishing' AND o.lease_until<now()) AND o.available_at<=now())
 OR EXISTS(SELECT 1 FROM relay.runs r WHERE r.workspace_id=w.id AND r.actor IS NOT NULL AND r.status IN ('queued','running') AND r.available_at<=now() AND coalesce(r.lease_until,0)<(extract(epoch from clock_timestamp())*1000)::bigint)
 OR EXISTS(SELECT 1 FROM relay.schedules s WHERE s.workspace_id=w.id AND s.enabled=1 AND s.next_at<(extract(epoch from clock_timestamp())*1000)::bigint)
 OR EXISTS(SELECT 1 FROM relay.knowledge_jobs j WHERE j.workspace_id=w.id AND (j.state='queued' OR j.state='running' AND j.expires_at<(extract(epoch from clock_timestamp())*1000)::bigint))
 OR EXISTS(SELECT 1 FROM relay.evaluations e WHERE e.workspace_id=w.id AND e.status='running' AND e.config::jsonb ? 'context')
 ORDER BY c.last_claimed_at NULLS FIRST,w.id LIMIT 1000
$$;
