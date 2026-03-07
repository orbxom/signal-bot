import { Cron } from 'croner';

export function computeNextDue(cronExpression: string, timezone: string, after?: Date): number {
  const job = new Cron(cronExpression, { timezone });
  const next = job.nextRun(after || new Date());
  if (!next) {
    throw new Error(`No next occurrence for cron expression: ${cronExpression}`);
  }
  return next.getTime();
}

export function isValidCron(cronExpression: string): boolean {
  try {
    new Cron(cronExpression);
    return true;
  } catch {
    return false;
  }
}

export function describeCron(cronExpression: string, timezone: string): string {
  const job = new Cron(cronExpression, { timezone });
  const runs = job.nextRuns(3);
  return runs.map(d => d.toLocaleString('en-AU', { timeZone: timezone })).join('\n');
}
