import { CronExpressionParser } from 'cron-parser';
export function nextSchedule(schedule, from = Date.now()) {
  const expression = schedule.cron_expression || schedule.cronExpression;
  if (!expression) return from + (schedule.interval_minutes || schedule.intervalMinutes) * 60000;
  if (typeof expression !== 'string' || expression.trim().split(/\s+/).length !== 5)
    throw new Error('Use a five-field cron expression (minute hour day month weekday)');
  const timezone = schedule.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('Choose a valid IANA timezone');
  }
  try {
    return CronExpressionParser.parse(expression, {
      currentDate: from,
      tz: timezone,
      hashSeed: schedule.id || expression,
    })
      .next()
      .getTime();
  } catch {
    throw new Error('Invalid cron expression or no upcoming calendar occurrence');
  }
}
