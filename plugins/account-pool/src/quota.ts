import type {
  Account,
  AccountQuota,
  AccountSummary,
  FamilyQuota,
  LimitWindow,
  ModelFamily,
} from "./contracts.js";

const PREFIX = "anthropic-ratelimit-unified-";
const SCOPED_HEADER =
  /^anthropic-ratelimit-unified-7d_(.+)-(utilization|reset|status)$/u;

interface ScopedHeaderValues {
  utilization: number | null;
  resetAt: number | null;
  status: string | null;
}

function parseNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseReset(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 1_000_000_000_000
      ? Math.round(value * 1_000)
      : Math.round(value);
  }
  if (value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000
      ? Math.round(numeric * 1_000)
      : Math.round(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function modelFamily(model: string | null): ModelFamily {
  if (model === null) return "other";
  const normalized = model.toLowerCase();
  if (normalized.includes("fable")) return "fable";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  return "other";
}

function scopedHeaderValues(headers: Headers): ScopedHeaderValues | null {
  const buckets = new Map<string, ScopedHeaderValues>();
  for (const [name, value] of headers) {
    const match = SCOPED_HEADER.exec(name.toLowerCase());
    const bucket = match?.[1];
    const field = match?.[2];
    if (bucket === undefined || field === undefined) continue;
    const current = buckets.get(bucket) ?? {
      utilization: null,
      resetAt: null,
      status: null,
    };
    if (field === "utilization") current.utilization = parseNumber(value);
    if (field === "reset") current.resetAt = parseReset(value);
    if (field === "status") current.status = value;
    buckets.set(bucket, current);
  }
  return [...buckets.values()][0] ?? null;
}

export function quotaFromHeaders(
  accountId: string,
  headers: Headers,
  previous: AccountQuota,
  family: ModelFamily,
  now: number,
): AccountQuota {
  const fiveHourUtilization = parseNumber(
    headers.get(`${PREFIX}5h-utilization`),
  );
  const fiveHourResetAt = parseReset(headers.get(`${PREFIX}5h-reset`));
  const fiveHourStatus = headers.get(`${PREFIX}5h-status`);
  const sevenDayUtilization = parseNumber(
    headers.get(`${PREFIX}7d-utilization`),
  );
  const sevenDayResetAt = parseReset(headers.get(`${PREFIX}7d-reset`));
  const sevenDayStatus = headers.get(`${PREFIX}7d-status`);
  const representativeClaim = headers.get(`${PREFIX}representative-claim`);
  const scoped = scopedHeaderValues(headers);
  const priorFamily = previous.familyWeekly[family];
  const familyWeekly: AccountQuota["familyWeekly"] =
    scoped === null
      ? previous.familyWeekly
      : {
          ...previous.familyWeekly,
          [family]: {
            utilization: scoped.utilization ?? priorFamily?.utilization ?? null,
            resetAt: scoped.resetAt ?? priorFamily?.resetAt ?? null,
            status: scoped.status ?? priorFamily?.status ?? null,
            observedAt: now,
            source: "header",
          },
        };
  const observed =
    fiveHourUtilization !== null ||
    fiveHourResetAt !== null ||
    fiveHourStatus !== null ||
    sevenDayUtilization !== null ||
    sevenDayResetAt !== null ||
    sevenDayStatus !== null ||
    representativeClaim !== null ||
    scoped !== null;
  return {
    accountId,
    fiveHourUtilization: fiveHourUtilization ?? previous.fiveHourUtilization,
    fiveHourResetAt: fiveHourResetAt ?? previous.fiveHourResetAt,
    fiveHourStatus: fiveHourStatus ?? previous.fiveHourStatus,
    sevenDayUtilization: sevenDayUtilization ?? previous.sevenDayUtilization,
    sevenDayResetAt: sevenDayResetAt ?? previous.sevenDayResetAt,
    sevenDayStatus: sevenDayStatus ?? previous.sevenDayStatus,
    representativeClaim: representativeClaim ?? previous.representativeClaim,
    familyWeekly,
    limitWindows: previous.limitWindows,
    observedAt: observed ? now : previous.observedAt,
    heldUntil: previous.heldUntil,
    error: previous.error,
  };
}

function activeWindow(
  utilization: number | null,
  status: string | null,
  resetAt: number | null,
  threshold: number,
  now: number,
): boolean {
  if (resetAt !== null && resetAt <= now) return false;
  return (
    status?.toLowerCase() === "rejected" ||
    (utilization !== null && utilization >= threshold)
  );
}

function activeFamilyWindow(
  quota: FamilyQuota | null,
  threshold: number,
  now: number,
): boolean {
  return (
    quota !== null &&
    activeWindow(quota.utilization, quota.status, quota.resetAt, threshold, now)
  );
}

export function isSharedQuotaExhausted(
  quota: AccountQuota,
  threshold: number,
  now: number,
): boolean {
  return (
    activeWindow(
      quota.fiveHourUtilization,
      quota.fiveHourStatus,
      quota.fiveHourResetAt,
      threshold,
      now,
    ) ||
    activeWindow(
      quota.sevenDayUtilization,
      quota.sevenDayStatus,
      quota.sevenDayResetAt,
      threshold,
      now,
    ) ||
    quota.limitWindows.some((window) =>
      activeWindow(
        window.utilization,
        window.status,
        window.resetAt,
        threshold,
        now,
      ),
    )
  );
}

export const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export function longestLimitWindow(
  windows: readonly LimitWindow[],
): LimitWindow | null {
  let longest: LimitWindow | null = null;
  for (const window of windows) {
    if (
      longest === null ||
      (window.windowMinutes ?? 0) > (longest.windowMinutes ?? 0)
    )
      longest = window;
  }
  return longest;
}

export function isQuotaExhausted(
  quota: AccountQuota,
  family: ModelFamily,
  threshold: number,
  now: number,
): boolean {
  return (
    isSharedQuotaExhausted(quota, threshold, now) ||
    activeFamilyWindow(quota.familyWeekly[family], threshold, now)
  );
}

export function isQuotaRejection(headers: Headers): boolean {
  for (const [name, value] of headers) {
    if (value.toLowerCase() !== "rejected") continue;
    const normalized = name.toLowerCase();
    if (
      normalized === `${PREFIX}5h-status` ||
      normalized === `${PREFIX}7d-status` ||
      SCOPED_HEADER.test(normalized)
    )
      return true;
  }
  return false;
}

export function governingWeeklyResetAt(
  quota: AccountQuota,
  family: ModelFamily,
): number | null {
  return (
    quota.familyWeekly[family]?.resetAt ??
    quota.sevenDayResetAt ??
    longestLimitWindow(quota.limitWindows)?.resetAt ??
    null
  );
}

export function accountStatus(
  account: Account,
  quota: AccountQuota,
  threshold: number,
  now: number,
): AccountSummary["status"] {
  if (!account.enabled) return "disabled";
  if (quota.error !== null) return "error";
  if (quota.heldUntil !== null && quota.heldUntil > now) return "held";
  if (isSharedQuotaExhausted(quota, threshold, now)) return "exhausted";
  return "ready";
}

export function retryAfterMilliseconds(
  value: string | null,
  now: number,
): number {
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1_000 : Math.max(0, date - now);
}
