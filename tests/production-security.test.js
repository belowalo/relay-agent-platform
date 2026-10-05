import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { createAuthorization, requirePermission } from '../server/security/authorization.js';
import { createUsagePort } from '../server/security/usage.js';
import { createCapacityPort } from '../server/security/capacity.js';
import { createRuntimeSecurity } from '../server/security/runtime.js';
import { createTokenRepository } from '../server/security/tokens.js';
import { createMembershipRepository } from '../server/security/membership.js';
import { createIdentityRepository } from '../server/security/identity.js';
import { createSecretPort } from '../server/security/credentials.js';
import { createSecretVault } from '../server/foundation/secrets.js';
import { createRateLimiter } from '../server/security/rate-limits.js';
import { validateOidcConfiguration, browserBoundary } from '../server/security/http.js';
import { createOidcClient } from '../server/security/oidc.js';
import { migrateLegacyEnvelope } from '../server/security/legacy-secrets.js';
import { createOrganizationControls } from '../server/security/organization.js';
import { createOutboundPolicy } from '../server/network.js';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import http from 'node:http';
import { createWebhookVerifier } from '../server/security/webhooks.js';

const pg = new PGlite();
let tail = Promise.resolve();
async function exclusive() {
  let release;
  const next = new Promise((r) => (release = r)),
    previous = tail;
  tail = next;
  await previous;
  return release;
}
const context = (id = 'owner', workspaceId = 'workspaceA', kind = 'user') => ({
  workspaceId,
  actor: { kind, id },
  requestId: 'request-security',
});
// Embedded PostgreSQL is one connection; serialize transactions rather than claim pool/host qualification.
const database = {
  async transaction(ctx, fn) {
    const release = await exclusive();
    try {
      return await pg.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE security_app');
        await tx.query("SELECT set_config('relay.workspace_id',$1,true)", [ctx.workspaceId]);
        const session = {
          context: ctx,
          query: (sql, args = []) => tx.query(sql, args),
          one: async (sql, args = []) => (await tx.query(sql, args)).rows[0] || null,
          all: async (sql, args = []) => (await tx.query(sql, args)).rows,
        };
        return fn(session);
      });
    } finally {
      release();
    }
  },
};
function pool(role) {
  return {
    async connect() {
      const release = await exclusive();
      let released = false;
      return {
        async query(sql, args = []) {
          if (sql === 'BEGIN') {
            await pg.exec('BEGIN');
            await pg.exec('SET LOCAL ROLE ' + role);
            return { rows: [], rowCount: 0 };
          }
          const result = await pg.query(sql, args);
          return { ...result, rowCount: result.affectedRows ?? result.rows.length };
        },
        release() {
          if (!released) {
            released = true;
            release();
          }
        },
      };
    },
    async query(sql, args = []) {
      const c = await this.connect();
      try {
        await c.query('BEGIN');
        const r = await c.query(sql, args);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
const resources = new Map([
  ['application:appA', { workspaceId: 'workspaceA' }],
  ['workflow:flowA', { workspaceId: 'workspaceA' }],
  ['workflow:flowB', { workspaceId: 'workspaceB' }],
  ['connection:connectionA', { workspaceId: 'workspaceA' }],
  [
    'document:restricted',
    { workspaceId: 'workspaceA', access: { mode: 'restricted', principalIds: ['user:editor'] } },
  ],
]);
let tokenRepository;
const authorization = createAuthorization({
  database,
  applicationLookup: (ctx) => tokenRepository.lookup(ctx),
  resourceLookup: async (ctx, r) => resources.get(`${r.kind}:${r.id}`),
});
const authorize = authorization.authorize;
const usage = createUsagePort({ database, authorize }),
  capacity = createCapacityPort({ database, authorize });
const memberships = createMembershipRepository({ database, authorize });
const vault = createSecretVault({ old: crypto.randomBytes(32).toString('hex') }, 'old');
const identity = createIdentityRepository({ pool: pool('security_identity'), vault });
const secrets = createSecretPort({ database, authorize, vault });
before(async () => {
  await pg.exec('CREATE SCHEMA relay');
  await pg.exec(
    await fs.readFile(
      new URL('../server/migrations/postgres/0200-security.sql', import.meta.url),
      'utf8',
    ),
  );
  await pg.exec(`CREATE ROLE security_app;CREATE ROLE security_identity;CREATE ROLE security_rate;
    GRANT USAGE ON SCHEMA relay TO security_app,security_identity,security_rate;
    GRANT SELECT,INSERT,UPDATE,DELETE ON relay.security_workspaces,relay.security_memberships,relay.security_invitations,relay.security_tokens,relay.security_credentials,relay.security_webhook_replays,
      relay.security_budget_policies,relay.security_usage,relay.security_capacity TO security_app;
    GRANT INSERT,SELECT ON relay.security_audit TO security_app;
    GRANT SELECT(id,email,disabled_at,mfa_enabled) ON relay.security_accounts TO security_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON relay.security_accounts,relay.security_sessions,relay.security_challenges,
      relay.security_recovery_codes,relay.security_oidc_identities,relay.security_oidc_states TO security_identity;
    GRANT SELECT,INSERT ON relay.security_identity_audit TO security_identity;
    GRANT SELECT,INSERT,UPDATE,DELETE ON relay.security_rate_buckets TO security_rate;`);
  for (const id of ['owner', 'editor', 'viewer', 'other', 'invitee'])
    await identity.register(
      { id, email: id + '@relay.test', name: id, password: 'Fixture-password-2026' },
      'request-security',
    );
  await pg.exec(`INSERT INTO relay.security_workspaces(workspace_id) VALUES('workspaceA'),('workspaceB');
    INSERT INTO relay.security_memberships VALUES('workspaceA','owner','owner'),('workspaceA','editor','editor'),
    ('workspaceA','viewer','viewer'),('workspaceB','other','owner');`);
  tokenRepository = createTokenRepository({
    database,
    authorize,
    applicationLookup: async (ctx, id) => id === 'appA' && ctx.workspaceId === 'workspaceA',
  });
});
after(() => pg.close());
test('permission matrix, RLS and fresh workspace/document/subworkflow/connector authorization', async () => {
  assert.throws(() => requirePermission(undefined, 'run.execute'));
  assert.throws(() => requirePermission('owner', 'unknown'));
  await assert.rejects(() => authorize(context('viewer'), 'run.execute'), /Permission/);
  await assert.rejects(() => authorize(context('other'), 'workspace.read'), /Permission/);
  await assert.rejects(
    () => authorize(context('editor'), 'run.execute', { kind: 'workflow', id: 'flowB' }),
    /not found/,
  );
  await assert.rejects(
    () => authorize(context('viewer'), 'document.read', { kind: 'document', id: 'restricted' }),
    /restricted/,
  );
  await authorize(context('editor'), 'document.read', { kind: 'document', id: 'restricted' });
  const rows = await database.transaction(context(), (s) =>
    s.all('SELECT workspace_id FROM relay.security_memberships'),
  );
  assert.ok(rows.every((r) => r.workspace_id === 'workspaceA'));
  await assert.rejects(
    () =>
      database.transaction(context(), (s) =>
        s.query("INSERT INTO relay.security_memberships VALUES('workspaceB','invitee','viewer')"),
      ),
    /row-level security/,
  );
  await assert.rejects(
    () =>
      database.transaction(context(), (s) =>
        s.query('SELECT password_hash FROM relay.security_accounts'),
      ),
    /permission denied/,
  );
  await assert.rejects(
    () => database.transaction(context(), (s) => s.query('DELETE FROM relay.security_audit')),
    /permission denied/,
  );
  await database.transaction(context(), (s) =>
    s.query("UPDATE relay.security_memberships SET role='viewer' WHERE user_id='editor'"),
  );
  await assert.rejects(
    () =>
      authorize(context('editor'), 'connector.invoke', { kind: 'connection', id: 'connectionA' }),
    /Permission/,
  );
  await database.transaction(context(), (s) =>
    s.query("UPDATE relay.security_memberships SET role='editor' WHERE user_id='editor'"),
  );
});
test('scoped API token expiration, revocation, atomic rotation and current issuer membership', async () => {
  const input = {
    applicationId: 'appA',
    permissions: ['run.execute'],
    resources: ['workflow:flowA'],
    expiresAt: Date.now() + 60000,
  };
  const minted = await tokenRepository.mint(context(), input);
  const request = {
    workspaceId: 'workspaceA',
    applicationId: 'appA',
    token: minted.token,
    requestId: 'request-security',
  };
  const ctx = await tokenRepository.authenticate(request);
  await authorize(ctx, 'run.execute', { kind: 'workflow', id: 'flowA' });
  await assert.rejects(
    () => authorize(ctx, 'connector.invoke', { kind: 'connection', id: 'connectionA' }),
    /scope/,
  );
  await assert.rejects(
    () => authorize(ctx, 'run.execute', { kind: 'connection', id: 'connectionA' }),
    /scope/,
  );
  await assert.rejects(
    () => tokenRepository.authenticate({ ...request, workspaceId: 'workspaceB' }),
    /Invalid/,
  );
  const rotated = await tokenRepository.rotate(context(), minted.id, input);
  await assert.rejects(() => tokenRepository.authenticate(request), /no longer/);
  await assert.rejects(() => authorize(ctx, 'run.execute'), /scope/);
  const current = await tokenRepository.authenticate({ ...request, token: rotated.token });
  await tokenRepository.revoke(context(), rotated.id);
  await assert.rejects(() => authorize(current, 'run.execute'), /scope/);
  const expires = await tokenRepository.mint(context(), input);
  await pg.query(
    "UPDATE relay.security_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expires.id],
  );
  await assert.rejects(
    () => tokenRepository.authenticate({ ...request, token: expires.token }),
    /no longer/,
  );
  const removed = await tokenRepository.mint(context(), input);
  await pg.exec(
    "UPDATE relay.security_memberships SET role='viewer' WHERE workspace_id='workspaceA' AND user_id='owner'",
  );
  await assert.rejects(
    () => tokenRepository.authenticate({ ...request, token: removed.token }),
    /no longer/,
  );
  await pg.exec(
    "UPDATE relay.security_memberships SET role='owner' WHERE workspace_id='workspaceA' AND user_id='owner'",
  );
});
test('invitations are one-use, email-bound; owner protection and removed-user rejection', async () => {
  const invite = await memberships.invite(context(), {
    email: 'invitee@relay.test',
    role: 'editor',
  });
  await assert.rejects(() => memberships.accept(context('viewer'), invite.token), /no longer/);
  await memberships.accept(context('invitee'), invite.token);
  await assert.rejects(() => memberships.accept(context('invitee'), invite.token), /no longer/);
  await authorize(context('invitee'), 'run.execute');
  await memberships.change(context(), 'invitee', 'viewer');
  await assert.rejects(() => authorize(context('invitee'), 'run.execute'), /Permission/);
  await memberships.change(context(), 'invitee');
  await assert.rejects(() => authorize(context('invitee'), 'workspace.read'), /Permission/);
  await assert.rejects(() => memberships.change(context(), 'owner', 'viewer'), /not permitted/);
  const revoked = await memberships.invite(context(), {
    email: 'invitee@relay.test',
    role: 'viewer',
  });
  await memberships.revokeInvitation(context(), revoked.id);
  await assert.rejects(() => memberships.accept(context('invitee'), revoked.token), /no longer/);
  const disabledIssuer = await memberships.invite(context(), {
    email: 'invitee@relay.test',
    role: 'viewer',
  });
  await pg.exec("UPDATE relay.security_accounts SET disabled_at=now() WHERE id='owner'");
  await assert.rejects(
    () => memberships.accept(context('invitee'), disabledIssuer.token),
    /no longer/,
  );
  await pg.exec("UPDATE relay.security_accounts SET disabled_at=NULL WHERE id='owner'");
  await memberships.revokeInvitation(context(), disabledIssuer.id);
});
test('bounded reservations, idempotent settlements, unknown costs, ambiguous work and capacity fencing', async () => {
  await usage.configure(context(), {
    periodId: 'period1',
    tokenLimit: 100,
    costLimitMicros: 100,
    allowUnknownCost: false,
    maxConcurrent: 2,
    maxReservedTokens: 100,
  });
  const reserve = { runId: 'runA', maximumTokens: 60, maximumCostMicros: 60 };
  const concurrent = await Promise.allSettled([
    usage.reserve(context(), reserve),
    usage.reserve(context(), reserve),
  ]);
  assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
  const held = concurrent.find((r) => r.status === 'fulfilled').value;
  await assert.rejects(
    () => usage.reserve(context(), { ...reserve, maximumCostMicros: null }),
    /budget/,
  );
  const actual = { tokens: 20, costMicros: 20, provider: 'fixture', model: 'model' };
  await usage.settle(context(), held.id, actual);
  await usage.settle(context(), held.id, actual);
  await assert.rejects(
    () => usage.settle(context(), held.id, { ...actual, tokens: 21 }),
    /differs/,
  );
  await assert.rejects(() => usage.release(context(), held.id), /cannot be released/);
  const uncertain = await usage.reserve(context(), reserve);
  await usage.markUncertain(context(), uncertain.id);
  await assert.rejects(() => usage.release(context(), uncertain.id), /cannot be released/);
  await assert.rejects(
    () =>
      usage.configure(context(), {
        periodId: 'period2',
        tokenLimit: 100,
        costLimitMicros: null,
        allowUnknownCost: true,
        maxConcurrent: 2,
        maxReservedTokens: 100,
      }),
    /Reconcile/,
  );
  await usage.settle(context(), uncertain.id, { ...actual, tokens: 0, costMicros: null });
  await assert.rejects(
    () => usage.reserve(context(), { ...reserve, maximumCostMicros: 30 }),
    /budget/,
  );
  await usage.configure(context(), {
    periodId: 'period2',
    tokenLimit: 100,
    costLimitMicros: null,
    allowUnknownCost: true,
    maxConcurrent: 2,
    maxReservedTokens: 100,
  });
  const unknown = await usage.reserve(context(), { ...reserve, maximumCostMicros: null });
  await usage.settle(context(), unknown.id, { ...actual, costMicros: null });
  assert.ok((await usage.report(context())).some((r) => Number(r.unknown_cost_calls) > 0));
  const cap = (runId, ownerId = 'worker1', generation = 1) => ({
    runId,
    ownerId,
    generation,
    ttlMs: 30000,
  });
  await capacity.acquire(context(), cap('run1'));
  await capacity.acquire(context(), cap('run2'));
  await assert.rejects(() => capacity.acquire(context(), cap('run3')), /concurrency/);
  await assert.rejects(
    () => capacity.acquire(context(), cap('run1', 'worker2', 2)),
    /reconciliation/,
  );
  await capacity.release(context(), { runId: 'run1', ownerId: 'worker2', generation: 2 });
  await assert.rejects(() => capacity.acquire(context(), cap('run3')), /concurrency/);
  await capacity.release(context(), { runId: 'run1', ownerId: 'worker1', generation: 1 });
  await capacity.acquire(context(), cap('run3'));
});
test('runtime charges in-flight work after role change but blocks follow-up; ambiguous work remains held', async () => {
  const runtime = createRuntimeSecurity({ authorize, usage, capacity, secrets });
  let called = 0;
  await assert.rejects(
    () =>
      runtime.metered(
        context('editor'),
        {
          reservation: { runId: 'inflight', maximumTokens: 10, maximumCostMicros: 10 },
          provider: 'fixture',
          model: 'model',
        },
        async () => {
          called++;
          await pg.exec(
            "UPDATE relay.security_memberships SET role='viewer' WHERE workspace_id='workspaceA' AND user_id='editor'",
          );
          return { usage: { tokens: 5, costMicros: 5 } };
        },
      ),
    /Permission/,
  );
  assert.equal(called, 1);
  const recorded = (
    await pg.query("SELECT status,tokens FROM relay.security_usage WHERE run_id='inflight'")
  ).rows[0];
  assert.equal(recorded.status, 'settled');
  assert.equal(Number(recorded.tokens), 5);
  await assert.rejects(() => runtime.authorizeStep(context('editor')), /Permission/);
  await pg.exec(
    "UPDATE relay.security_memberships SET role='editor' WHERE workspace_id='workspaceA' AND user_id='editor'",
  );
  await assert.rejects(
    () =>
      runtime.metered(
        context('editor'),
        {
          reservation: { runId: 'lost', maximumTokens: 10, maximumCostMicros: 10 },
          provider: 'fixture',
          model: 'model',
        },
        async () => {
          throw new Error('Provider disconnected');
        },
      ),
    /disconnected/,
  );
  assert.equal(
    (await pg.query("SELECT status FROM relay.security_usage WHERE run_id='lost'")).rows[0].status,
    'uncertain',
  );
});
test('credential scope, ciphertext binding, revocation, rotation and backup-key recovery', async () => {
  const ref = { workspaceId: 'workspaceA', connectionId: 'connectionA', version: 1 };
  await secrets.store(context(), ref, 'synthetic-fixture-secret');
  await assert.rejects(() => secrets.resolve(context('viewer'), ref), /Permission/);
  await assert.rejects(() => secrets.resolve(context('other', 'workspaceB'), ref), /outside/);
  assert.equal(await secrets.resolve(context('editor'), ref), 'synthetic-fixture-secret');
  const old = (await pg.query('SELECT envelope FROM relay.security_credentials')).rows[0].envelope;
  assert.throws(
    () => vault.open(context(), { ...ref, connectionId: 'different' }, old),
    /decrypted/,
  );
  const newKey = crypto.randomBytes(32).toString('hex'),
    newVault = createSecretVault({ new: newKey }, 'new');
  await secrets.rewrap(context(), ref, newVault);
  const fresh = createSecretPort({ database, authorize, vault: newVault });
  assert.equal(await fresh.resolve(context(), ref), 'synthetic-fixture-secret');
  await assert.rejects(() => secrets.resolve(context(), ref), /decrypted/);
  assert.equal(vault.open(context(), ref, old), 'synthetic-fixture-secret');
  await fresh.revoke(context(), ref);
  await assert.rejects(() => fresh.resolve(context(), ref), /unavailable/);
  const oldKey = crypto.randomBytes(32),
    iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', oldKey, iv);
  const ciphertext = Buffer.concat([cipher.update('legacy-fixture'), cipher.final()]);
  const legacy = [iv, cipher.getAuthTag(), ciphertext].map((s) => s.toString('base64')).join('.');
  assert.equal(
    newVault.open(context(), ref, migrateLegacyEnvelope(ref, legacy, oldKey, newVault)),
    'legacy-fixture',
  );
  assert.throws(
    () => migrateLegacyEnvelope(ref, legacy, crypto.randomBytes(32), newVault),
    /migration failed/,
  );
});
test('sessions, failed MFA attempts, enrollment replay, one-use recovery, reset and disabled identities', async () => {
  const logged = await identity.login(
    'viewer@relay.test',
    'Fixture-password-2026',
    'request-security',
  );
  assert.equal((await identity.authenticate(logged.token)).id, 'viewer');
  const setup = await identity.setupMfa(logged.token, 'Fixture-password-2026', 'request-security');
  const otp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.secret) }),
    code = otp.generate();
  const confirmed = await identity.confirmMfa(logged.token, code, 'request-security');
  const mfa = await identity.login(
    'viewer@relay.test',
    'Fixture-password-2026',
    'request-security',
  );
  await assert.rejects(
    () => identity.verifyMfa(mfa.challenge, code, 'request-security'),
    /invalid/,
  );
  for (let i = 0; i < 4; i++)
    await assert.rejects(
      () => identity.verifyMfa(mfa.challenge, 'not-a-code', 'request-security'),
      /invalid/,
    );
  await assert.rejects(
    () => identity.verifyMfa(mfa.challenge, confirmed.recoveryCodes[0], 'request-security'),
    /invalid/,
  );
  const next = await identity.login(
    'viewer@relay.test',
    'Fixture-password-2026',
    'request-security',
  );
  await identity.verifyMfa(next.challenge, confirmed.recoveryCodes[0], 'request-security');
  const third = await identity.login(
    'viewer@relay.test',
    'Fixture-password-2026',
    'request-security',
  );
  await assert.rejects(
    () => identity.verifyMfa(third.challenge, confirmed.recoveryCodes[0], 'request-security'),
    /invalid/,
  );
  let reset;
  await identity.requestReset(
    'viewer@relay.test',
    async (value) => (reset = value.token),
    'request-security',
  );
  await identity.completeReset(reset, 'New-fixture-password-2026', 'request-security');
  await assert.rejects(
    () => identity.completeReset(reset, 'Other-fixture-password-2026', 'request-security'),
    /invalid/,
  );
  await assert.rejects(() => identity.authenticate(logged.token), /invalid/);
  assert.equal(
    (await identity.login('viewer@relay.test', 'New-fixture-password-2026', 'request-security'))
      .mfaRequired,
    true,
  );
  await pg.exec("UPDATE relay.security_accounts SET disabled_at=now() WHERE id='viewer'");
  await assert.rejects(() => authorize(context('viewer'), 'workspace.read'), /Permission/);
  await pg.exec("UPDATE relay.security_accounts SET disabled_at=NULL WHERE id='viewer'");
});
test('distributed rate buckets enforce across limiter instances and hide caller identifiers', async () => {
  const a = createRateLimiter({ pool: pool('security_rate') }),
    b = createRateLimiter({ pool: pool('security_rate') });
  for (let i = 0; i < 20; i++) await (i % 2 ? a : b).consume('login', 'synthetic-ip');
  await assert.rejects(() => b.consume('login', 'synthetic-ip'), /Rate limit/);
  const rows = (await pg.query('SELECT key_hash FROM relay.security_rate_buckets')).rows;
  assert.ok(rows.every((r) => /^[a-f0-9]{64}$/.test(r.key_hash)));
});
test('production OIDC config and browser/public API boundary fail closed', async () => {
  assert.throws(
    () =>
      validateOidcConfiguration({
        NODE_ENV: 'production',
        OIDC_ISSUER: 'http://issuer.test',
        OIDC_CLIENT_ID: 'fixture',
        PUBLIC_ORIGIN: 'https://relay.test',
        COOKIE_SECURE: 'true',
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateOidcConfiguration({
        NODE_ENV: 'production',
        OIDC_ISSUER: 'https://issuer.test',
        OIDC_CLIENT_ID: 'fixture',
        PUBLIC_ORIGIN: 'https://relay.test',
        COOKIE_SECURE: 'true',
      }),
    /domains/,
  );
  assert.throws(
    () => createOidcClient({ env: { OIDC_ISSUER: 'https://issuer.test' } }),
    /incomplete/,
  );
  const middleware = browserBoundary({ publicOrigin: 'https://relay.test' });
  let denied, passed;
  const response = {
    status(n) {
      denied = n;
      return this;
    },
    json() {
      return this;
    },
  };
  middleware(
    { method: 'POST', headers: { origin: 'null' }, cookies: {} },
    response,
    () => (passed = true),
  );
  assert.equal(denied, 403);
  assert.equal(passed, undefined);
  middleware(
    {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
      cookies: { relay_session: 'fixture' },
    },
    response,
    () => (passed = true),
  );
  assert.equal(denied, 403);
});
test('OIDC adapter verifies state, PKCE, nonce, issuer/audience, signed identities and explicit provisioning', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
  let issuer,
    nonce,
    challenge,
    wrongNonce = false,
    wrongAudience = false,
    unverified = false;
  const provider = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration')
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/jwks',
          code_challenge_methods_supported: ['S256'],
        }),
      );
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === '/token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      assert.equal(
        crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'),
        challenge,
      );
      const jwt = await new SignJWT({
        nonce: wrongNonce ? 'wrong' : nonce,
        email: 'owner@relay.test',
        email_verified: !unverified,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer(issuer)
        .setSubject('fixture-subject')
        .setAudience(wrongAudience ? 'wrong' : 'fixture-client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return res.end(JSON.stringify({ id_token: jwt }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${provider.address().port}`;
  const oidc = createOidcClient({
    env: {
      NODE_ENV: 'test',
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'fixture-client',
      PUBLIC_ORIGIN: 'http://127.0.0.1:59999',
      OIDC_EMAIL_DOMAINS: 'relay.test',
    },
    pool: pool('security_identity'),
    vault,
    outboundPolicy: createOutboundPolicy({ origins: [issuer], privateCidrs: ['127.0.0.1/32'] }),
  });
  const begin = async () => {
    const s = await oidc.begin(),
      url = new URL(s.url);
    nonce = url.searchParams.get('nonce');
    challenge = url.searchParams.get('code_challenge');
    return s;
  };
  try {
    const state = await begin();
    await assert.rejects(
      () => oidc.complete({ state: state.state, browserState: 'wrong', code: 'fixture' }),
      /browser/,
    );
    const claims = await oidc.complete({
      state: state.state,
      browserState: state.state,
      code: 'fixture',
    });
    await assert.rejects(
      () => oidc.complete({ state: state.state, browserState: state.state, code: 'fixture' }),
      /already used/,
    );
    await assert.rejects(() => identity.externalLogin(claims, 'request-security'), /provisioned/);
    await pg.query('INSERT INTO relay.security_oidc_identities VALUES($1,$2,$3)', [
      issuer,
      claims.subject,
      'owner',
    ]);
    const signedIn = await identity.externalLogin(claims, 'request-security');
    assert.equal((await identity.authenticate(signedIn.token)).id, 'owner');
    for (const invalid of ['nonce', 'audience', 'email']) {
      const s = await begin();
      wrongNonce = invalid === 'nonce';
      wrongAudience = invalid === 'audience';
      unverified = invalid === 'email';
      await assert.rejects(() =>
        oidc.complete({ state: s.state, browserState: s.state, code: 'fixture' }),
      );
      wrongNonce = false;
      wrongAudience = false;
      unverified = false;
    }
  } finally {
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
  }
});
test('signed webhooks bind raw bodies, expire, prevent replay and commit atomically with enqueue', async () => {
  const key = 'synthetic-fixture-webhook-secret-32chars';
  const ref = { workspaceId: 'workspaceA', connectionId: 'connectionA', version: 2 };
  await secrets.store(context(), ref, key);
  const verifier = createWebhookVerifier({ database, authorize, secrets }),
    rawBody = Buffer.from('{"input":"fixture"}');
  const make = (deliveryId, timestamp = String(Math.floor(Date.now() / 1000))) => ({
    applicationId: 'appA',
    reference: ref,
    timestamp,
    deliveryId,
    rawBody,
    signature: crypto
      .createHmac('sha256', key)
      .update(`${timestamp}.appA.${deliveryId}.`)
      .update(rawBody)
      .digest('hex'),
  });
  const input = make('fixture-delivery-0001');
  await assert.rejects(
    () =>
      verifier.verifyAndEnqueue(
        context(),
        { ...input, rawBody: Buffer.from('{}') },
        async () => {},
      ),
    /invalid/,
  );
  await assert.rejects(
    () =>
      verifier.verifyAndEnqueue(
        context(),
        make('fixture-delivery-expired', String(Math.floor(Date.now() / 1000) - 600)),
        async () => {},
      ),
    /expired/,
  );
  await assert.rejects(
    () =>
      verifier.verifyAndEnqueue(context(), input, async () => {
        throw new Error('Queue transaction failed');
      }),
    /transaction failed/,
  );
  const success = await verifier.verifyAndEnqueue(context(), input, async () => ({
    runId: 'run-webhook',
  }));
  assert.equal(success.runId, 'run-webhook');
  await assert.rejects(
    () => verifier.verifyAndEnqueue(context(), input, async () => {}),
    /already accepted/,
  );
});
test('organization domains, required MFA, suspended workspaces and account secrets remain restricted', async () => {
  const organization = createOrganizationControls({ database, authorize });
  await assert.rejects(
    () => organization.configure(context('editor'), { mfaRequired: false, emailDomains: [] }),
    /Permission/,
  );
  await assert.rejects(
    () => organization.configure(context(), { mfaRequired: true, emailDomains: ['relay.test'] }),
    /owner with MFA/,
  );
  await organization.configure(context(), { mfaRequired: false, emailDomains: ['relay.test'] });
  await assert.rejects(
    () => memberships.invite(context(), { email: 'outsider@other.test', role: 'viewer' }),
    /domain/,
  );
  await database.transaction(context(), (s) =>
    s.query('UPDATE relay.security_workspaces SET mfa_required=true WHERE workspace_id=$1', [
      'workspaceA',
    ]),
  );
  await assert.rejects(() => authorize(context('editor'), 'run.execute'), /Permission/);
  await pg.exec(
    "UPDATE relay.security_workspaces SET mfa_required=false,suspended_at=now() WHERE workspace_id='workspaceA'",
  );
  await assert.rejects(() => authorize(context(), 'workspace.read'), /unavailable/);
  await pg.exec(
    "UPDATE relay.security_workspaces SET suspended_at=NULL WHERE workspace_id='workspaceA'",
  );
  await assert.rejects(
    () =>
      database.transaction(context(), (s) =>
        s.query('SELECT mfa_secret FROM relay.security_accounts'),
      ),
    /permission denied/,
  );
});
