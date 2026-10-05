import crypto from 'node:crypto';
import * as OTPAuth from 'otpauth';
import nodemailer from 'nodemailer';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { z } from 'zod';
import { one, exec, id, now, hash, encrypt, decrypt, transaction } from './db.js';
import {
  authenticate,
  checkPassword,
  passwordHash,
  createSession,
  createWorkspace,
} from './auth.js';
import { safeFetch, responseText } from './network.js';
import { validateOidcConfiguration } from './security/http.js';
import { accountAudit } from './security/local.js';
const route = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
const token = () => crypto.randomBytes(32).toString('base64url');
const otpSchema = z
  .string()
  .trim()
  .regex(/^(\d{6}|[a-f0-9]{16})$/);
function totp(secret, label = 'Relay') {
  return new OTPAuth.TOTP({
    issuer: 'Relay',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
function verifyOTP(user, code) {
  if (/^[a-f0-9]{16}$/.test(code))
    return (
      exec('DELETE FROM mfa_recovery WHERE user_id=? AND code_hash=?', user.id, hash(code))
        .changes === 1
    );
  const delta = totp(decrypt(user.mfa_secret)).validate({ token: code, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 30000) + delta;
  return (
    exec(
      'UPDATE users SET mfa_last_step=? WHERE id=? AND (mfa_last_step IS NULL OR mfa_last_step<?)',
      step,
      user.id,
      step,
    ).changes === 1
  );
}
function challengeFor(user) {
  const challenge = token();
  exec('DELETE FROM auth_challenges WHERE expires_at<?', Date.now());
  exec(
    'INSERT INTO auth_challenges(id,user_id,kind,expires_at) VALUES(?,?,?,?)',
    hash(challenge),
    user.id,
    'mfa',
    Date.now() + 180000,
  );
  return challenge;
}
export function finishLogin(res, user) {
  if (user.mfa_secret) {
    const challenge = challengeFor(user);
    return res.json({ mfaRequired: true, challenge });
  }
  createSession(res, user.id);
  res.json({ id: user.id, name: user.name, email: user.email });
}
const ssoEnabled = () =>
  !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.PUBLIC_ORIGIN);
const resetEnabled = () =>
  !!(process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.PUBLIC_ORIGIN);
async function jsonAt(url, options) {
  const r = await safeFetch(url, {
    signal: AbortSignal.timeout(15000),
    noRedirect: true,
    ...options,
  });
  if (!r.ok) throw new Error('Identity provider request failed');
  return JSON.parse(await responseText(r, 200000));
}
async function discovery() {
  const issuer = process.env.OIDC_ISSUER.replace(/\/$/, '');
  if (new URL(issuer).protocol !== 'https:' && process.env.NODE_ENV === 'production')
    throw new Error('SSO requires an HTTPS issuer');
  const d = await jsonAt(issuer + '/.well-known/openid-configuration');
  if (d.issuer !== process.env.OIDC_ISSUER)
    throw new Error('Identity provider issuer does not match configuration');
  for (const uri of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) {
    const url = new URL(uri);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' && process.env.NODE_ENV === 'production')
    )
      throw new Error('Invalid identity provider endpoint');
  }
  return d;
}
export function registerSecurity(app, { seed }) {
  validateOidcConfiguration();
  app.get('/api/auth/options', (req, res) =>
    res.json({ sso: ssoEnabled(), passwordReset: resetEnabled() }),
  );
  app.get('/api/account/security', authenticate, (req, res) => {
    const user = one('SELECT mfa_secret FROM users WHERE id=?', req.user.id);
    res.json({
      mfaEnabled: !!user.mfa_secret,
      recoveryCodesRemaining: one(
        'SELECT count(*) AS n FROM mfa_recovery WHERE user_id=?',
        req.user.id,
      ).n,
      sso: ssoEnabled(),
      passwordReset: resetEnabled(),
    });
  });
  app.post(
    '/api/account/mfa/setup',
    authenticate,
    route((req, res) => {
      const user = one('SELECT * FROM users WHERE id=?', req.user.id);
      if (!checkPassword(z.string().max(200).parse(req.body.password), user.password))
        return res.status(401).json({ error: 'Password is incorrect' });
      if (user.mfa_secret) throw new Error('Two-factor authentication is already enabled');
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      exec('UPDATE users SET mfa_pending=? WHERE id=?', encrypt(secret), user.id);
      accountAudit(user.id, 'mfa.setup');
      res.json({ secret, uri: totp(secret, user.email).toString() });
    }),
  );
  app.post(
    '/api/account/mfa/confirm',
    authenticate,
    route((req, res) => {
      const user = one('SELECT * FROM users WHERE id=?', req.user.id),
        code = otpSchema.parse(req.body.code);
      if (
        !user.mfa_pending ||
        totp(decrypt(user.mfa_pending)).validate({ token: code, window: 1 }) === null
      )
        throw new Error('Authenticator code is incorrect');
      const codes = Array.from({ length: 8 }, () => crypto.randomBytes(8).toString('hex'));
      transaction(() => {
        exec(
          'UPDATE users SET mfa_secret=mfa_pending,mfa_pending=NULL,mfa_last_step=? WHERE id=?',
          Math.floor(Date.now() / 30000) +
            totp(decrypt(user.mfa_pending)).validate({ token: code, window: 1 }),
          user.id,
        );
        exec('DELETE FROM auth_challenges WHERE user_id=?', user.id);
        accountAudit(user.id, 'mfa.enabled');
        exec('DELETE FROM mfa_recovery WHERE user_id=?', user.id);
        for (const code of codes) exec('INSERT INTO mfa_recovery VALUES(?,?)', user.id, hash(code));
        exec(
          'DELETE FROM sessions WHERE user_id=? AND token!=?',
          user.id,
          hash(req.cookies.relay_session || ''),
        );
      });
      res.json({ enabled: true, recoveryCodes: codes });
    }),
  );
  app.post(
    '/api/auth/mfa',
    route((req, res) => {
      const challenge = z.string().max(100).parse(req.body.challenge),
        code = otpSchema.parse(req.body.code);
      const c = one(
        'SELECT * FROM auth_challenges WHERE id=? AND kind=? AND expires_at>? AND attempts<5',
        hash(challenge),
        'mfa',
        Date.now(),
      );
      if (!c) return res.status(401).json({ error: 'Sign in again; this verification expired' });
      exec('UPDATE auth_challenges SET attempts=attempts+1 WHERE id=?', c.id);
      const user = one('SELECT * FROM users WHERE id=?', c.user_id);
      if (!user.mfa_secret || !verifyOTP(user, code))
        return res
          .status(401)
          .json({ error: 'Authenticator or recovery code is incorrect or already used' });
      exec('DELETE FROM auth_challenges WHERE id=?', c.id);
      createSession(res, user.id);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/account/mfa/disable',
    authenticate,
    route((req, res) => {
      const user = one('SELECT * FROM users WHERE id=?', req.user.id);
      if (
        !user.mfa_secret ||
        !checkPassword(String(req.body.password || ''), user.password) ||
        !verifyOTP(user, otpSchema.parse(req.body.code))
      )
        return res.status(401).json({ error: 'Password or verification code is incorrect' });
      transaction(() => {
        exec(
          'UPDATE users SET mfa_secret=NULL,mfa_pending=NULL,mfa_last_step=NULL WHERE id=?',
          user.id,
        );
        exec('DELETE FROM mfa_recovery WHERE user_id=?', user.id);
        exec('DELETE FROM sessions WHERE user_id=?', user.id);
        exec('DELETE FROM auth_challenges WHERE user_id=?', user.id);
        accountAudit(user.id, 'mfa.disabled');
      });
      createSession(res, user.id);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/account/password',
    authenticate,
    route((req, res) => {
      const b = z
          .object({
            current: z.string().max(200),
            password: z.string().min(10).max(200),
            code: z.string().optional(),
          })
          .parse(req.body),
        user = one('SELECT * FROM users WHERE id=?', req.user.id);
      if (
        !checkPassword(b.current, user.password) ||
        (user.mfa_secret && !verifyOTP(user, otpSchema.parse(b.code)))
      )
        return res.status(401).json({ error: 'Password or verification code is incorrect' });
      transaction(() => {
        exec('UPDATE users SET password=? WHERE id=?', passwordHash(b.password), user.id);
        exec('DELETE FROM sessions WHERE user_id=?', user.id);
        exec('DELETE FROM auth_challenges WHERE user_id=?', user.id);
        accountAudit(user.id, 'password.changed');
      });
      createSession(res, user.id);
      res.json({ ok: true });
    }),
  );
  app.post(
    '/api/auth/reset/request',
    route(async (req, res) => {
      if (!resetEnabled())
        throw new Error('Email recovery is not configured. Ask your administrator.');
      const email = z.email().parse(req.body.email).toLowerCase(),
        user = one('SELECT id FROM users WHERE email=?', email);
      if (user) {
        const value = token();
        exec('DELETE FROM reset_tokens WHERE user_id=?', user.id);
        exec('INSERT INTO reset_tokens VALUES(?,?,?)', hash(value), user.id, Date.now() + 1800000);
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === 'true',
          ...(process.env.SMTP_USER
            ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
            : {}),
          connectionTimeout: 10000,
          socketTimeout: 15000,
        });
        try {
          await transport.sendMail({
            from: process.env.SMTP_FROM,
            to: email,
            subject: 'Reset your Relay password',
            text: `Reset your password within 30 minutes: ${process.env.PUBLIC_ORIGIN}/?reset=${value}\nIf you did not request this, ignore this message.`,
          });
        } catch {
          exec('DELETE FROM reset_tokens WHERE token_hash=?', hash(value));
        }
      }
      res.json({ ok: true, message: 'If the account exists, a recovery link will be sent.' });
    }),
  );
  app.post(
    '/api/auth/reset/complete',
    route((req, res) => {
      const b = z
          .object({ token: z.string().max(100), password: z.string().min(10).max(200) })
          .parse(req.body),
        r = one(
          'SELECT * FROM reset_tokens WHERE token_hash=? AND expires_at>?',
          hash(b.token),
          Date.now(),
        );
      if (!r) throw new Error('Recovery link is invalid or expired');
      transaction(() => {
        exec('DELETE FROM reset_tokens WHERE user_id=?', r.user_id);
        exec('UPDATE users SET password=? WHERE id=?', passwordHash(b.password), r.user_id);
        exec('DELETE FROM sessions WHERE user_id=?', r.user_id);
        exec('DELETE FROM auth_challenges WHERE user_id=?', r.user_id);
        accountAudit(r.user_id, 'password.reset.completed');
      });
      res.json({ ok: true });
    }),
  );
  app.get(
    '/api/auth/sso/start',
    route(async (req, res) => {
      if (!ssoEnabled()) throw new Error('Organization sign-in is not configured');
      const d = await discovery(),
        state = token(),
        verifier = token(),
        nonce = token();
      exec('DELETE FROM oidc_states WHERE expires_at<?', Date.now());
      exec(
        'INSERT INTO oidc_states VALUES(?,?,?,?)',
        hash(state),
        encrypt(verifier),
        nonce,
        Date.now() + 600000,
      );
      res.cookie('relay_oidc', state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === 'true',
        maxAge: 600000,
        path: '/api/auth/sso',
      });
      const url = new URL(d.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: process.env.OIDC_CLIENT_ID,
        response_type: 'code',
        scope: 'openid email profile',
        redirect_uri: process.env.PUBLIC_ORIGIN + '/api/auth/sso/callback',
        state,
        nonce,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      res.redirect(url.href);
    }),
  );
  app.get(
    '/api/auth/sso/callback',
    route(async (req, res) => {
      if (!ssoEnabled()) throw new Error('Organization sign-in is not configured');
      const state = String(req.query.state || ''),
        s = one('SELECT * FROM oidc_states WHERE id=? AND expires_at>?', hash(state), Date.now());
      if (!state || state !== req.cookies.relay_oidc || !s)
        throw new Error('Organization sign-in expired or did not originate in this browser');
      if (!exec('DELETE FROM oidc_states WHERE id=?', s.id).changes)
        throw new Error('Organization sign-in was already used');
      res.clearCookie('relay_oidc', { path: '/api/auth/sso' });
      const d = await discovery(),
        body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(req.query.code || ''),
          client_id: process.env.OIDC_CLIENT_ID,
          redirect_uri: process.env.PUBLIC_ORIGIN + '/api/auth/sso/callback',
          code_verifier: decrypt(s.verifier),
          ...(process.env.OIDC_CLIENT_SECRET
            ? { client_secret: process.env.OIDC_CLIENT_SECRET }
            : {}),
        });
      const tokens = await jsonAt(d.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const { payload } = await jwtVerify(
        tokens.id_token,
        createLocalJWKSet(await jsonAt(d.jwks_uri)),
        {
          issuer: process.env.OIDC_ISSUER,
          audience: process.env.OIDC_CLIENT_ID,
          algorithms: ['RS256', 'ES256', 'PS256'],
          requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email'],
          maxTokenAge: '10m',
        },
      );
      if (
        (payload.azp && payload.azp !== process.env.OIDC_CLIENT_ID) ||
        (Array.isArray(payload.aud) &&
          payload.aud.length > 1 &&
          payload.azp !== process.env.OIDC_CLIENT_ID) ||
        payload.nonce !== s.nonce ||
        payload.email_verified !== true ||
        typeof payload.sub !== 'string'
      )
        throw new Error('Identity provider did not verify your identity');
      const email = z.email().parse(payload.email).toLowerCase(),
        domains = (process.env.OIDC_EMAIL_DOMAINS || '')
          .split(',')
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean);
      if (domains.length && !domains.includes(email.split('@')[1]))
        throw new Error('Your email domain is not allowed');
      let user = one(
        'SELECT u.* FROM external_identities i JOIN users u ON u.id=i.user_id WHERE i.issuer=? AND i.subject=?',
        payload.iss,
        payload.sub,
      );
      if (!user) {
        if (one('SELECT id FROM users WHERE email=?', email))
          throw new Error(
            'This email already uses password sign-in. Sign in with your existing credentials.',
          );
        const uid = id();
        let wid;
        transaction(() => {
          exec(
            'INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)',
            uid,
            email,
            String(payload.name || email.split('@')[0]).slice(0, 80),
            passwordHash(token()),
            now(),
          );
          exec('INSERT INTO external_identities VALUES(?,?,?)', payload.iss, payload.sub, uid);
          wid = createWorkspace(uid, 'Organization workspace');
        });
        seed(wid);
        user = one('SELECT * FROM users WHERE id=?', uid);
      }
      if (user.mfa_secret)
        return res.redirect(process.env.PUBLIC_ORIGIN + '/?challenge=' + challengeFor(user));
      createSession(res, user.id);
      res.redirect(process.env.PUBLIC_ORIGIN + '/');
    }),
  );
}
