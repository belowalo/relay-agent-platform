import { all, one, exec, decode, audit, transaction } from './db.js';
export function purgeHistory(wid, at = Date.now(), actor = 'system') {
  const settings = decode(one('SELECT settings FROM workspaces WHERE id=?', wid)?.settings) || {};
  const days = settings.historyRetentionDays;
  if (!Number.isInteger(days) || days < 1 || days > 3650) return { deleted: 0 };
  return transaction(() => {
    // Retain active execution trees and every run needed by saved evaluation reports.
    const rows = all(
      `WITH RECURSIVE protected(id) AS (
      SELECT id FROM runs WHERE workspace_id=? AND status IN ('queued','running','waiting')
      UNION SELECT c.run_id FROM evaluation_cases c JOIN evaluations e ON e.id=c.evaluation_id WHERE e.workspace_id=?
      UNION SELECT c.judge_run_id FROM evaluation_cases c JOIN evaluations e ON e.id=c.evaluation_id WHERE e.workspace_id=? AND c.judge_run_id IS NOT NULL
      UNION SELECT r.id FROM runs r JOIN protected p ON r.parent_id LIKE p.id||':%' WHERE r.workspace_id=?
    ) SELECT id FROM runs WHERE workspace_id=? AND status IN ('completed','failed','cancelled') AND finished_at<? AND id NOT IN (SELECT id FROM protected) ORDER BY finished_at LIMIT 100`,
      wid,
      wid,
      wid,
      wid,
      wid,
      new Date(at - days * 86400000).toISOString(),
    );
    for (const row of rows) {
      exec('DELETE FROM actions WHERE run_id=? AND workspace_id=?', row.id, wid);
      exec(
        'UPDATE schedules SET last_run_id=NULL WHERE last_run_id=? AND workspace_id=?',
        row.id,
        wid,
      );
      exec('DELETE FROM runs WHERE id=? AND workspace_id=?', row.id, wid);
    }
    if (rows.length) audit(wid, actor, 'history.retained', String(rows.length));
    return { deleted: rows.length };
  });
}
