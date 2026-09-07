import { CronExpressionParser } from "cron-parser";

const CRON_FIELD_COUNT = 5;

class ScheduleValidationError extends Error {}

function parseExpression(args: {
  cron: string;
  now: number;
  timezone: string;
}) {
  try {
    return CronExpressionParser.parse(args.cron, {
      currentDate: new Date(args.now),
      tz: args.timezone,
    });
  } catch (error) {
    throw new ScheduleValidationError(
      error instanceof Error ? error.message : "Invalid cron expression",
    );
  }
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
      new Date(0),
    );
  } catch {
    throw new ScheduleValidationError("Invalid timezone");
  }
}

export function validateScheduleDefinition(args: {
  cron: string;
  timezone: string;
}): void {
  const fields = args.cron.trim().split(/\s+/u);
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new ScheduleValidationError(
      "Cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week)",
    );
  }
  assertValidTimezone(args.timezone);
  parseExpression({
    cron: args.cron,
    now: Date.now(),
    timezone: args.timezone,
  });
}

export function computeNextScheduledTime(args: {
  cron: string;
  now: number;
  timezone: string;
}): number {
  validateScheduleDefinition({ cron: args.cron, timezone: args.timezone });
  return parseExpression(args).next().getTime();
}

export function validateOnceDefinition(args: {
  runAt: number;
  now: number;
}): void {
  if (args.runAt <= args.now) {
    throw new ScheduleValidationError(
      "One-shot run time must be in the future",
    );
  }
}

export function computeInitialNextRunAt(args: {
  trigger:
    | { triggerType: "schedule"; cron: string; timezone: string }
    | { triggerType: "once"; runAt: number };
  enabled: boolean;
  now: number;
}): number | null {
  if (!args.enabled) return null;
  if (args.trigger.triggerType === "once") {
    validateOnceDefinition({ runAt: args.trigger.runAt, now: args.now });
    return args.trigger.runAt;
  }
  return computeNextScheduledTime({
    cron: args.trigger.cron,
    timezone: args.trigger.timezone,
    now: args.now,
  });
}
