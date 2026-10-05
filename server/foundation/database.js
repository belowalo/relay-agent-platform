import pg from 'pg';
import { tenantContextSchema } from './contracts.js';
import { PlatformError } from './errors.js';

export function createPostgresDatabase(config, { pool } = {}) {
  const connection =
    pool ||
    new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      connectionTimeoutMillis: config.databaseTimeoutMs,
      idleTimeoutMillis: 30000,
      application_name: 'relay-' + config.role,
    });
  // An idle connection error must not become an uncaught EventEmitter exception.
  // Connection errors are surfaced through probe/queries without logging secret-bearing messages.
  connection.on('error', () => {});
  async function transaction(context, callback) {
    context = tenantContextSchema.parse(context);
    const client = await connection.connect();
    let failure;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('relay.workspace_id', $1, true), set_config('statement_timeout', $2, true), set_config('lock_timeout', $3, true)",
        [context.workspaceId, String(config.statementTimeoutMs), String(config.databaseTimeoutMs)],
      );
      const session = Object.freeze({
        context,
        query: (text, values = []) => client.query(text, values),
        one: async (text, values = []) => (await client.query(text, values)).rows[0] || null,
        all: async (text, values = []) => (await client.query(text, values)).rows,
      });
      const result = await callback(session);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        failure = error;
      }
      throw error;
    } finally {
      client.release(failure);
    }
  }
  return Object.freeze({
    transaction,
    async probe() {
      const result = await connection.query('SELECT 1 AS ready');
      return result.rows[0]?.ready === 1;
    },
    async assertApplicationRole() {
      const result = await connection.query(
        "SELECT r.rolsuper, r.rolbypassrls, EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='relay' AND c.relkind IN ('r','p') AND c.relowner=r.oid) AS owns_tables FROM pg_roles r WHERE r.rolname=current_user",
      );
      const role = result.rows[0];
      if (!role || role.rolsuper || role.rolbypassrls || role.owns_tables)
        throw new PlatformError(
          'FORBIDDEN',
          'The application database role must not own Relay tables or bypass row security.',
        );
    },
    close: () => connection.end(),
  });
}
