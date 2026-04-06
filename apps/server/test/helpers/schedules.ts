import type { AutomationScheduleTrigger } from "@bb/server-contract";
import { serializeScheduleDefinitionAsCron } from "../../src/services/schedule-helpers.js";

type WeekdayName =
  | "fri"
  | "mon"
  | "sat"
  | "sun"
  | "thu"
  | "tue"
  | "wed";

interface HourlyScheduleArgs {
  intervalHours: number;
  minute?: number;
  timezone?: string;
}

interface DailyScheduleArgs {
  times: string[];
  timezone?: string;
}

interface WeeklyScheduleArgs {
  times: string[];
  timezone?: string;
  weekdays: WeekdayName[];
}

interface MonthlyScheduleArgs {
  dayOfMonth: number;
  times: string[];
  timezone?: string;
}

interface ScheduleCronDefinition {
  cron: string;
  timezone: string;
}

const DEFAULT_TIMEZONE = "UTC";

export function createHourlySchedule(
  args: HourlyScheduleArgs,
): ScheduleCronDefinition {
  const timezone = args.timezone ?? DEFAULT_TIMEZONE;
  return {
    cron: serializeScheduleDefinitionAsCron({
      intervalHours: args.intervalHours,
      kind: "hourly",
      minute: args.minute ?? 0,
      timezone,
    }),
    timezone,
  };
}

export function createDailySchedule(
  args: DailyScheduleArgs,
): ScheduleCronDefinition {
  const timezone = args.timezone ?? DEFAULT_TIMEZONE;
  return {
    cron: serializeScheduleDefinitionAsCron({
      kind: "daily",
      times: args.times,
      timezone,
    }),
    timezone,
  };
}

export function createWeeklySchedule(
  args: WeeklyScheduleArgs,
): ScheduleCronDefinition {
  const timezone = args.timezone ?? DEFAULT_TIMEZONE;
  return {
    cron: serializeScheduleDefinitionAsCron({
      kind: "weekly",
      times: args.times,
      timezone,
      weekdays: args.weekdays,
    }),
    timezone,
  };
}

export function createMonthlySchedule(
  args: MonthlyScheduleArgs,
): ScheduleCronDefinition {
  const timezone = args.timezone ?? DEFAULT_TIMEZONE;
  return {
    cron: serializeScheduleDefinitionAsCron({
      dayOfMonth: args.dayOfMonth,
      kind: "monthly",
      times: args.times,
      timezone,
    }),
    timezone,
  };
}

export function createScheduleTrigger(
  schedule: ScheduleCronDefinition,
): AutomationScheduleTrigger {
  return {
    cron: schedule.cron,
    timezone: schedule.timezone,
    triggerType: "schedule",
  };
}
