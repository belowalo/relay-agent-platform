// Legacy local profile enforcement. Production uses the async repositories.
import { db, one, all, exec, hash, audit, transaction } from '../db.js';
import crypto from 'node:crypto';
db.exec(`CREATE TABLE IF NOT EXISTS security_run_actors(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,user_id TEXT,application_id TEXT,token_hash TEXT,public_guest INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS security_guest_runs(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS security_source_access(source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,principals TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS security_webhook_receipts(application_id TEXT NOT NULL,key_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,
  PRIMARY KEY(application_id,key_hash));
CREATE TABLE IF NOT EXISTS security_invitation_issuers(invitation_id TEXT PRIMARY KEY REFERENCES invitations(id) ON DELETE CASCADE,user_id TEXT NOT NULL);`);
if (!all('PRAGMA table_info(security_guest_runs)').some((column) => column.name === 'expires_at'))
  db.exec('ALTER TABLE security_guest_runs ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
export function publicationAuthorized(application) {
  if (!application) return false;
  const settings =
    typeof application.settings === 'string'
      ? JSON.parse(application.settings)
      : application.settings;
  const publisher = one(
    'SELECT role FROM members WHERE workspace_id=? AND user_id=?',
    application.workspace_id,
    settings.publisherId,
  );
  return ['owner', 'administrator'].includes(publisher?.role);
}
export function recordInvitation(id, userId) {
  exec('INSERT INTO security_invitation_issuers VALUES(?,?)', id, userId);
}
export function invitationAuthorized(invitation) {
  const issuer = one(
    'SELECT user_id FROM security_invitation_issuers WHERE invitation_id=?',
    invitation.id,
  );
  const member =
    issuer &&
    one(
      'SELECT role FROM members WHERE workspace_id=? AND user_id=?',
      invitation.workspace_id,
      issuer.user_id,
    );
  return invitation.role === 'administrator'
    ? member?.role === 'owner'
    : ['owner', 'administrator'].includes(member?.role);
}
export function revokeMemberDelegations(wid, userId) {
  exec(
    'DELETE FROM invitations WHERE workspace_id=? AND accepted=0 AND id IN (SELECT invitation_id FROM security_invitation_issuers WHERE user_id=?)',
    wid,
    userId,
  );
  for (const application of all('SELECT id,settings FROM applications WHERE workspace_id=?', wid)) {
    const settings = JSON.parse(application.settings);
    if (settings.publisherId === userId)
      exec(
        'UPDATE applications SET settings=? WHERE id=?',
        JSON.stringify({ ...settings, tokenRevoked: true }),
        application.id,
      );
  }
}
export function attachRunActor(
  runId,
  wid,
  { userId = null, applicationId = null, tokenHash = null, publicGuest = false } = {},
) {
  exec(
    'INSERT INTO security_run_actors VALUES(?,?,?,?,?,?)',
    runId,
    wid,
    userId,
    applicationId,
    tokenHash,
    publicGuest ? 1 : 0,
  );
}
export function inheritRunActor(parentId, childId) {
  const row = one('SELECT * FROM security_run_actors WHERE run_id=?', parentId);
  if (row)
    attachRunActor(childId, row.workspace_id, {
      userId: row.user_id,
      applicationId: row.application_id,
      tokenHash: row.token_hash,
      publicGuest: !!row.public_guest,
    });
}
export function runPrincipal(runId) {
  const row = one('SELECT user_id,application_id FROM security_run_actors WHERE run_id=?', runId);
  if (row?.user_id) return { kind: 'user', id: row.user_id };
  if (row?.application_id) return { kind: 'application', id: row.application_id };
  return null;
}
export function assertRunAuthorized(runId) {
  const row = one('SELECT * FROM security_run_actors WHERE run_id=?', runId);
  // Unattributed legacy schedules/evaluations are local-only and must be migrated explicitly.
  if (!row) return;
  if (row.user_id) {
    const member = one(
      'SELECT role FROM members WHERE workspace_id=? AND user_id=?',
      row.workspace_id,
      row.user_id,
    );
    if (!['editor', 'administrator', 'owner'].includes(member?.role))
      throw new Error('Run actor no longer has execution permission');
  }
  if (row.application_id) {
    const application = one(
      'SELECT token_hash,settings,workspace_id FROM applications WHERE workspace_id=? AND id=?',
      row.workspace_id,
      row.application_id,
    );
    const settings = application && JSON.parse(application.settings);
    if (
      !application ||
      !publicationAuthorized(application) ||
      (row.public_guest
        ? !settings.public
        : application.token_hash !== row.token_hash ||
          settings.tokenRevoked ||
          settings.tokenExpiresAt <= Date.now())
    )
      throw new Error('Run application authorization was revoked');
  }
}
export function accountAudit(userId, action) {
  for (const row of all('SELECT workspace_id FROM members WHERE user_id=?', userId))
    audit(row.workspace_id, userId, action, userId);
}
export function issueGuestRun(res, aid, runId) {
  const value = crypto.randomBytes(32).toString('base64url');
  exec('INSERT INTO security_guest_runs VALUES(?,?,?)', runId, hash(value), Date.now() + 86400000);
  res.cookie('relay_run_' + runId, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    maxAge: 86400000,
    path: `/apps/${aid}/runs/${runId}`,
  });
}
export function guestRunAccess(req, runId) {
  const row = one(
    'SELECT token_hash FROM security_guest_runs WHERE run_id=? AND expires_at>?',
    runId,
    Date.now(),
  );
  return !!row && row.token_hash === hash(req.cookies['relay_run_' + runId] || '');
}
export function consumeWebhook(a, key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key))
    throw Object.assign(new Error('Webhook requires a bounded unique Idempotency-Key'), {
      status: 400,
    });
  transaction(() => {
    exec('DELETE FROM security_webhook_receipts WHERE expires_at<?', Date.now());
    if (
      one(
        'SELECT key_hash FROM security_webhook_receipts WHERE application_id=? AND key_hash=?',
        a.id,
        hash(key),
      )
    )
      throw Object.assign(new Error('Webhook replay was rejected'), { status: 409 });
    exec(
      'INSERT INTO security_webhook_receipts VALUES(?,?,?)',
      a.id,
      hash(key),
      Date.now() + 86400000,
    );
  });
}
export function sourceAccessFilter(wid, actor = null) {
  // No actor means deny restricted documents, including internal/legacy callers.
  const principal = actor ? `${actor.kind}:${actor.id}` : '';
  return {
    sql: ` AND NOT EXISTS(SELECT 1 FROM security_source_access acl WHERE acl.workspace_id=? AND acl.source_id=s.id
    AND NOT EXISTS(SELECT 1 FROM json_each(acl.principals) p WHERE p.value=?))`,
    args: [wid, principal],
  };
}
