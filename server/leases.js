import { all, one, exec, id, transaction } from './db.js';
export const workerId = process.env.WORKER_ID || id();
export const workerCapacity = Math.max(1, Math.min(128, Number(process.env.WORKER_CAPACITY) || 24));
export const leaseMs = Math.max(2000, Number(process.env.WORKER_LEASE_MS) || 5000);
let lastHeartbeat = 0,
  lastActive = -1;
export function registerWorker() {
  exec(
    'INSERT OR REPLACE INTO workers VALUES(?,?,?,?,?,?)',
    workerId,
    process.env.WORKER_NAME || `worker-${workerId.slice(0, 8)}`,
    Date.now(),
    Date.now(),
    workerCapacity,
    0,
  );
}
export function heartbeat(active) {
  if (active === lastActive && Date.now() - lastHeartbeat < Math.min(1000, leaseMs / 3)) return;
  lastHeartbeat = Date.now();
  lastActive = active;
  exec('UPDATE workers SET heartbeat=?,active=? WHERE id=?', Date.now(), active, workerId);
  exec(
    "UPDATE runs SET lease_until=? WHERE lease_owner=? AND status IN ('queued','running','waiting')",
    Date.now() + leaseMs,
    workerId,
  );
}
export function owns(run) {
  const r = one(
    'SELECT lease_owner,lease_generation,lease_until,status FROM runs WHERE id=?',
    run.id,
  );
  return (
    r?.lease_owner === workerId &&
    r.lease_generation === run.lease_generation &&
    r.lease_until > Date.now() &&
    ['queued', 'running', 'waiting'].includes(r.status)
  );
}
export function claimRuns(recoverRun) {
  return transaction(() => {
    const owned = all(
      "SELECT * FROM runs WHERE status IN ('queued','running','waiting') AND lease_owner=? AND lease_until>?",
      workerId,
      Date.now(),
    );
    const slots = Math.max(0, workerCapacity - owned.filter((r) => r.status !== 'waiting').length);
    const candidates = slots
      ? all(
          "SELECT * FROM runs WHERE status IN ('queued','running','waiting') AND (lease_until IS NULL OR lease_until<?) ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,created_at LIMIT ?",
          Date.now(),
          slots,
        )
      : [];
    const runs = [...owned, ...candidates];
    for (const r of runs) {
      if (r.lease_owner !== workerId || r.lease_until < Date.now()) {
        recoverRun(r.id);
        exec(
          'UPDATE runs SET lease_owner=?,lease_until=?,lease_generation=lease_generation+1 WHERE id=?',
          workerId,
          Date.now() + leaseMs,
          r.id,
        );
      }
    }
    return runs.map((r) => one('SELECT * FROM runs WHERE id=?', r.id));
  });
}
export function stopWorker() {
  exec('DELETE FROM workers WHERE id=?', workerId);
  exec(
    "UPDATE runs SET lease_until=0 WHERE lease_owner=? AND status IN ('queued','running','waiting')",
    workerId,
  );
}
