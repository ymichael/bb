import { CronExpressionParser } from "cron-parser";

const MINIMUM_SCHEDULE_INTERVAL_MINUTES = 5;
const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const WEEKDAY_ORDER = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;

type WeekdayName = typeof WEEKDAY_ORDER[number];

interface ScheduleAtTimeArgs {
  cron: string;
  now: number;
  timezone: string;
}

interface ScheduleExpressionSetArgs {
  expressionSet: string;
  now: number;
  timezone: string;
}

interface CronScheduleArgs {
  cron: string;
  timezone: string;
}

interface TimeOfDayParts {
  hour: number;
  minute: number;
}

interface HourlyScheduleDefinition {
  intervalHours: number;
  kind: "hourly";
  minute: number;
  timezone: string;
}

interface DailyScheduleDefinition {
  kind: "daily";
  times: string[];
  timezone: string;
}

interface WeeklyScheduleDefinition {
  kind: "weekly";
  times: string[];
  timezone: string;
  weekdays: WeekdayName[];
}

interface MonthlyScheduleDefinition {
  dayOfMonth: number;
  kind: "monthly";
  times: string[];
  timezone: string;
}

type ScheduleDefinition =
  | DailyScheduleDefinition
  | HourlyScheduleDefinition
  | MonthlyScheduleDefinition
  | WeeklyScheduleDefinition;

type ParsedHourField =
  | {
      hours: number[];
      kind: "fixed";
    }
  | {
      intervalHours: number;
      kind: "interval";
    };

export class ScheduleValidationError extends Error {}

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
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    }).format(new Date(0));
  } catch {
    throw new ScheduleValidationError("Invalid timezone");
  }
}

function parseTimeOfDay(time: string): TimeOfDayParts {
  const match = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u.exec(time);
  if (!match?.groups) {
    throw new ScheduleValidationError("Invalid time-of-day");
  }

  return {
    hour: Number(match.groups.hour),
    minute: Number(match.groups.minute),
  };
}

function toTimeOfDayString(parts: TimeOfDayParts): string {
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function toMinuteOfDay(time: string): number {
  const { hour, minute } = parseTimeOfDay(time);
  return hour * 60 + minute;
}

function assertMinimumGapWithinSortedPoints(
  args: {
    cycleLengthMinutes: number;
    points: number[];
    wrapAround: boolean;
  },
): void {
  if (args.points.length <= 1) {
    return;
  }

  const sorted = [...args.points].sort(compareNumbers);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current - previous < MINIMUM_SCHEDULE_INTERVAL_MINUTES) {
      throw new ScheduleValidationError(
        "Schedule must not run more frequently than every 5 minutes",
      );
    }
  }

  if (!args.wrapAround) {
    return;
  }

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const wrapGap = args.cycleLengthMinutes - last + first;
  if (wrapGap < MINIMUM_SCHEDULE_INTERVAL_MINUTES) {
    throw new ScheduleValidationError(
      "Schedule must not run more frequently than every 5 minutes",
    );
  }
}

function toWeekdayIndex(weekday: WeekdayName): number {
  return WEEKDAY_ORDER.indexOf(weekday);
}

function toWeeklyOccurrencePoints(
  schedule: WeeklyScheduleDefinition,
): number[] {
  const timeOffsets = schedule.times.map(toMinuteOfDay);
  return schedule.weekdays.flatMap((weekday) => {
    const weekdayOffset = toWeekdayIndex(weekday) * MINUTES_PER_DAY;
    return timeOffsets.map((timeOffset) => weekdayOffset + timeOffset);
  });
}

function parseCronFieldParts(field: string): string[] {
  return field.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseSingleNumberField(
  field: string,
  args: {
    allowWildcard?: boolean;
    max: number;
    min: number;
  },
): number | null {
  if (args.allowWildcard && field === "*") {
    return null;
  }

  if (!/^\d+$/u.test(field)) {
    throw new ScheduleValidationError("Unsupported cron expression");
  }

  const value = Number(field);
  if (!Number.isInteger(value) || value < args.min || value > args.max) {
    throw new ScheduleValidationError("Unsupported cron expression");
  }

  return value;
}

function parseNumberListField(
  field: string,
  args: {
    max: number;
    min: number;
  },
): number[] {
  const values = parseCronFieldParts(field).map((part) => parseSingleNumberField(part, args) ?? 0);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new ScheduleValidationError("Unsupported cron expression");
  }
  return values.sort(compareNumbers);
}

