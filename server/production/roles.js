// Run only with migration credentials, after the complete migration set.
const identifier = (value) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid database role');
  return '"' + value + '"';
};
export async function grantProductionRoles(
  pool,
  {
    application = 'relay_app',
    identity = 'relay_identity',
    rate = 'relay_rate',
    dispatch = 'relay_dispatch',
  } = {},
) {
  const names = [application, identity, rate, dispatch].map(identifier);
  if (new Set(names).size !== 4) throw new Error('Distinct database roles required');
  for (const name of names) {
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA relay FROM ${name}`);
    await pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA relay FROM ${name}`);
    await pool.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA relay FROM ${name}`);
    await pool.query(`GRANT USAGE ON SCHEMA relay TO ${name}`);
  }
  const [app, id, limiter, dispatcher] = names;
  const tables = (
    await pool.query(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='relay' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relforcerowsecurity",
    )
  ).rows;
  for (const { relname } of tables) {
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON relay.${identifier(relname)} TO ${app}`);
  }
  await pool.query(`GRANT SELECT ON relay.schema_migrations TO ${app}`);
  await pool.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA relay TO ${app}`);
  await pool.query(
    `GRANT SELECT(id,email,name,disabled_at,mfa_enabled) ON relay.security_accounts TO ${app}`,
  );
  await pool.query(`REVOKE UPDATE,DELETE ON relay.security_audit FROM ${app}`);
  for (const table of [
    'security_accounts',
    'security_sessions',
    'security_challenges',
    'security_recovery_codes',
    'security_oidc_identities',
    'security_oidc_states',
  ])
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON relay.${table} TO ${id}`);
  await pool.query(`GRANT SELECT,INSERT ON relay.security_identity_audit TO ${id}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION relay.identity_workspaces(text) TO ${id}`);
  await pool.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON relay.security_rate_buckets TO ${limiter}`,
  );
  await pool.query(`GRANT EXECUTE ON FUNCTION relay.runtime_workspaces() TO ${dispatcher}`);
}
export async function assertRepositoryRole(pool, kind) {
  const {
    rows: [r],
  } = await pool.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='relay' AND c.relowner=r.oid) AS owns FROM pg_roles r WHERE rolname=current_user`);
  if (!r || r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.owns)
    throw new Error('Restricted repository role required');
  const forbidden =
    kind === 'identity'
      ? ['security_credentials', 'security_usage', 'runs']
      : ['security_accounts', 'security_sessions', 'security_credentials', 'runs'];
  for (const table of forbidden) {
    const {
      rows: [row],
    } = await pool.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS allowed", [
      'relay.' + table,
    ]);
    if (row.allowed) throw new Error('Repository role has unrelated authority');
  }
}
