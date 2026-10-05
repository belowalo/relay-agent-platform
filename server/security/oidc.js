import crypto from 'node:crypto';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { z } from 'zod';
import { safeFetch, responseText, checkURL } from '../network.js';
import { validateOidcConfiguration } from './http.js';
import { tokenHash } from './tokens.js';
import { PlatformError } from '../foundation/errors.js';
export function createOidcClient({ env, pool, vault, outboundPolicy }) {
  const config = validateOidcConfiguration(env);
  if (!config) throw new Error('OIDC is not configured');
  const production = env.NODE_ENV === 'production' || env.RELAY_PROFILE === 'production';
  const endpoints = new Set([
    new URL(config.issuer).origin,
    ...(env.OIDC_ENDPOINT_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ]);
  const domains = (env.OIDC_EMAIL_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const ref = (stateHash) => ({
    workspaceId: 'identity',
    connectionId: 'oidc-' + stateHash,
    version: 1,
  });
  const context = {
    workspaceId: 'identity',
    actor: { kind: 'service', id: 'oidc' },
    requestId: 'oidc',
  };
  async function json(url, options = {}) {
    const r = await safeFetch(
      url,
      { ...options, noRedirect: true, signal: AbortSignal.timeout(15000) },
      outboundPolicy,
    );
    if (!r.ok)
      throw new PlatformError('DEPENDENCY_UNAVAILABLE', 'Identity provider request failed.');
    return JSON.parse(await responseText(r, 200000));
  }
  async function discovery() {
    const d = await json(config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
    if (d.issuer !== config.issuer)
      throw new PlatformError('UNAUTHENTICATED', 'Identity provider issuer mismatch.');
    for (const endpoint of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) {
      const url = await checkURL(endpoint, outboundPolicy);
      if (!endpoints.has(url.origin) || (production && url.protocol !== 'https:'))
        throw new PlatformError(
          'UNAUTHENTICATED',
          'Identity endpoint is outside configured origins.',
        );
    }
    if (d.code_challenge_methods_supported && !d.code_challenge_methods_supported.includes('S256'))
      throw new PlatformError('UNAUTHENTICATED', 'Identity provider must support S256 PKCE.');
    return d;
  }
  return Object.freeze({
    async begin() {
      const d = await discovery(),
        state = crypto.randomBytes(32).toString('base64url'),
        verifier = crypto.randomBytes(32).toString('base64url'),
        nonce = crypto.randomBytes(32).toString('base64url');
      await pool.query('DELETE FROM relay.security_oidc_states WHERE expires_at<now()');
      await pool.query('INSERT INTO relay.security_oidc_states VALUES($1,$2,$3,$4)', [
        tokenHash(state),
        vault.seal(ref(tokenHash(state)), verifier),
        nonce,
        new Date(Date.now() + 600000).toISOString(),
      ]);
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: env.OIDC_CLIENT_ID,
        response_type: 'code',
        scope: 'openid email profile',
        redirect_uri: config.callback,
        state,
        nonce,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return { url: url.href, state };
    },
    async complete({ state, browserState, code }) {
      z.string()
        .regex(/^[\w-]{43}$/)
        .parse(state);
      z.string().min(1).max(4096).parse(code);
      if (state !== browserState)
        throw new PlatformError('UNAUTHENTICATED', 'Sign-in did not originate in this browser.');
      const row = (
        await pool.query(
          'DELETE FROM relay.security_oidc_states WHERE state_hash=$1 AND expires_at>now() RETURNING verifier_envelope,nonce',
          [tokenHash(state)],
        )
      ).rows[0];
      if (!row)
        throw new PlatformError('UNAUTHENTICATED', 'Sign-in state is invalid or already used.');
      const d = await discovery(),
        verifier = vault.open(context, ref(tokenHash(state)), row.verifier_envelope);
      const tokens = await json(d.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: env.OIDC_CLIENT_ID,
          redirect_uri: config.callback,
          code_verifier: verifier,
          ...(env.OIDC_CLIENT_SECRET ? { client_secret: env.OIDC_CLIENT_SECRET } : {}),
        }),
      });
      const idToken = z.string().min(1).max(32768).parse(tokens.id_token);
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(await json(d.jwks_uri)), {
        issuer: config.issuer,
        audience: env.OIDC_CLIENT_ID,
        algorithms: ['RS256', 'ES256', 'PS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email'],
        maxTokenAge: '10m',
      });
      const email = z.email().parse(payload.email).toLowerCase();
      if (
        payload.nonce !== row.nonce ||
        payload.email_verified !== true ||
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        payload.sub.length > 255 ||
        (payload.azp && payload.azp !== env.OIDC_CLIENT_ID) ||
        (Array.isArray(payload.aud) &&
          payload.aud.length > 1 &&
          payload.azp !== env.OIDC_CLIENT_ID) ||
        (domains.length && !domains.includes(email.split('@')[1]))
      )
        throw new PlatformError(
          'UNAUTHENTICATED',
          'Identity provider did not verify permitted identity.',
        );
      // Only pre-provisioned (issuer,subject) identities may sign in. Never link by email.
      return { issuer: config.issuer, subject: payload.sub, email };
    },
  });
}