function parseHourField(field: string): ParsedHourField {
  if (field === "*") {
    return {
      intervalHours: 1,
      kind: "interval",
    };
  }

  const stepMatch = /^\*\/(?<step>\d+)$/u.exec(field);
  if (stepMatch?.groups?.step) {
    const intervalHours = Number(stepMatch.groups.step);
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24) {
      throw new ScheduleValidationError("Unsupported cron expression");
    }
    return {
      intervalHours,
      kind: "interval",
    };
  }

  return {
    hours: parseNumberListField(field, {
      max: 23,
      min: 0,
    }),
    kind: "fixed",
  };
}

function parseWeekdayField(field: string): WeekdayName[] {
  const weekdays = new Set<WeekdayName>();

  for (const part of parseCronFieldParts(field)) {
    const rangeMatch = /^(?<start>\d+)-(?<end>\d+)$/u.exec(part);
    if (rangeMatch?.groups?.start && rangeMatch.groups.end) {
      const start = parseSingleNumberField(rangeMatch.groups.start, { max: 7, min: 0 }) ?? 0;
      const end = parseSingleNumberField(rangeMatch.groups.end, { max: 7, min: 0 }) ?? 0;
      if (start > end) {
        throw new ScheduleValidationError("Unsupported cron expression");
      }
      for (let value = start; value <= end; value += 1) {
        weekdays.add(toWeekdayName(value));
      }
      continue;
    }

    weekdays.add(
      toWeekdayName(parseSingleNumberField(part, { max: 7, min: 0 }) ?? 0),
    );
  }

  return WEEKDAY_ORDER.filter((weekday) => weekdays.has(weekday));
}

function toWeekdayName(value: number): WeekdayName {
  if (value === 0 || value === 7) {
    return "sun";
  }
  const weekday = WEEKDAY_ORDER[value - 1];
  if (!weekday) {
    throw new ScheduleValidationError("Unsupported cron expression");
  }
  return weekday;
}

function buildTimes(
  args: {
    hours: number[];
    minutes: number[];
  },
): string[] {
  return args.hours
    .flatMap((hour) => args.minutes.map((minute) => toTimeOfDayString({
      hour,
      minute,
    })))
    .sort((left, right) => compareNumbers(toMinuteOfDay(left), toMinuteOfDay(right)));
}

function extractRepresentableTimeSets(times: string[]): {
  hours: number[];
  minutes: number[];
} {
  const hours = new Set<number>();
  const minutes = new Set<number>();
  const actualTimes = new Set<string>();

  for (const time of times) {
    const { hour, minute } = parseTimeOfDay(time);
    hours.add(hour);
    minutes.add(minute);
    actualTimes.add(toTimeOfDayString({ hour, minute }));
  }

  const sortedHours = [...hours].sort(compareNumbers);
  const sortedMinutes = [...minutes].sort(compareNumbers);
  const expectedTimes = buildTimes({
    hours: sortedHours,
    minutes: sortedMinutes,
  });

  if (actualTimes.size !== expectedTimes.length) {
    throw new ScheduleValidationError(
      "Stored schedule definition cannot be expressed as a supported cron expression",
    );
  }

  for (const time of expectedTimes) {
    if (!actualTimes.has(time)) {
      throw new ScheduleValidationError(
        "Stored schedule definition cannot be expressed as a supported cron expression",
      );
    }
  }

  return {
    hours: sortedHours,
    minutes: sortedMinutes,
  };
}

function toCronWeekdayField(weekdays: readonly WeekdayName[]): string {
  const cronValues = weekdays
    .map((weekday) => {
      if (weekday === "sun") {
        return 0;
      }
      return toWeekdayIndex(weekday) + 1;
    })
    .sort(compareNumbers);
  return cronValues.join(",");
}

function validateParsedScheduleDefinition(
  schedule: ScheduleDefinition,
): void {
  switch (schedule.kind) {
    case "hourly":
      return;
    case "daily":
      assertMinimumGapWithinSortedPoints({
        cycleLengthMinutes: MINUTES_PER_DAY,
        points: schedule.times.map(toMinuteOfDay),
        wrapAround: true,
      });
      return;
    case "weekly":
      assertMinimumGapWithinSortedPoints({
        cycleLengthMinutes: MINUTES_PER_WEEK,
        points: toWeeklyOccurrencePoints(schedule),
        wrapAround: true,
      });
      return;
    case "monthly":
      assertMinimumGapWithinSortedPoints({
        cycleLengthMinutes: MINUTES_PER_DAY,
        points: schedule.times.map(toMinuteOfDay),
        wrapAround: false,
      });
      return;
    default: {
      const exhaustiveCheck: never = schedule;
      throw new Error(`Unsupported schedule definition: ${exhaustiveCheck}`);
    }
  }
}

