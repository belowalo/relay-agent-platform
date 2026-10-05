import { all, one, exec, decode, transaction } from './db.js';
import { createRun } from './engine.js';
import { recover } from './engine.js';
import { pumpEvaluations } from './evaluations.js';
let last = 0;
export function maintenance() {
  if (Date.now() - last < 500) return;
  last = Date.now();
  pumpEvaluations();
  recover();
  for (const schedule of all(
    'SELECT * FROM schedules WHERE enabled=1 AND next_at<=? LIMIT 20',
    Date.now(),
  )) {
    try {
      transaction(() => {
        const claimed = exec(
          'UPDATE schedules SET next_at=? WHERE id=? AND next_at=? AND enabled=1',
          Date.now() + schedule.interval_minutes * 60000,
          schedule.id,
          schedule.next_at,
        );
        if (!claimed.changes) return;
        const w = one(
          'SELECT * FROM workflows WHERE id=? AND workspace_id=?',
          schedule.workflow_id,
          schedule.workspace_id,
        );
        if (!w) throw new Error('Scheduled workflow was removed');
        const rid = createRun({
          wid: schedule.workspace_id,
          workflowId: w.id,
          graph: decode(w.graph),
          input: decode(schedule.input),
          mode: schedule.mode,
        });
        exec('UPDATE schedules SET last_run_id=? WHERE id=?', rid, schedule.id);
      });
    } catch {
      exec('UPDATE schedules SET enabled=0 WHERE id=?', schedule.id);
    }
  }
}
