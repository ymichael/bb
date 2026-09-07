interface FormatRelativeTimeArgs {
  timestamp: number;
  now: number;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function formatRelativeTime({
  timestamp,
  now,
}: FormatRelativeTimeArgs): string {
  const diffMs = now - timestamp;
  if (diffMs < MINUTE_MS) {
    return "just now";
  }
  if (diffMs < HOUR_MS) {
    return `${Math.floor(diffMs / MINUTE_MS)}m ago`;
  }
  if (diffMs < DAY_MS) {
    return `${Math.floor(diffMs / HOUR_MS)}h ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  if (days === 1) {
    return "Yesterday";
  }
  if (diffMs < WEEK_MS) {
    return `${days}d ago`;
  }
  if (diffMs < 5 * WEEK_MS) {
    return `${Math.floor(diffMs / WEEK_MS)}w ago`;
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

interface FormatScheduledTimeArgs {
  timestamp: number;
  now: number;
}

export function formatScheduledTime({
  timestamp,
  now,
}: FormatScheduledTimeArgs): string {
  const target = new Date(timestamp);
  const clock = target.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const daysAhead = Math.floor(
    (target.getTime() - startOfToday.getTime()) / DAY_MS,
  );
  if (daysAhead === 0) {
    return clock;
  }
  if (daysAhead === 1) {
    return `Tomorrow ${clock}`;
  }
  const date = target.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date} ${clock}`;
}
