import crypto from 'node:crypto';
import { one, exec, id, now, hash } from './db.js';
export function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}
export function checkPassword(password, stored) {
  const [salt, key] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(key, 'hex'));
}
export function createSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  exec('INSERT INTO sessions VALUES(?,?,?)', hash(token), user, Date.now() + 7 * 86400000);
  res.cookie('relay_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 7 * 86400000,
    path: '/',
  });
}
export function authenticate(req, res, next) {
  const row = one(
    'SELECT u.id,u.name,u.email FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?',
    hash(req.cookies.relay_session || ''),
    Date.now(),
  );
  if (!row) return res.status(401).json({ error: 'Sign in to continue' });
  req.user = row;
  next();
}
export const rank = { viewer: 0, editor: 1, administrator: 2, owner: 3 };
export function workspaceAccess(req, res, next) {
  const w = req.params.wid;
  const m = one('SELECT role FROM members WHERE workspace_id=? AND user_id=?', w, req.user.id);
  if (!m) return res.status(403).json({ error: 'You do not have access to this workspace' });
  req.workspace = w;
  req.role = m.role;
  next();
}
export function requireRole(role) {
  return (req, res, next) => {
    if (rank[req.role] < rank[role])
      return res.status(403).json({ error: `${role} access is required` });
    next();
  };
}
export function createWorkspace(user, name) {
  const w = id();
  exec('INSERT INTO workspaces VALUES(?,?,?,?)', w, name, '{}', now());
  exec('INSERT INTO members VALUES(?,?,?)', w, user, 'owner');
  exec('INSERT INTO projects VALUES(?,?,?,?,?)', id(), w, 'General', 'Your first project', now());
  return w;
}
