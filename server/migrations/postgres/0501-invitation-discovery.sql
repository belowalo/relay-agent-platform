-- Only the identity repository can discover an invitation's tenant. The opaque
-- token must match the authenticated account's email; no caller tenant scan.
CREATE FUNCTION relay.identity_invitation(account_id text, digest text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,relay AS $$
  SELECT i.workspace_id FROM relay.security_invitations i
  JOIN relay.security_accounts a ON a.email=i.email
  JOIN relay.security_workspaces w ON w.workspace_id=i.workspace_id
  WHERE a.id=account_id AND a.disabled_at IS NULL AND i.token_hash=digest
    AND i.expires_at>now() AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    AND w.suspended_at IS NULL
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION relay.identity_invitation(text,text) FROM PUBLIC;
