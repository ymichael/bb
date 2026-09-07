import { toString as cronstrueToString } from "cronstrue";
import type { AutomationTrigger } from "../src/rpc-types";

const SCHEDULE_RUN_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

interface FormatScheduleStatusLabelArgs {
  enabled: boolean;
  nextRunAt: number | null;
  trigger?: AutomationTrigger;
  runCount?: number;
  lastRunStatus?: "running" | "succeeded" | "failed" | "skipped" | null;
  now?: number;
}

interface OverviewScheduleMetadata {
  isNextRun: boolean;
  text: string;
}

export type AutomationStatusFilter = "active" | "paused";

interface OneShotLifecycleArgs {
  enabled: boolean;
  trigger: AutomationTrigger;
  runCount: number;
  lastRunStatus: "running" | "succeeded" | "failed" | "skipped" | null;
  now?: number;
}

type OneShotLifecycle =
  | "scheduled"
  | "paused"
  | "expired"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

const DAY_ABBREVIATION: Record<string, string> = {
  Sunday: "Sun",
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
};

function formatCronCadence(cron: string): string {
  let text: string;
  try {
    text = cronstrueToString(cron, { verbose: false });
  } catch {
    return "Custom schedule";
  }
  return text
    .replace(/^At /, "")
    .replace(
      /\b0?(\d{1,2}):(\d{2})\s*(AM|PM)\b/g,
      (_all, hour, minute, meridiem) =>
        minute === "00" ? `${hour}${meridiem}` : `${hour}:${minute}${meridiem}`,
    )
    .replace(
      /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/g,
      (day) => DAY_ABBREVIATION[day] ?? day,
    )
    .replace(/ through /g, "-")
    .replace(/,? only on /g, " ")
    .replace(/,? and /g, ", ")
    .replace(/\bminutes?\b/g, "min")
    .replace(/\bseconds?\b/g, "sec")
    .replace(/([AP]M),\s+/g, "$1 ")
    .trim();
}

export function formatAutomationTrigger(trigger: AutomationTrigger): string {
  if (trigger.triggerType === "once") {
    return "One time";
  }
  return formatCronCadence(trigger.cron);
}

export function getOneShotLifecycle({
  enabled,
  trigger,
  runCount,
  lastRunStatus,
  now = Date.now(),
}: OneShotLifecycleArgs): OneShotLifecycle | null {
  if (trigger.triggerType !== "once") return null;
  if (enabled) return "scheduled";
  if (runCount > 0) {
    if (lastRunStatus === "running") return "running";
    if (lastRunStatus === "failed") return "failed";
    if (lastRunStatus === "skipped") return "skipped";
    return "completed";
  }
  return trigger.runAt <= now ? "expired" : "paused";
}

export function oneShotLifecycleAllowsToggle(
  lifecycle: OneShotLifecycle | null,
): boolean {
  return (
    lifecycle === null || lifecycle === "scheduled" || lifecycle === "paused"
  );
}

export function formatScheduleRunTime(timestamp: number): string {
  return SCHEDULE_RUN_FORMATTER.format(new Date(timestamp));
}

export function formatScheduleStatusLabel({
  enabled,
  nextRunAt,
  trigger,
  runCount = 0,
  lastRunStatus = null,
  now = Date.now(),
}: FormatScheduleStatusLabelArgs): string {
  if (trigger !== undefined) {
    const oneShotLifecycle = getOneShotLifecycle({
      enabled,
      trigger,
      runCount,
      lastRunStatus,
      now,
    });
    if (oneShotLifecycle === "running") return "Running";
    if (oneShotLifecycle === "failed") return "Failed";
    if (oneShotLifecycle === "skipped") return "Skipped";
    if (oneShotLifecycle === "completed") return "Completed";
    if (oneShotLifecycle === "expired") return "Expired — edit to reschedule";
  }
  if (!enabled) {
    return "Paused";
  }
  if (nextRunAt === null) {
    return "Not scheduled";
  }
  return `Next ${formatScheduleRunTime(nextRunAt)}`;
}

export function formatOverviewScheduleMetadata(
  args: FormatScheduleStatusLabelArgs,
): OverviewScheduleMetadata | null {
  const label = formatScheduleStatusLabel(args);
  if (
    label === "Failed" ||
    label === "Paused" ||
    label === "Completed" ||
    label === "Expired — edit to reschedule"
  ) {
    return null;
  }
  if (label.startsWith("Next ")) {
    return { isNextRun: true, text: label.slice("Next ".length) };
  }
  return { isNextRun: false, text: label };
}

export function formatDetailScheduleStatusLabel(
  args: FormatScheduleStatusLabelArgs,
): string | null {
  const label = formatScheduleStatusLabel(args);
  return label === "Paused" || label === "Completed" ? null : label;
}

export function matchesAutomationStatusFilters(
  automation: FormatScheduleStatusLabelArgs,
  filters: readonly AutomationStatusFilter[],
): boolean {
  if (filters.length === 0) return true;
  if (automation.enabled) return filters.includes("active");
  if (automation.trigger?.triggerType !== "once") {
    return filters.includes("paused");
  }
  const lifecycle = getOneShotLifecycle({
    enabled: automation.enabled,
    trigger: automation.trigger,
    runCount: automation.runCount ?? 0,
    lastRunStatus: automation.lastRunStatus ?? null,
    now: automation.now,
  });
  if (lifecycle === "running") return filters.includes("active");
  if (lifecycle === "paused" || lifecycle === "completed") {
    return filters.includes("paused");
  }
  return false;
}
