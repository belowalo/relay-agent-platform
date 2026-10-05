import { tokenHash } from './tokens.js';
import { PlatformError } from '../foundation/errors.js';
export const ratePolicies = Object.freeze({
  login: { limit: 20, windowMs: 900000 },
  account: { limit: 40, windowMs: 900000 },
  api: { limit: 300, windowMs: 60000 },
  publication: { limit: 20, windowMs: 60000 },
  upload: { limit: 10, windowMs: 60000 },
  public: { limit: 30, windowMs: 60000 },
  webhook: { limit: 60, windowMs: 60000 },
});
export function createRateLimiter({ pool }) {
  return Object.freeze({
    async consume(policy, key) {
      const rule = ratePolicies[policy];
      if (!rule || typeof key !== 'string' || key.length > 512)
        throw new PlatformError('VALIDATION_ERROR', 'Invalid rate policy.');
      const keyHash = tokenHash(policy + ':' + key);
      const result = await pool.query(
        `INSERT INTO relay.security_rate_buckets VALUES($1,1,now()+$2*interval '1 millisecond')
      ON CONFLICT(key_hash) DO UPDATE SET count=CASE WHEN security_rate_buckets.expires_at<=now() THEN 1 ELSE security_rate_buckets.count+1 END,
      expires_at=CASE WHEN security_rate_buckets.expires_at<=now() THEN now()+$2*interval '1 millisecond' ELSE security_rate_buckets.expires_at END RETURNING count,expires_at`,
        [keyHash, rule.windowMs],
      );
      if (result.rows[0].count > rule.limit)
        throw new PlatformError('RATE_LIMITED', 'Rate limit reached.', { retryable: true });
      return {
        remaining: rule.limit - result.rows[0].count,
        resetAt: new Date(result.rows[0].expires_at).getTime(),
      };
    },
    async prune() {
      await pool.query('DELETE FROM relay.security_rate_buckets WHERE expires_at<now()');
    },
  });
}
// Single-process local adapter: bounded memory; production uses the shared PostgreSQL limiter.
export function localRateLimit({ limit, windowMs, maxKeys = 10000 }) {
  const records = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (records.size >= maxKeys)
      for (const [key, row] of records) if (row.reset <= now) records.delete(key);
    const key = req.user?.id || req.ip;
    let row = records.get(key);
    if (!row && records.size >= maxKeys)
      return res.status(429).json({ error: 'Rate limiter capacity reached' });
    if (!row || row.reset <= now) row = { count: 0, reset: now + windowMs };
    row.count++;
    records.set(key, row);
    if (row.count > limit)
      return res
        .set('Retry-After', String(Math.ceil((row.reset - now) / 1000)))
        .status(429)
        .json({ error: 'Rate limit reached' });
    next();
  };
}
