/**
 * `--send-at` accepts the two things a person actually types: a relative
 * duration ("in ten minutes") or a wall-clock timestamp ("at 9am tomorrow").
 * Both resolve to the epoch-ms `sendAt` the create/send routes take.
 */

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;

/**
 * A date alone, which we reject rather than guess at: `Date.parse` reads it as
 * UTC midnight while the user meant midnight where they are, and a scheduled
 * send that lands hours off is worse than an error.
 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO 8601 date-time. A space is accepted in place of `T` because shells and
 * humans both produce it; without an offset the timestamp is local time, which
 * is what `Date.parse` does for this form.
 */
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/;

export const SEND_AT_HELP =
  "Dispatch at an ISO 8601 timestamp (2026-08-25T09:00) or a duration from now (30s, 10m, 2h, 7d)";

function formatInvalid(value: string, detail: string): Error {
  return new Error(
    `Invalid --send-at value '${value}'. ${detail} Expected an ISO 8601 timestamp such as 2026-08-25T09:00 or a duration such as 30s, 10m, 2h, or 7d.`,
  );
}

/**
 * Resolves `--send-at` to epoch ms. `now` is injectable so the caller (and
 * the tests) can pin the clock a duration is measured from.
 */
export function parseSendAt(value: string, now = Date.now()): number {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw formatInvalid(value, "It is empty.");
  }

  const duration = DURATION_PATTERN.exec(trimmed.toLowerCase());
  if (duration) {
    const amount = Number.parseFloat(duration[1]);
    const resolved = Math.round(now + amount * DURATION_UNIT_MS[duration[2]]);
    if (resolved <= now) {
      throw new Error(
        `--send-at must be in the future; '${value}' is zero time from now.`,
      );
    }
    return resolved;
  }

  if (DATE_ONLY_PATTERN.test(trimmed)) {
    throw formatInvalid(
      value,
      "A date alone has no time of day, and the time zone it means is ambiguous.",
    );
  }

  if (!ISO_PATTERN.test(trimmed)) {
    throw formatInvalid(value, "It is neither a timestamp nor a duration.");
  }

  const resolved = Date.parse(trimmed.replace(" ", "T"));
  if (!Number.isFinite(resolved)) {
    throw formatInvalid(value, "It is not a real date.");
  }
  if (resolved <= now) {
    throw new Error(
      `--send-at must be in the future; '${value}' resolves to ${new Date(resolved).toLocaleString()}, which has already passed.`,
    );
  }
  return resolved;
}

/**
 * Countdown for the `Send at` column. A row with no `sendAt` is waiting on
 * something other than a clock, and a row whose instant has passed is waiting
 * on the sweep, so both say so instead of printing a negative duration.
 */
export function formatQueueSendCountdown(
  sendAt: number | null,
  now = Date.now(),
): string {
  if (sendAt === null) return "-";
  const remainingMs = sendAt - now;
  if (remainingMs <= 0) return "due";
  return `in ${formatApproximateDuration(remainingMs)}`;
}

function formatApproximateDuration(ms: number): string {
  if (ms < DURATION_UNIT_MS.m)
    return `${Math.max(1, Math.round(ms / DURATION_UNIT_MS.s))}s`;
  if (ms < DURATION_UNIT_MS.h) return `${Math.floor(ms / DURATION_UNIT_MS.m)}m`;
  if (ms < DURATION_UNIT_MS.d) return `${Math.floor(ms / DURATION_UNIT_MS.h)}h`;
  return `${Math.floor(ms / DURATION_UNIT_MS.d)}d`;
}
