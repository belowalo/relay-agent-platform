import { nextSchedule } from '../schedules.js';
import { uuid, json, decode, instant, clockSql, contextFor, fail } from './core.js';
export function createRuntimeScheduler({ repository, authorize }) {
  return {
    async create(
      context,
      {
        workflowId,
        versionId,
        name,
        input,
        intervalMinutes = 60,
        cronExpression = null,
        timezone = 'UTC',
        mode = 'live',
      },
    ) {
      const next = nextSchedule({ intervalMinutes, cronExpression, timezone });
      if (
        !Number.isSafeInteger(next) ||
        (!cronExpression && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1))
      )
        fail('INVALID_SCHEDULE');
      return repository.tx(context, async (s) => {
        const clock = await s.one(`SELECT ${clockSql} AS runtime_now`);
        const due = nextSchedule(
          { intervalMinutes, cronExpression, timezone },
          Number(clock.runtime_now),
        );
        const version = await s.one(
          'SELECT id FROM relay.versions WHERE id=$1 AND workspace_id=$2 AND workflow_id=$3',
          [versionId, context.workspaceId, workflowId],
        );
        if (!version) fail('NOT_FOUND');
        const id = uuid();
        await s.query(
          'INSERT INTO relay.schedules(id,workspace_id,workflow_id,name,interval_minutes,input,mode,next_at,created_at,cron_expression,timezone,version_id,actor,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
          [
            id,
            context.workspaceId,
            workflowId,
            name,
            intervalMinutes,
            json(input),
            mode,
            due,
            instant(),
            cronExpression,
            timezone,
            versionId,
            json(context.actor),
            context.requestId,
          ],
        );
        return id;
      });
    },
    async tick(context) {
      const candidates = await repository.tx(context, (s) =>
        s.all(
          `SELECT * FROM relay.schedules WHERE workspace_id=$1 AND actor IS NOT NULL AND enabled=1 AND next_at<=${clockSql} ORDER BY next_at LIMIT 20`,
          [context.workspaceId],
        ),
      );
      for (const candidate of candidates) {
        const actorContext = contextFor(candidate);
        // Never hold DB locks while calling authorization or external services.
        const allowed = await authorize(actorContext, {
          operation: 'schedule',
          schedule: candidate,
        });
        await repository.tx(actorContext, async (s) => {
          const schedule = await s.one(
            `SELECT *,${clockSql} AS runtime_now FROM relay.schedules WHERE id=$1 AND workspace_id=$2 AND enabled=1 AND next_at<=${clockSql} FOR UPDATE SKIP LOCKED`,
            [candidate.id, context.workspaceId],
          );
          if (!schedule) return;
          if (!allowed) {
            await s.query('UPDATE relay.schedules SET enabled=0 WHERE id=$1', [schedule.id]);
            return;
          }
          const version = await s.one(
            'SELECT * FROM relay.versions WHERE id=$1 AND workspace_id=$2',
            [schedule.version_id, context.workspaceId],
          );
          if (!version) fail('NOT_FOUND');
          const existing = await s.one(
            'SELECT run_id FROM relay.runtime_schedule_fires WHERE schedule_id=$1 AND due_at=$2',
            [schedule.id, schedule.next_at],
          );
          const runId =
            existing?.run_id ||
            (await repository.createInSession(s, {
              graph: decode(version.graph),
              input: decode(schedule.input),
              workflowId: schedule.workflow_id,
              versionId: schedule.version_id,
              mode: schedule.mode,
            }));
          if (!existing)
            await s.query(
              'INSERT INTO relay.runtime_schedule_fires(workspace_id,schedule_id,due_at,run_id) VALUES($1,$2,$3,$4)',
              [context.workspaceId, schedule.id, schedule.next_at, runId],
            );
          // Coalesce downtime; do not flood the queue with every missed interval.
          await s.query('UPDATE relay.schedules SET next_at=$2,last_run_id=$3 WHERE id=$1', [
            schedule.id,
            nextSchedule(schedule, Number(schedule.runtime_now)),
            runId,
          ]);
        });
      }
    },
  };
}
