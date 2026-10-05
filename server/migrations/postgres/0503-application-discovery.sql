-- A bearer digest proves tenant discovery authority without cross-tenant reads.
CREATE FUNCTION relay.application_tenant(application_id text,digest text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,relay AS $$
  SELECT t.workspace_id FROM relay.security_tokens t JOIN relay.applications a
    ON a.id=t.application_id AND a.workspace_id=t.workspace_id
  WHERE t.application_id=$1 AND t.token_hash=$2 AND t.revoked_at IS NULL AND t.expires_at>now()
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION relay.application_tenant(text,text) FROM PUBLIC;
