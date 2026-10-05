export function browserBoundary({ publicOrigin, development = false }) {
  const expected = new URL(publicOrigin).origin;
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const bearer = /^Bearer /i.test(req.headers.authorization || '');
    const origin = req.headers.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site' && !bearer)
      return res.status(403).json({ error: 'Cross-site request is forbidden' });
    if (origin) {
      let parsed;
      try {
        parsed = new URL(origin).origin;
      } catch {
        return res.status(403).json({ error: 'Invalid request origin' });
      }
      if (
        parsed !== expected &&
        !(development && ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(parsed))
      )
        return res.status(403).json({ error: 'Request origin is not allowed' });
    } else if (req.cookies?.relay_session && !bearer && process.env.NODE_ENV === 'production')
      return res.status(403).json({ error: 'Browser requests require an Origin header' });
    next();
  };
}
export function validateOidcConfiguration(env = process.env) {
  const configured = !!(env.OIDC_ISSUER || env.OIDC_CLIENT_ID || env.OIDC_CLIENT_SECRET);
  if (!configured) return null;
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.PUBLIC_ORIGIN)
    throw new Error('OIDC configuration is incomplete');
  const issuer = new URL(env.OIDC_ISSUER),
    origin = new URL(env.PUBLIC_ORIGIN);
  if (
    !['http:', 'https:'].includes(issuer.protocol) ||
    !['http:', 'https:'].includes(origin.protocol) ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    origin.username ||
    origin.password ||
    origin.href !== origin.origin + '/'
  )
    throw new Error('Invalid OIDC origin or issuer');
  if (env.NODE_ENV === 'production' || env.RELAY_PROFILE === 'production') {
    if (
      issuer.protocol !== 'https:' ||
      origin.protocol !== 'https:' ||
      env.COOKIE_SECURE !== 'true'
    )
      throw new Error('Production OIDC requires HTTPS and secure cookies');
    if (!(env.OIDC_EMAIL_DOMAINS || '').trim())
      throw new Error('Production OIDC requires explicit permitted email domains');
  }
  return { issuer: env.OIDC_ISSUER, callback: origin.origin + '/api/auth/sso/callback' };
}
