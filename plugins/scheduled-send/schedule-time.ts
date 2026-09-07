/**
 * Time choices for "Send later…". Presets resolve from the current clock,
 * while custom schedules use explicit local date and time fields so the user
 * can see exactly what will happen before confirming.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** Guard against a typo turning a scheduled message into a lost message. */
export const MAX_SCHEDULE_AHEAD_MS = 365 * DAY_MS;

export type SchedulePresetId =
  | "in-30-minutes"
  | "in-1-hour"
  | "in-2-hours"
  | "this-evening"
  | "tomorrow-morning";

export const DEFAULT_SCHEDULE_PRESET_ID: SchedulePresetId = "in-1-hour";

export interface SchedulePreset {
  id: SchedulePresetId;
  label: string;
  /** Epoch ms. */
  at: number;
}

/** Narrows the value emitted by a select control to a known preset. */
export function isSchedulePresetId(value: string): value is SchedulePresetId {
  switch (value) {
    case "in-30-minutes":
    case "in-1-hour":
    case "in-2-hours":
    case "this-evening":
    case "tomorrow-morning":
      return true;
    default:
      return false;
  }
}

/**
 * Quick choices, filtered to those still ahead. At 8pm there is no "this
 * evening" left to offer.
 */
export function listSchedulePresets(now: number): SchedulePreset[] {
  const candidates: SchedulePreset[] = [
    {
      id: "in-30-minutes",
      label: "In 30 minutes",
      at: now + 30 * MINUTE_MS,
    },
    { id: "in-1-hour", label: "In 1 hour", at: now + HOUR_MS },
    { id: "in-2-hours", label: "In 2 hours", at: now + 2 * HOUR_MS },
    {
      id: "this-evening",
      label: "This evening",
      at: atLocalTime(now, 0, EVENING_HOUR, 0),
    },
    {
      id: "tomorrow-morning",
      label: "Tomorrow morning",
      at: atLocalTime(now, 1, MORNING_HOUR, 0),
    },
  ];
  return candidates.filter((preset) => preset.at > now);
}

/** Local wall-clock time `dayOffset` days from `now`, as epoch ms. */
function atLocalTime(
  now: number,
  dayOffset: number,
  hour: number,
  minute: number,
): number {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

export type ScheduleTimeParse =
  | { ok: true; at: number }
  | { ok: false; message: string };

export interface CustomScheduleFields {
  date: string;
  time: string;
}

/** Fresh defaults for the custom branch each time the dialog opens. */
export function defaultCustomSchedule(now: number): CustomScheduleFields {
  return {
    date: formatDateInputValue(atLocalTime(now, 1, MORNING_HOUR, 0)),
    time: "09:00",
  };
}

/** Formats a local date for an `<input type="date">`. */
export function formatDateInputValue(at: number): string {
  const date = new Date(at);
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_INPUT_PATTERN = /^(\d{2}):(\d{2})$/;

/** Parses the native date/time controls as one local wall-clock timestamp. */
export function parseCustomScheduleTime(
  fields: CustomScheduleFields,
  now: number,
): ScheduleTimeParse {
  const dateMatch = DATE_INPUT_PATTERN.exec(fields.date);
  if (dateMatch === null) return { ok: false, message: "Choose a date." };

  const timeMatch = TIME_INPUT_PATTERN.exec(fields.time);
  if (timeMatch === null) return { ok: false, message: "Choose a time." };

  const year = Number.parseInt(dateMatch[1], 10);
  const month = Number.parseInt(dateMatch[2], 10);
  const day = Number.parseInt(dateMatch[3], 10);
  const hour = Number.parseInt(timeMatch[1], 10);
  const minute = Number.parseInt(timeMatch[2], 10);
  const scheduled = new Date(year, month - 1, day, hour, minute, 0, 0);

  if (
    scheduled.getFullYear() !== year ||
    scheduled.getMonth() !== month - 1 ||
    scheduled.getDate() !== day ||
    scheduled.getHours() !== hour ||
    scheduled.getMinutes() !== minute
  ) {
    return { ok: false, message: "Choose a real date and time." };
  }

  const at = scheduled.getTime();
  if (at <= now) return { ok: false, message: "Choose a future time." };
  if (at > now + MAX_SCHEDULE_AHEAD_MS) {
    return { ok: false, message: "Pick a time within the next year." };
  }
  return { ok: true, at };
}

/**
 * Names the chosen time back to the user. Today and tomorrow are said in words
 * because that is how quick choices are framed; later dates stay explicit.
 */
export function formatScheduleTime(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const days = calendarDaysBetween(now, at);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  const date = new Date(at).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year:
      new Date(at).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : "numeric",
  });
  return `${date} at ${time}`;
}

/** Browser-local timezone read-back for the confirmation summary. */
export function formatScheduleTimeZone(at: number): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZoneName = new Intl.DateTimeFormat(undefined, {
    timeZoneName: "short",
  })
    .formatToParts(new Date(at))
    .find((part) => part.type === "timeZoneName")?.value;
  return timeZoneName === undefined || timeZoneName === timeZone
    ? `Local time · ${timeZone}`
    : `Local time · ${timeZone} (${timeZoneName})`;
}

/** Whole local calendar days from `now`'s day to `at`'s day. */
function calendarDaysBetween(now: number, at: number): number {
  const startOfNow = new Date(now);
  startOfNow.setHours(0, 0, 0, 0);
  const startOfAt = new Date(at);
  startOfAt.setHours(0, 0, 0, 0);
  return Math.round((startOfAt.getTime() - startOfNow.getTime()) / DAY_MS);
}