export function parseCronScheduleDefinition(
  args: CronScheduleArgs,
): ScheduleDefinition {
  const fields = args.cron.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new ScheduleValidationError("Invalid cron expression");
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;
  if (monthField !== "*") {
    throw new ScheduleValidationError("Unsupported cron expression");
  }

  const minutes = parseNumberListField(minuteField, { max: 59, min: 0 });
  const parsedHourField = parseHourField(hourField);

  if (dayOfMonthField === "*" && dayOfWeekField === "*") {
    if (parsedHourField.kind === "interval") {
      if (minutes.length !== 1) {
        throw new ScheduleValidationError("Unsupported cron expression");
      }
      return {
        intervalHours: parsedHourField.intervalHours,
        kind: "hourly",
        minute: minutes[0]!,
        timezone: args.timezone,
      };
    }

    return {
      kind: "daily",
      times: buildTimes({
        hours: parsedHourField.hours,
        minutes,
      }),
      timezone: args.timezone,
    };
  }

  if (dayOfMonthField === "*" && dayOfWeekField !== "*") {
    if (parsedHourField.kind === "interval") {
      throw new ScheduleValidationError("Unsupported cron expression");
    }
    return {
      kind: "weekly",
      times: buildTimes({
        hours: parsedHourField.hours,
        minutes,
      }),
      timezone: args.timezone,
      weekdays: parseWeekdayField(dayOfWeekField),
    };
  }

  if (dayOfWeekField === "*") {
    if (parsedHourField.kind === "interval") {
      throw new ScheduleValidationError("Unsupported cron expression");
    }
    const dayOfMonth = parseSingleNumberField(dayOfMonthField, { max: 31, min: 1 });
    if (dayOfMonth === null) {
      throw new ScheduleValidationError("Unsupported cron expression");
    }
    return {
      dayOfMonth,
      kind: "monthly",
      times: buildTimes({
        hours: parsedHourField.hours,
        minutes,
      }),
      timezone: args.timezone,
    };
  }

  throw new ScheduleValidationError("Unsupported cron expression");
}

export function serializeScheduleDefinitionAsCron(
  schedule: ScheduleDefinition,
): string {
  switch (schedule.kind) {
    case "hourly": {
      const hourField = schedule.intervalHours === 1 ? "*" : `*/${schedule.intervalHours}`;
      return `${schedule.minute} ${hourField} * * *`;
    }
    case "daily": {
      const { hours, minutes } = extractRepresentableTimeSets(schedule.times);
      return `${minutes.join(",")} ${hours.join(",")} * * *`;
    }
    case "weekly": {
      const { hours, minutes } = extractRepresentableTimeSets(schedule.times);
      return `${minutes.join(",")} ${hours.join(",")} * * ${toCronWeekdayField(schedule.weekdays)}`;
    }
    case "monthly": {
      const { hours, minutes } = extractRepresentableTimeSets(schedule.times);
      return `${minutes.join(",")} ${hours.join(",")} ${schedule.dayOfMonth} * *`;
    }
    default: {
      const exhaustiveCheck: never = schedule;
      throw new Error(`Unsupported schedule definition: ${exhaustiveCheck}`);
    }
  }
}

function parseScheduleExpressionSet(expressionSet: string): string[] {
  return expressionSet
    .split("\n")
    .map((expression) => expression.trim())
    .filter((expression) => expression.length > 0);
}

function computeNextScheduledTimeFromExpressions(
  args: {
    expressions: readonly string[];
    now: number;
    timezone: string;
  },
): number {
  let nextRunAt: number | null = null;

  for (const expression of args.expressions) {
    const candidate = parseExpression({
      cron: expression,
      now: args.now,
      timezone: args.timezone,
    }).next().getTime();
    if (nextRunAt === null || candidate < nextRunAt) {
      nextRunAt = candidate;
    }
  }

  if (nextRunAt === null) {
    throw new ScheduleValidationError("Schedule must include at least one occurrence");
  }

  return nextRunAt;
}

export function validateScheduleDefinition(
  args: CronScheduleArgs,
): void {
  assertValidTimezone(args.timezone);
  validateParsedScheduleDefinition(parseCronScheduleDefinition(args));
}

export function computeNextScheduledTime(
  args: ScheduleAtTimeArgs,
): number {
  validateScheduleDefinition({
    cron: args.cron,
    timezone: args.timezone,
  });
  return parseExpression({
    cron: args.cron,
    now: args.now,
    timezone: args.timezone,
  }).next().getTime();
}

export function computeNextScheduledTimeForExpressionSet(
  args: ScheduleExpressionSetArgs,
): number {
  return computeNextScheduledTimeFromExpressions({
    expressions: parseScheduleExpressionSet(args.expressionSet),
    now: args.now,
    timezone: args.timezone,
  });
}
