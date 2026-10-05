import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import { PlatformError } from '../foundation/errors.js';
import { resourceId } from '../foundation/contracts.js';
import { tokenHash } from './tokens.js';
const scrypt = promisify(crypto.scrypt),
  password = z.string().min(10).max(200);
const opaque = () => crypto.randomBytes(32).toString('base64url');
async function passwordDigest(value, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + (await scrypt(value, salt, 64)).toString('hex');
}
async function passwordMatches(value, stored) {
  const [salt, digest] = stored.split(':');
  if (!/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(digest)) return false;
  const actual = await scrypt(value, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(digest, 'hex'));
}
const mfaRef = (userId) => ({ workspaceId: 'identity', connectionId: userId, version: 1 });
const identityContext = (userId) => ({
  workspaceId: 'identity',
  actor: { kind: 'user', id: userId },
  requestId: 'identity',
});
function otp(secret) {
  return new OTPAuth.TOTP({
    issuer: 'Relay',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
// Dedicated restricted identity pool only. No pool/query handle escapes this repository.
export function createIdentityRepository({ pool, vault, sessionMs = 86400000, idleMs = 1800000 }) {
  if (
    !Number.isInteger(sessionMs) ||
    sessionMs < 60000 ||
    sessionMs > 7 * 86400000 ||
    !Number.isInteger(idleMs) ||
    idleMs < 60000 ||
    idleMs > sessionMs
  )
    throw new Error('Invalid session lifetime');
  let dummyDigest;
  async function transaction(fn) {
    const c = await pool.connect();
    let failed;
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL statement_timeout='10000'");
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await c.query('ROLLBACK');
      } catch {
        failed = error;
      }
      throw error;
    } finally {
      c.release(failed);
    }
  }
  async function audit(c, userId, action, requestId) {
    resourceId.parse(requestId);
    await c.query(
      'INSERT INTO relay.security_identity_audit(id,user_id,action,request_id) VALUES($1,$2,$3,$4)',
      [crypto.randomUUID(), userId, action, requestId],
    );
  }
  async function consumeOtp(c, user, code) {
    if (typeof code !== 'string') return false;
    if (/^[a-f0-9]{32}$/.test(code))
      return (
        (
          await c.query(
            'DELETE FROM relay.security_recovery_codes WHERE user_id=$1 AND code_hash=$2',
            [user.id, tokenHash(code)],
          )
        ).rowCount === 1
      );
    if (!/^\d{6}$/.test(code) || !user.mfa_secret) return false;
    const delta = otp(
      vault.open(identityContext(user.id), mfaRef(user.id), user.mfa_secret),
    ).validate({ token: code, window: 1 });
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30000) + delta;
    return (
      (
        await c.query(
          'UPDATE relay.security_accounts SET mfa_last_step=$2 WHERE id=$1 AND (mfa_last_step IS NULL OR mfa_last_step<$2)',
          [user.id, step],
        )
      ).rowCount === 1
    );
  }
  async function session(c, userId, requestId) {
    const token = opaque();
    await c.query(
      'INSERT INTO relay.security_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
      [tokenHash(token), userId, new Date(Date.now() + sessionMs).toISOString()],
    );
    await audit(c, userId, 'session.created', requestId);
    return { token, expiresAt: Date.now() + sessionMs };
  }
  async function challenge(c, userId, kind, ttl) {
    const token = opaque();
    await c.query('DELETE FROM relay.security_challenges WHERE user_id=$1 AND kind=$2', [
      userId,
      kind,
    ]);
    await c.query(
      'INSERT INTO relay.security_challenges(token_hash,user_id,kind,expires_at) VALUES($1,$2,$3,$4)',
      [tokenHash(token), userId, kind, new Date(Date.now() + ttl).toISOString()],
    );
    return token;
  }
  async function recent(c, sessionToken) {
    const row = (
      await c.query(
        `SELECT a.* FROM relay.security_sessions s JOIN relay.security_accounts a ON a.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND s.last_seen_at>$2 AND s.authenticated_at>now()-interval '10 minutes'
      AND a.disabled_at IS NULL FOR UPDATE OF a`,
        [tokenHash(sessionToken), new Date(Date.now() - idleMs).toISOString()],
      )
    ).rows[0];
    if (!row)
      throw new PlatformError(
        'UNAUTHENTICATED',
        'Sign in again before changing security settings.',
      );
    return row;
  }
  return Object.freeze({
    async workspaces(userId) {
      resourceId.parse(userId);
      return (await pool.query('SELECT * FROM relay.identity_workspaces($1)', [userId])).rows;
    },
    async externalLogin({ issuer, subject }, requestId) {
      z.string().max(2048).parse(issuer);
      z.string().min(1).max(255).parse(subject);
      return transaction(async (c) => {
        const user = (
          await c.query(
            `SELECT a.* FROM relay.security_oidc_identities i JOIN relay.security_accounts a ON a.id=i.user_id
          WHERE i.issuer=$1 AND i.subject=$2 AND a.disabled_at IS NULL FOR UPDATE OF a`,
            [issuer, subject],
          )
        ).rows[0];
        if (!user)
          throw new PlatformError(
            'FORBIDDEN',
            'Organization identity must be provisioned by an administrator.',
          );
        await audit(c, user.id, 'oidc.verified', requestId);
        if (user.mfa_secret)
          return { mfaRequired: true, challenge: await challenge(c, user.id, 'mfa', 180000) };
        return session(c, user.id, requestId);
      });
    },
    async register(input, requestId) {
      const b = z
        .object({ id: resourceId, email: z.email(), name: z.string().min(1).max(80), password })
        .strict()
        .parse(input);
      const digest = await passwordDigest(b.password);
      await transaction(async (c) => {
        await c.query(
          'INSERT INTO relay.security_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
          [b.id, b.email.toLowerCase(), b.name, digest],
        );
        await audit(c, b.id, 'account.created', requestId);
      });
      return { id: b.id, email: b.email.toLowerCase(), name: b.name };
    },
    async login(email, value, requestId) {
      email = z.email().parse(email).toLowerCase();
      z.string().max(200).parse(value);
      dummyDigest ??= await passwordDigest(opaque());
      const user = (
        await pool.query(
          'SELECT id,password_hash FROM relay.security_accounts WHERE email=$1 AND disabled_at IS NULL',
          [email],
        )
      ).rows[0];
      if (!(await passwordMatches(value, user?.password_hash || dummyDigest)) || !user)
        throw new PlatformError('UNAUTHENTICATED', 'Email or password is incorrect.');
      return transaction(async (c) => {
        const current = (
          await c.query(
            'SELECT * FROM relay.security_accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
            [user.id],
          )
        ).rows[0];
        if (!current || current.password_hash !== user.password_hash)
          throw new PlatformError('UNAUTHENTICATED', 'Sign in again.');
        if (current.mfa_secret)
          return { mfaRequired: true, challenge: await challenge(c, user.id, 'mfa', 180000) };
        return session(c, user.id, requestId);
      });
    },
    async verifyMfa(token, code, requestId) {
      z.string().max(100).parse(token);
      // Commit failed attempts too; throwing inside the transaction would erase the limit.
      const result = await transaction(async (c) => {
        const row = (
          await c.query(
            "SELECT * FROM relay.security_challenges WHERE token_hash=$1 AND kind='mfa' AND expires_at>now() AND attempts<5 FOR UPDATE",
            [tokenHash(token)],
          )
        ).rows[0];
        if (!row) return null;
        await c.query(
          'UPDATE relay.security_challenges SET attempts=attempts+1 WHERE token_hash=$1',
          [row.token_hash],
        );
        const user = (
          await c.query(
            'SELECT * FROM relay.security_accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
            [row.user_id],
          )
        ).rows[0];
        if (!user?.mfa_secret || !(await consumeOtp(c, user, code))) return null;
        await c.query('DELETE FROM relay.security_challenges WHERE token_hash=$1', [
          row.token_hash,
        ]);
        await audit(c, user.id, 'mfa.verified', requestId);
        return session(c, user.id, requestId);
      });
      if (!result)
        throw new PlatformError('UNAUTHENTICATED', 'Verification is invalid or expired.');
      return result;
    },
    async authenticate(token) {
      if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token))
        throw new PlatformError('UNAUTHENTICATED', 'Session is invalid.');
      const result = await pool.query(
        `UPDATE relay.security_sessions s SET last_seen_at=now() FROM relay.security_accounts a
        WHERE s.user_id=a.id AND s.token_hash=$1 AND s.expires_at>now() AND s.last_seen_at>$2 AND a.disabled_at IS NULL RETURNING a.id,a.name,a.email`,
        [tokenHash(token), new Date(Date.now() - idleMs).toISOString()],
      );
      if (!result.rows[0])
        throw new PlatformError('UNAUTHENTICATED', 'Session is invalid or expired.');
      return result.rows[0];
    },
    async logout(token, requestId) {
      await transaction(async (c) => {
        const row = (
          await c.query(
            'DELETE FROM relay.security_sessions WHERE token_hash=$1 RETURNING user_id',
            [tokenHash(token)],
          )
        ).rows[0];
        if (row) await audit(c, row.user_id, 'session.revoked', requestId);
      });
    },
    async setupMfa(sessionToken, value, requestId) {
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      await transaction(async (c) => {
        const user = await recent(c, sessionToken);
        if (
          user.mfa_secret ||
          !(await passwordMatches(z.string().max(200).parse(value), user.password_hash))
        )
          throw new PlatformError('UNAUTHENTICATED', 'Security verification failed.');
        await c.query('UPDATE relay.security_accounts SET mfa_pending=$2 WHERE id=$1', [
          user.id,
          vault.seal(mfaRef(user.id), secret),
        ]);
        await audit(c, user.id, 'mfa.setup', requestId);
      });
      return { secret, uri: otp(secret).toString() };
    },
    async confirmMfa(sessionToken, code, requestId) {
      const codes = Array.from({ length: 8 }, () => crypto.randomBytes(16).toString('hex'));
      await transaction(async (c) => {
        const user = await recent(c, sessionToken);
        const secret =
          user.mfa_pending &&
          vault.open(identityContext(user.id), mfaRef(user.id), user.mfa_pending);
        const delta =
          secret && /^\d{6}$/.test(code) ? otp(secret).validate({ token: code, window: 1 }) : null;
        if (delta === null || !secret)
          throw new PlatformError('UNAUTHENTICATED', 'Authenticator code is incorrect.');
        await c.query(
          'UPDATE relay.security_accounts SET mfa_secret=mfa_pending,mfa_pending=NULL,mfa_last_step=$2 WHERE id=$1',
          [user.id, Math.floor(Date.now() / 30000) + delta],
        );
        await c.query('DELETE FROM relay.security_recovery_codes WHERE user_id=$1', [user.id]);
        for (const value of codes)
          await c.query('INSERT INTO relay.security_recovery_codes VALUES($1,$2)', [
            user.id,
            tokenHash(value),
          ]);
        await c.query('DELETE FROM relay.security_sessions WHERE user_id=$1 AND token_hash!=$2', [
          user.id,
          tokenHash(sessionToken),
        ]);
        await c.query('DELETE FROM relay.security_challenges WHERE user_id=$1', [user.id]);
        await audit(c, user.id, 'mfa.enabled', requestId);
      });
      return { recoveryCodes: codes };
    },
    async changePassword(sessionToken, current, next, code, requestId) {
      password.parse(next);
      const digest = await passwordDigest(next);
      return transaction(async (c) => {
        const user = await recent(c, sessionToken);
        if (
          !(await passwordMatches(z.string().max(200).parse(current), user.password_hash)) ||
          (user.mfa_secret && !(await consumeOtp(c, user, code)))
        )
          throw new PlatformError('UNAUTHENTICATED', 'Security verification failed.');
        await c.query('UPDATE relay.security_accounts SET password_hash=$2 WHERE id=$1', [
          user.id,
          digest,
        ]);
        await c.query('DELETE FROM relay.security_sessions WHERE user_id=$1', [user.id]);
        await c.query('DELETE FROM relay.security_challenges WHERE user_id=$1', [user.id]);
        await audit(c, user.id, 'password.changed', requestId);
        return session(c, user.id, requestId);
      });
    },
    async disableMfa(sessionToken, current, code, requestId) {
      return transaction(async (c) => {
        const user = await recent(c, sessionToken);
        if (
          !user.mfa_secret ||
          !(await passwordMatches(z.string().max(200).parse(current), user.password_hash)) ||
          !(await consumeOtp(c, user, code))
        )
          throw new PlatformError('UNAUTHENTICATED', 'Security verification failed.');
        await c.query(
          'UPDATE relay.security_accounts SET mfa_secret=NULL,mfa_pending=NULL,mfa_last_step=NULL WHERE id=$1',
          [user.id],
        );
        await c.query('DELETE FROM relay.security_recovery_codes WHERE user_id=$1', [user.id]);
        await c.query('DELETE FROM relay.security_sessions WHERE user_id=$1', [user.id]);
        await c.query('DELETE FROM relay.security_challenges WHERE user_id=$1', [user.id]);
        await audit(c, user.id, 'mfa.disabled', requestId);
        return session(c, user.id, requestId);
      });
    },
    async requestReset(email, deliver, requestId) {
      email = z.email().parse(email).toLowerCase();
      const user = (
        await pool.query(
          'SELECT id FROM relay.security_accounts WHERE email=$1 AND disabled_at IS NULL',
          [email],
        )
      ).rows[0];
      if (!user) return;
      const token = await transaction(async (c) => {
        const value = await challenge(c, user.id, 'reset', 1800000);
        await audit(c, user.id, 'password.reset.requested', requestId);
        return value;
      });
      try {
        await deliver({ email, token });
      } catch {
        await pool.query('DELETE FROM relay.security_challenges WHERE token_hash=$1', [
          tokenHash(token),
        ]);
      }
    },
    async completeReset(token, next, requestId) {
      password.parse(next);
      z.string().max(100).parse(token);
      const digest = await passwordDigest(next);
      await transaction(async (c) => {
        const row = (
          await c.query(
            "DELETE FROM relay.security_challenges WHERE token_hash=$1 AND kind='reset' AND expires_at>now() RETURNING user_id",
            [tokenHash(token)],
          )
        ).rows[0];
        if (!row)
          throw new PlatformError('UNAUTHENTICATED', 'Recovery link is invalid or expired.');
        await c.query('UPDATE relay.security_accounts SET password_hash=$2 WHERE id=$1', [
          row.user_id,
          digest,
        ]);
        await c.query('DELETE FROM relay.security_sessions WHERE user_id=$1', [row.user_id]);
        await c.query('DELETE FROM relay.security_challenges WHERE user_id=$1', [row.user_id]);
        await audit(c, row.user_id, 'password.reset.completed', requestId);
        // Recovery resets the password only; MFA still gates sign-in.
      });
    },
  });
}
