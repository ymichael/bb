import { z } from "zod";
import type {
  AccountQuota,
  FamilyQuota,
  FamilyWeekly,
  ModelFamily,
} from "./contracts.js";
import { modelFamily, parseReset } from "./quota.js";

const numberValueSchema = z.union([z.number(), z.string()]);

const usageBucketSchema = z
  .object({
    utilization: numberValueSchema.nullish(),
    used_percentage: numberValueSchema.nullish(),
    usedPercentage: numberValueSchema.nullish(),
    resets_at: z.union([z.number(), z.string()]).nullish(),
    reset_at: z.union([z.number(), z.string()]).nullish(),
    resetAt: z.union([z.number(), z.string()]).nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

const usageLimitSchema = z
  .object({
    kind: z.string().nullish(),
    group: z.string().nullish(),
    percent: numberValueSchema.nullish(),
    resets_at: z.union([z.number(), z.string()]).nullish(),
    status: z.string().nullish(),
    scope: z
      .object({
        model: z
          .object({ display_name: z.string().nullish() })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const usagePayloadSchema = z
  .object({
    five_hour: usageBucketSchema.nullish(),
    seven_day: usageBucketSchema.nullish(),
    seven_day_fable: usageBucketSchema.nullish(),
    seven_day_sonnet: usageBucketSchema.nullish(),
    seven_day_opus: usageBucketSchema.nullish(),
    seven_day_haiku: usageBucketSchema.nullish(),
    limits: z.array(usageLimitSchema).optional(),
  })
  .passthrough();

type UsageBucket = z.infer<typeof usageBucketSchema>;

function percentage(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 100 : null;
}

function normalizeBucket(bucket: UsageBucket, now: number): FamilyQuota | null {
  const utilization = percentage(
    bucket.used_percentage ??
      bucket.utilization ??
      bucket.usedPercentage ??
      null,
  );
  const resetAt = parseReset(
    bucket.resets_at ?? bucket.reset_at ?? bucket.resetAt ?? null,
  );
  if (utilization === null && resetAt === null && bucket.status == null)
    return null;
  return {
    utilization,
    resetAt,
    status:
      bucket.status ??
      (utilization === null ? null : utilization >= 1 ? "rejected" : "allowed"),
    observedAt: now,
    source: "usage",
  };
}

function stronger(
  current: FamilyQuota | null,
  candidate: FamilyQuota | null,
): FamilyQuota | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return (candidate.utilization ?? -1) > (current.utilization ?? -1)
    ? candidate
    : current;
}

function limitBucket(
  percent: string | number | null | undefined,
  reset: string | number | null | undefined,
  status: string | null | undefined,
  now: number,
): FamilyQuota | null {
  return normalizeBucket(
    {
      utilization: percent,
      resets_at: reset,
      status,
    },
    now,
  );
}

export function quotaFromUsage(
  accountId: string,
  payload: object,
  previous: AccountQuota,
  now: number,
): AccountQuota | null {
  const parsed = usagePayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (
    data.five_hour == null &&
    data.seven_day == null &&
    data.seven_day_fable == null &&
    data.seven_day_sonnet == null &&
    data.seven_day_opus == null &&
    data.seven_day_haiku == null &&
    data.limits === undefined
  )
    return null;
  const familyWeekly: FamilyWeekly =
    data.limits === undefined
      ? { ...previous.familyWeekly }
      : {
          fable: null,
          sonnet: null,
          opus: null,
          haiku: null,
          other: null,
        };
  for (const limit of data.limits ?? []) {
    if (
      limit.kind !== "weekly_scoped" &&
      !(limit.group === "weekly" && limit.scope?.model?.display_name != null)
    )
      continue;
    const displayName = limit.scope?.model?.display_name;
    if (displayName == null) continue;
    const family = modelFamily(displayName);
    familyWeekly[family] = stronger(
      familyWeekly[family],
      limitBucket(limit.percent, limit.resets_at, limit.status, now),
    );
  }
  const slots: Array<[ModelFamily, UsageBucket | null | undefined]> = [
    ["fable", data.seven_day_fable],
    ["sonnet", data.seven_day_sonnet],
    ["opus", data.seven_day_opus],
    ["haiku", data.seven_day_haiku],
  ];
  for (const [family, bucket] of slots) {
    if (bucket == null) continue;
    const normalized = normalizeBucket(bucket, now);
    if (normalized !== null) familyWeekly[family] = normalized;
  }
  const fiveHour =
    data.five_hour == null ? null : normalizeBucket(data.five_hour, now);
  const sevenDay =
    data.seven_day == null ? null : normalizeBucket(data.seven_day, now);
  return {
    ...previous,
    accountId,
    fiveHourUtilization: fiveHour?.utilization ?? previous.fiveHourUtilization,
    fiveHourResetAt: fiveHour?.resetAt ?? previous.fiveHourResetAt,
    fiveHourStatus: fiveHour?.status ?? previous.fiveHourStatus,
    sevenDayUtilization: sevenDay?.utilization ?? previous.sevenDayUtilization,
    sevenDayResetAt: sevenDay?.resetAt ?? previous.sevenDayResetAt,
    sevenDayStatus: sevenDay?.status ?? previous.sevenDayStatus,
    familyWeekly,
    observedAt: now,
  };
}
